//! The cloud CLIs behind CLI connections: `gcloud` (Google Cloud), `az`
//! (Azure) and `doctl` (DigitalOcean), and the credential plugins of the
//! clusters added through them (`gke-gcloud-auth-plugin`, `kubelogin`).
//!
//! - Runs are never interactive: stdin closed, prompts disabled through
//!   each CLI's environment, a timeout, no console window, the whole process
//!   tree killed on timeout, and a run that prints a sign-in prompt is
//!   stopped (`SignInRequired`). `which` finds `gcloud.cmd` / `az.cmd` on
//!   Windows.
//! - `cloud_cli_status` tells whether a CLI is installed and signed in
//!   (cached briefly for the connection list); `cloud_cli_sign_in` streams
//!   `gcloud auth login` / `az login --use-device-code` as a sign-in session.
//! - JET Pilot never changes the CLIs' configuration (`~/.config/gcloud`,
//!   `~/.azure`, doctl's config): only their own sign-in commands write
//!   there.

use std::collections::HashMap;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use once_cell::sync::Lazy;
use serde::Serialize;
use serde_json::Value;
use tauri::ipc::Channel;

use super::{AZURE, DIGITALOCEAN, GCP};
use crate::auth::broker::{self, LineVerdict, RunError, RunOptions, StdoutMode, StreamKind};
use crate::auth::login::{self, LoginEvent, LoginSink, SignInPlan};
use crate::clusters::error::AppError;
use crate::util::lock;

/// Listing output can be large (`az aks list` is verbose).
const MAX_STDOUT: usize = 32 * 1024 * 1024;
/// Status checks (`gcloud auth list`, `az account list`, ...).
pub const STATUS_TIMEOUT: Duration = Duration::from_secs(20);
/// Listings and credential exports.
pub const LIST_TIMEOUT: Duration = Duration::from_secs(90);
/// How long `connections_list` reuses a CLI status.
pub const STATUS_MAX_AGE: Duration = Duration::from_secs(60);

pub const GKE_PLUGIN: &str = "gke-gcloud-auth-plugin";
pub const KUBELOGIN: &str = "kubelogin";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum CliTool {
    Gcloud,
    Az,
    Doctl,
}

impl CliTool {
    pub fn for_provider(provider: &str) -> Option<CliTool> {
        match provider {
            GCP => Some(CliTool::Gcloud),
            AZURE => Some(CliTool::Az),
            DIGITALOCEAN => Some(CliTool::Doctl),
            _ => None,
        }
    }

    pub fn binary(self) -> &'static str {
        match self {
            CliTool::Gcloud => "gcloud",
            CliTool::Az => "az",
            CliTool::Doctl => "doctl",
        }
    }

    pub fn install_url(self) -> &'static str {
        match self {
            CliTool::Gcloud => "https://cloud.google.com/sdk/docs/install",
            CliTool::Az => "https://learn.microsoft.com/cli/azure/install-azure-cli",
            CliTool::Doctl => "https://docs.digitalocean.com/reference/doctl/how-to/install/",
        }
    }

    /// How to sign in, for messages.
    pub fn sign_in_hint(self) -> &'static str {
        match self {
            CliTool::Gcloud => "Sign in with gcloud (gcloud auth login)",
            CliTool::Az => "Sign in with the Azure CLI (az login)",
            CliTool::Doctl => "Sign in with doctl (doctl auth init)",
        }
    }

    /// Environment that keeps the CLI from prompting.
    fn env(self) -> &'static [(&'static str, &'static str)] {
        match self {
            CliTool::Gcloud => &[
                ("CLOUDSDK_CORE_DISABLE_PROMPTS", "1"),
                ("CLOUDSDK_CORE_DISABLE_USAGE_REPORTING", "true"),
            ],
            CliTool::Az => &[
                ("AZURE_CORE_NO_COLOR", "1"),
                ("AZURE_CORE_COLLECT_TELEMETRY", "no"),
                ("AZURE_CORE_SURVEY_MESSAGE", "no"),
                ("AZURE_EXTENSION_USE_DYNAMIC_INSTALL", "no"),
                ("AZURE_CORE_LOGIN_EXPERIENCE_V2", "off"),
            ],
            CliTool::Doctl => &[],
        }
    }

    /// Whether a failure means the CLI needs a sign-in.
    fn needs_sign_in(self, stderr: &str) -> bool {
        let lower = stderr.to_ascii_lowercase();
        let patterns: &[&str] = match self {
            CliTool::Gcloud => &[
                "gcloud auth login",
                "do not currently have an active account",
                "reauthentication",
                "invalid_grant",
                "problem refreshing your current auth tokens",
            ],
            CliTool::Az => &["az login", "aadsts", "interactive authentication is needed"],
            CliTool::Doctl => &[
                "doctl auth init",
                "access token is required",
                "unable to authenticate you",
            ],
        };
        patterns.iter().any(|p| lower.contains(p))
    }
}

/* ---------------------------------------------------------- finding */

/// Test overrides: the `PATH` the CLIs are found on (and run with), and
/// JET Pilot's managed `bin/`.
#[cfg(test)]
#[derive(Clone, Default)]
pub(crate) struct TestEnv {
    pub path: Option<OsString>,
    pub managed_bin: Option<PathBuf>,
}

#[cfg(test)]
static TEST_ENV: Mutex<Option<TestEnv>> = Mutex::new(None);

#[cfg(test)]
pub(crate) fn use_test_env(env: Option<TestEnv>) {
    *lock(&TEST_ENV) = env;
    lock(&STATUSES).clear();
}

fn search_path() -> Option<OsString> {
    #[cfg(test)]
    if let Some(env) = lock(&TEST_ENV).clone() {
        return env.path;
    }
    None
}

fn managed_bin() -> PathBuf {
    #[cfg(test)]
    if let Some(dir) = lock(&TEST_ENV).clone().and_then(|env| env.managed_bin) {
        return dir;
    }
    crate::paths::managed_bin_dir()
}

/// A program on `PATH` (with `PATHEXT` on Windows: `gcloud.cmd`).
pub(crate) fn find(binary: &str) -> Option<PathBuf> {
    match search_path() {
        Some(path) => {
            let cwd = std::env::current_dir().unwrap_or_else(|_| std::env::temp_dir());
            which::which_in(binary, Some(path), cwd).ok()
        }
        None => which::which(binary).ok(),
    }
}

/// `gke-gcloud-auth-plugin`: on `PATH`, else next to gcloud (it ships in
/// the SDK's `bin/`).
pub(crate) fn gke_plugin_path() -> Option<PathBuf> {
    find(GKE_PLUGIN).or_else(|| {
        let gcloud = find("gcloud")?;
        let real = gcloud.canonicalize().unwrap_or(gcloud);
        let candidate = real
            .parent()?
            .join(format!("{GKE_PLUGIN}{}", std::env::consts::EXE_SUFFIX));
        candidate.is_file().then_some(candidate)
    })
}

/// Azure kubelogin: the one JET Pilot installed, else on `PATH`. The flag
/// tells whether it is the managed one.
pub(crate) fn kubelogin_path() -> Option<(PathBuf, bool)> {
    let bin = managed_bin();
    let managed = bin.join(format!("{KUBELOGIN}{}", std::env::consts::EXE_SUFFIX));
    if managed.is_file() {
        return Some((managed, true));
    }
    find(KUBELOGIN).map(|path| {
        let is_managed = path.parent() == Some(bin.as_path());
        (path, is_managed)
    })
}

/* ---------------------------------------------------------- running */

#[derive(Debug, Clone, PartialEq)]
pub enum CliError {
    /// The CLI is not installed.
    Missing(String),
    /// The CLI needs a sign-in (message from its output, redacted).
    SignInRequired(String),
    Timeout(String),
    Failed(String),
}

impl CliError {
    pub fn message(&self) -> String {
        match self {
            CliError::Missing(m)
            | CliError::SignInRequired(m)
            | CliError::Timeout(m)
            | CliError::Failed(m) => m.clone(),
        }
    }

    pub fn needs_sign_in(&self) -> bool {
        matches!(self, CliError::SignInRequired(_))
    }
}

impl From<CliError> for AppError {
    fn from(error: CliError) -> AppError {
        match error {
            CliError::Missing(m) => AppError::not_found(m),
            CliError::SignInRequired(m) => {
                AppError::new(crate::clusters::error::AppErrorCode::SignInRequired, m)
            }
            CliError::Timeout(m) | CliError::Failed(m) => {
                AppError::new(crate::clusters::error::AppErrorCode::Provider, m)
            }
        }
    }
}

/// The last meaningful line of stderr, redacted.
fn detail(stderr: &str) -> String {
    let line = stderr
        .lines()
        .map(str::trim)
        .rfind(|l| !l.is_empty() && !l.to_ascii_lowercase().starts_with("warning"))
        .or_else(|| stderr.lines().map(str::trim).rfind(|l| !l.is_empty()))
        .unwrap_or_default();
    let line: String = line.chars().take(400).collect();
    crate::auth::center::redact(&line)
}

/// Runs `program` non-interactively and returns its stdout.
pub(crate) async fn run_program(
    program: &Path,
    shown: &str,
    tool: Option<CliTool>,
    args: &[String],
    env: &[(String, String)],
    timeout: Duration,
) -> Result<String, CliError> {
    let mut cmd = broker::spawnable(program);
    cmd.args(args);
    if let Some(tool) = tool {
        for (name, value) in tool.env() {
            cmd.env(name, value);
        }
    }
    for (name, value) in env {
        cmd.env(name, value);
    }
    if let Some(path) = search_path() {
        cmd.env("PATH", path);
    }
    let mut on_line = |_: StreamKind, line: &str| {
        if crate::auth::center::looks_interactive(line) {
            LineVerdict::Abort
        } else {
            LineVerdict::Continue
        }
    };
    let run = broker::run_process(
        cmd,
        RunOptions {
            timeout,
            stdout: StdoutMode::CaptureUpTo(MAX_STDOUT),
            on_line: &mut on_line,
            cancel: None,
            pid: None,
        },
    )
    .await;
    match run {
        Ok(run) if run.status.success() => Ok(String::from_utf8_lossy(&run.stdout).into_owned()),
        Ok(run) => {
            let detail = detail(&run.stderr_tail);
            let message = if detail.is_empty() {
                format!("{shown} failed ({})", run.status)
            } else {
                format!("{shown} failed: {detail}")
            };
            if tool.is_some_and(|t| t.needs_sign_in(&run.stderr_tail)) {
                Err(CliError::SignInRequired(message))
            } else {
                Err(CliError::Failed(message))
            }
        }
        Err(RunError::NotFound) => Err(CliError::Missing(format!(
            "{shown} is not installed or not on PATH"
        ))),
        Err(RunError::Timeout) => Err(CliError::Timeout(format!(
            "{shown} did not finish within {} seconds",
            timeout.as_secs()
        ))),
        Err(RunError::Aborted(line)) => Err(CliError::SignInRequired(format!(
            "{shown} asked for a sign-in: {}",
            crate::auth::center::redact(line.trim())
        ))),
        Err(RunError::StdoutTooLarge) => Err(CliError::Failed(format!(
            "{shown} printed more than {} MiB",
            MAX_STDOUT / (1024 * 1024)
        ))),
        Err(RunError::Cancelled) => Err(CliError::Failed(format!("{shown} was cancelled"))),
        Err(RunError::Start(message)) => Err(CliError::Failed(format!(
            "{shown} could not be started: {message}"
        ))),
    }
}

/// Runs a CLI (found on `PATH`) and returns its stdout.
pub(crate) async fn run(
    tool: CliTool,
    args: &[String],
    timeout: Duration,
) -> Result<String, CliError> {
    let program = find(tool.binary()).ok_or_else(|| {
        CliError::Missing(format!(
            "{} is not installed. Install it from {}.",
            tool.binary(),
            tool.install_url()
        ))
    })?;
    let shown = format!(
        "{} {}",
        tool.binary(),
        args.iter()
            .take_while(|a| !a.starts_with('-'))
            .cloned()
            .collect::<Vec<_>>()
            .join(" ")
    );
    run_program(&program, shown.trim(), Some(tool), args, &[], timeout).await
}

/// [`run`] and parse stdout as JSON (warnings around it are skipped).
pub(crate) async fn run_json(
    tool: CliTool,
    args: &[String],
    timeout: Duration,
) -> Result<Value, CliError> {
    let stdout = run(tool, args, timeout).await?;
    parse_json(&stdout).ok_or_else(|| {
        CliError::Failed(format!(
            "{} printed something that isn't JSON",
            tool.binary()
        ))
    })
}

/// The first JSON value (array or object) in `text`.
pub(crate) fn parse_json(text: &str) -> Option<Value> {
    let start = text.find(['[', '{'])?;
    serde_json::Deserializer::from_str(&text[start..])
        .into_iter::<Value>()
        .next()?
        .ok()
}

pub(crate) fn args(list: &[&str]) -> Vec<String> {
    list.iter().map(|a| a.to_string()).collect()
}

/* ----------------------------------------------------------- status */

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthPlugin {
    /// `gke-gcloud-auth-plugin` | `kubelogin`
    pub name: String,
    pub installed: bool,
    /// The copy JET Pilot downloaded (Settings → Tools).
    pub managed: bool,
    pub path: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliStatus {
    /// `gcloud` | `az` | `doctl`
    pub tool: String,
    pub installed: bool,
    pub version: Option<String>,
    pub path: Option<String>,
    pub signed_in: bool,
    /// The active gcloud account / az user / current doctl context.
    pub account: Option<String>,
    /// Every signed-in gcloud account / az user / doctl context.
    pub accounts: Vec<String>,
    pub auth_plugin: Option<AuthPlugin>,
    pub install_url: String,
    /// Why the CLI can't be used (it failed, it isn't signed in, ...).
    pub message: Option<String>,
}

static STATUSES: Lazy<Mutex<HashMap<CliTool, (Instant, CliStatus)>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

/// One status computation per CLI at a time (the CLIs run in parallel).
static STATUS_RUNS: [tokio::sync::Mutex<()>; 3] = [
    tokio::sync::Mutex::const_new(()),
    tokio::sync::Mutex::const_new(()),
    tokio::sync::Mutex::const_new(()),
];

fn status_run(tool: CliTool) -> &'static tokio::sync::Mutex<()> {
    &STATUS_RUNS[match tool {
        CliTool::Gcloud => 0,
        CliTool::Az => 1,
        CliTool::Doctl => 2,
    }]
}

fn auth_plugin(tool: CliTool) -> Option<AuthPlugin> {
    let (name, found) = match tool {
        CliTool::Gcloud => (GKE_PLUGIN, gke_plugin_path().map(|p| (p, false))),
        CliTool::Az => (KUBELOGIN, kubelogin_path()),
        CliTool::Doctl => return None,
    };
    Some(AuthPlugin {
        name: name.to_string(),
        installed: found.is_some(),
        managed: found.as_ref().is_some_and(|(_, managed)| *managed),
        path: found.map(|(p, _)| p.to_string_lossy().into_owned()),
    })
}

/// The doctl contexts of `doctl auth list` and the current one.
pub(crate) fn parse_doctl_contexts(text: &str) -> (Vec<String>, Option<String>) {
    let mut contexts = Vec::new();
    let mut current = None;
    for line in text.lines().map(str::trim).filter(|l| !l.is_empty()) {
        let (name, is_current) = match line.strip_suffix("(current)") {
            Some(name) => (name.trim(), true),
            None => (line, false),
        };
        if name.contains(char::is_whitespace) {
            continue;
        }
        if is_current {
            current = Some(name.to_string());
        }
        contexts.push(name.to_string());
    }
    (contexts, current)
}

async fn compute_status(tool: CliTool) -> CliStatus {
    let path = find(tool.binary());
    let mut status = CliStatus {
        tool: tool.binary().to_string(),
        installed: path.is_some(),
        version: None,
        path: path.as_ref().map(|p| p.to_string_lossy().into_owned()),
        signed_in: false,
        account: None,
        accounts: Vec::new(),
        auth_plugin: auth_plugin(tool),
        install_url: tool.install_url().to_string(),
        message: None,
    };
    let Some(path) = path else {
        status.message = Some(format!("{} is not installed", tool.binary()));
        return status;
    };
    let version = crate::tools::version_of(tool.binary(), &path);
    let accounts = async {
        match tool {
            CliTool::Gcloud => {
                let value = run_json(
                    tool,
                    &args(&[
                        "auth",
                        "list",
                        "--format=json",
                        "--quiet",
                        "--verbosity=error",
                    ]),
                    STATUS_TIMEOUT,
                )
                .await?;
                let mut accounts = Vec::new();
                let mut active = None;
                for entry in value.as_array().into_iter().flatten() {
                    let Some(account) = entry.get("account").and_then(Value::as_str) else {
                        continue;
                    };
                    if entry.get("status").and_then(Value::as_str) == Some("ACTIVE") {
                        active = Some(account.to_string());
                    }
                    accounts.push(account.to_string());
                }
                Ok((accounts, active))
            }
            CliTool::Az => {
                let value = run_json(
                    tool,
                    &args(&["account", "list", "-o", "json", "--only-show-errors"]),
                    STATUS_TIMEOUT,
                )
                .await?;
                let mut accounts: Vec<String> = Vec::new();
                let mut default = None;
                for subscription in value.as_array().into_iter().flatten() {
                    let Some(user) = subscription.pointer("/user/name").and_then(Value::as_str)
                    else {
                        continue;
                    };
                    if subscription.get("isDefault").and_then(Value::as_bool) == Some(true) {
                        default = Some(user.to_string());
                    }
                    if !accounts.iter().any(|a| a == user) {
                        accounts.push(user.to_string());
                    }
                }
                Ok((accounts, default))
            }
            CliTool::Doctl => {
                let listed = run(tool, &args(&["auth", "list"]), STATUS_TIMEOUT).await?;
                let (contexts, current) = parse_doctl_contexts(&listed);
                // Signed in = the current context's token works.
                run(
                    tool,
                    &args(&["account", "get", "--output", "json"]),
                    STATUS_TIMEOUT,
                )
                .await?;
                Ok::<_, CliError>((contexts, current.or(Some("default".to_string()))))
            }
        }
    };
    let (version, accounts) = futures::join!(version, accounts);
    status.version = version;
    match accounts {
        Ok((accounts, account)) => {
            status.signed_in =
                !accounts.is_empty() || (tool == CliTool::Doctl && account.is_some());
            status.accounts = accounts;
            status.account = account;
            if !status.signed_in {
                status.message = Some(format!("{}: nobody is signed in", tool.sign_in_hint()));
            }
        }
        Err(error) => {
            status.message = Some(if error.needs_sign_in() {
                format!("{}: {}", tool.sign_in_hint(), error.message())
            } else {
                error.message()
            });
        }
    }
    status
}

/// The status of a CLI, reused while younger than `max_age`.
pub(crate) async fn status(tool: CliTool, max_age: Duration) -> CliStatus {
    let _running = status_run(tool).lock().await;
    if let Some((at, status)) = lock(&STATUSES).get(&tool) {
        if at.elapsed() < max_age {
            return status.clone();
        }
    }
    let status = compute_status(tool).await;
    lock(&STATUSES).insert(tool, (Instant::now(), status.clone()));
    status
}

/// The last known status of a CLI (no runs).
pub(crate) fn cached_status(tool: CliTool) -> Option<CliStatus> {
    lock(&STATUSES).get(&tool).map(|(_, status)| status.clone())
}

/// Forgets a CLI's status (after a sign-in).
pub(crate) fn forget_status(tool: CliTool) {
    lock(&STATUSES).remove(&tool);
}

fn tool_of(provider: &str) -> Result<CliTool, AppError> {
    CliTool::for_provider(provider).ok_or_else(|| {
        AppError::invalid(
            "provider",
            "Only Google Cloud (gcp), Azure (azure) and DigitalOcean (digitalocean) connect through a CLI.",
        )
    })
}

/// Whether `gcloud` / `az` / `doctl` is installed and signed in, and its
/// credential plugin (never prompts, never opens a browser).
#[tauri::command]
pub async fn cloud_cli_status(provider: String) -> Result<CliStatus, AppError> {
    Ok(status(tool_of(&provider)?, Duration::ZERO).await)
}

/* ---------------------------------------------------------- sign-in */

/// The sign-in command of a CLI (`gcloud auth login --brief` /
/// `az login --use-device-code`), streamed as a sign-in session.
pub(crate) fn sign_in_command(tool: CliTool) -> Result<(Vec<String>, SignInPlan), AppError> {
    match tool {
        // `--no-launch-browser` would wait for a pasted code on stdin;
        // the browser flow with its localhost redirect needs no input (the
        // URL is streamed too, for when no browser opened).
        CliTool::Gcloud => Ok((
            args(&["auth", "login", "--brief", "--quiet"]),
            SignInPlan::Gcloud,
        )),
        CliTool::Az => Ok((
            args(&["login", "--use-device-code", "--output", "none"]),
            SignInPlan::AzureCli,
        )),
        CliTool::Doctl => Err(AppError::invalid(
            "provider",
            "Use an API token for DigitalOcean: JET Pilot only reuses an existing doctl sign-in.",
        )),
    }
}

/// Signs in to `gcloud` / `az` (`gcloud auth login` in the browser, `az
/// login` with a device code), streaming `LoginEvent`s on `on_event`. The
/// returned session id works with `auth_login_open_url` and
/// `auth_login_cancel`. Contexts using the CLI's sign-in are refreshed
/// after.
#[tauri::command]
pub async fn cloud_cli_sign_in(
    provider: String,
    on_event: Channel<LoginEvent>,
) -> Result<String, AppError> {
    let tool = tool_of(&provider)?;
    let (args, plan) = sign_in_command(tool)?;
    let program = find(tool.binary()).ok_or_else(|| {
        AppError::not_found(format!(
            "{} is not installed. Install it from {}.",
            tool.binary(),
            tool.install_url()
        ))
    })?;
    let sink: LoginSink = Arc::new(move |event| on_event.send(event).is_ok());
    Ok(start_sign_in(tool, program, args, plan, sink))
}

pub(crate) fn start_sign_in(
    tool: CliTool,
    program: PathBuf,
    args: Vec<String>,
    plan: SignInPlan,
    sink: LoginSink,
) -> String {
    let env: Vec<(String, String)> = tool
        .env()
        .iter()
        .filter(|(name, _)| *name != "CLOUDSDK_CORE_DISABLE_PROMPTS")
        .map(|(n, v)| (n.to_string(), v.to_string()))
        .chain(search_path().map(|p| ("PATH".to_string(), p.to_string_lossy().into_owned())))
        .collect();
    login::start_tool_sign_in(
        ("cloud-cli".to_string(), tool.binary().to_string()),
        program,
        tool.binary().to_string(),
        args,
        env,
        plan,
        sink,
        Box::new(move || forget_status(tool)),
    )
}

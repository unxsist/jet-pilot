//! Interactive sign-in sessions (`auth_login_start`), streamed to the UI.
//!
//! The plan depends on the context's exec plugin:
//!
//! - `aws` with an SSO `AWS_PROFILE`: `aws sso login --profile <p>`, then a
//!   (non-interactive) mint to verify;
//! - `gke-gcloud-auth-plugin`: `gcloud auth login --brief`, then a mint;
//! - Azure `kubelogin` in `azurecli` mode: `az login --output none`, then a
//!   mint;
//! - anything else (kubelogin device code, oidc-login, ...): the plugin
//!   itself with `"interactive": true`. Its stdout is the ExecCredential: it
//!   goes into the broker cache and is never streamed.
//!
//! Every streamed line is redacted. Device codes and URLs found in the
//! output become `deviceCode` / `url` events; `auth_login_open_url` opens
//! only URLs the session emitted. `auth_login_cancel` kills the process
//! tree; sessions end after 10 minutes. On success the clients of every
//! context sharing the credential are rebuilt, unauthorized watches and
//! metrics restarted and `auth://resolved` emitted.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use kube::config::{ExecConfig, ExecInteractiveMode, KubeConfigOptions};
use once_cell::sync::Lazy;
use regex::Regex;
use serde::Serialize;
use tauri::ipc::Channel;
use tokio::sync::watch;
use tracing::{info, warn};

use super::broker::{self, Credential, CredentialKey, LineVerdict, RunError, RunOptions, StdoutMode, StreamKind};
use super::center::{self, Redactor};
use super::status::{self, AwsConfig, AwsSso};
use super::ContextRef;
use crate::kubeconfig_discovery::read_error_message;
use crate::kubernetes::client::{cached_kubeconfig_paths, invalidate_clients, read_kubeconfig, resolve_kubeconfig_path};
use crate::util::lock;

/// A sign-in session never runs longer.
const SESSION_LIMIT: Duration = Duration::from_secs(10 * 60);

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum LoginEvent {
    /// What runs (display string, no secrets).
    Started { command: String },
    /// A redacted output line.
    Line { stream: StreamKind, text: String },
    DeviceCode {
        user_code: String,
        verification_uri: String,
        verification_uri_complete: Option<String>,
    },
    Url { url: String },
    Succeeded { expires_at: Option<i64> },
    Failed { message: String },
    Cancelled,
}

/// Receives the events of a session. Returns false when the receiver is
/// gone (the session keeps running; the UI may come back to it).
pub(crate) type LoginSink = Arc<dyn Fn(LoginEvent) -> bool + Send + Sync>;

/* ------------------------------------------------------------------- plan */

/// How a context signs in.
#[derive(Debug, Clone, PartialEq)]
pub enum SignInPlan {
    /// `aws sso login --profile <login profile>`. `profile` is the context's
    /// `AWS_PROFILE`.
    AwsSso { profile: String, sso: AwsSso },
    Gcloud,
    AzureCli,
    /// Run the exec plugin interactively.
    ExecPlugin { command: String },
}

impl SignInPlan {
    pub fn label(&self) -> String {
        match self {
            SignInPlan::AwsSso { profile, .. } => format!("Sign in with AWS SSO (profile {profile})"),
            SignInPlan::Gcloud => "Sign in with gcloud".to_string(),
            SignInPlan::AzureCli => "Sign in with Azure CLI".to_string(),
            SignInPlan::ExecPlugin { command } => format!("Sign in with {command}"),
        }
    }

    /// The CLI login command of the tool plans.
    fn tool_command(&self) -> Option<(&'static str, Vec<String>)> {
        match self {
            SignInPlan::AwsSso { sso, .. } => Some((
                "aws",
                vec!["sso".into(), "login".into(), "--profile".into(), sso.login_profile.clone()],
            )),
            SignInPlan::Gcloud => Some(("gcloud", vec!["auth".into(), "login".into(), "--brief".into()])),
            SignInPlan::AzureCli => Some(("az", vec!["login".into(), "--output".into(), "none".into()])),
            SignInPlan::ExecPlugin { .. } => None,
        }
    }
}

fn exec_env(exec: &ExecConfig, name: &str) -> Option<String> {
    exec.env
        .as_ref()?
        .iter()
        .find(|env| env.get("name").map(String::as_str) == Some(name))
        .and_then(|env| env.get("value").cloned())
        .filter(|value| !value.trim().is_empty())
}

/// The AWS profile of an `aws eks get-token` plugin: `AWS_PROFILE` in its
/// env, else a `--profile` argument.
pub fn aws_profile(exec: &ExecConfig) -> Option<String> {
    if let Some(profile) = exec_env(exec, "AWS_PROFILE") {
        return Some(profile);
    }
    let args = exec.args.as_deref().unwrap_or_default();
    let mut iter = args.iter();
    while let Some(arg) = iter.next() {
        if arg == "--profile" {
            return iter.next().cloned().filter(|p| !p.is_empty());
        }
        if let Some(profile) = arg.strip_prefix("--profile=") {
            return Some(profile.to_string()).filter(|p| !p.is_empty());
        }
    }
    None
}

/// Azure kubelogin's login mode: the last `-l` / `--login`, else
/// `AAD_LOGIN_METHOD` (lowercase).
fn kubelogin_mode(exec: &ExecConfig) -> Option<String> {
    let args = exec.args.as_deref().unwrap_or_default();
    let mut mode = None;
    let mut iter = args.iter();
    while let Some(arg) = iter.next() {
        if arg == "-l" || arg == "--login" {
            mode = iter.next().cloned();
        } else if let Some(value) = arg.strip_prefix("--login=") {
            mode = Some(value.to_string());
        } else if let Some(value) = arg.strip_prefix("-l").filter(|v| !v.is_empty() && !arg.starts_with("--")) {
            mode = Some(value.strip_prefix('=').unwrap_or(value).to_string());
        }
    }
    mode.or_else(|| exec_env(exec, "AAD_LOGIN_METHOD"))
        .map(|mode| mode.trim().to_ascii_lowercase())
        .filter(|mode| !mode.is_empty())
}

/// Profile names passed to `aws sso login --profile`: no flags, nothing odd.
fn valid_profile_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 128
        && !name.starts_with('-')
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.' | '@' | '+' | '/' | ':'))
}

/// The sign-in plan of an exec plugin (see the module docs).
pub fn sign_in_plan(exec: &ExecConfig, aws: Option<&AwsConfig>) -> SignInPlan {
    let command = broker::display_command(exec);
    match command.to_ascii_lowercase().as_str() {
        "aws" => {
            let sso = aws_profile(exec).and_then(|profile| {
                let sso = aws?.sso(&profile)?;
                (valid_profile_name(&profile) && valid_profile_name(&sso.login_profile))
                    .then_some(SignInPlan::AwsSso { profile, sso })
            });
            sso.unwrap_or(SignInPlan::ExecPlugin { command })
        }
        "gke-gcloud-auth-plugin" => SignInPlan::Gcloud,
        "kubelogin" if kubelogin_mode(exec).as_deref() == Some("azurecli") => SignInPlan::AzureCli,
        "kubectl" if exec.args.as_ref().and_then(|a| a.first()).is_some_and(|a| a == "oidc-login") => {
            SignInPlan::ExecPlugin {
                command: "oidc-login".to_string(),
            }
        }
        "kubectl-oidc_login" | "kubectl-oidc-login" => SignInPlan::ExecPlugin {
            command: "oidc-login".to_string(),
        },
        _ => SignInPlan::ExecPlugin { command },
    }
}

/// The plugin invocation to show: basename and args, values of secret
/// looking flags masked.
fn display_invocation(exec: &ExecConfig) -> String {
    let sensitive = |flag: &str| {
        let flag = flag.to_ascii_lowercase();
        ["secret", "token", "password", "passwd", "key", "credential"]
            .iter()
            .any(|s| flag.contains(s))
    };
    let mut parts = vec![broker::display_command(exec)];
    let mut mask_next = false;
    for arg in exec.args.iter().flatten() {
        if mask_next {
            parts.push("***".to_string());
            mask_next = false;
            continue;
        }
        if arg.starts_with('-') {
            if let Some((flag, _)) = arg.split_once('=') {
                if sensitive(flag) {
                    parts.push(format!("{flag}=***"));
                    continue;
                }
            } else if sensitive(arg) {
                mask_next = true;
            }
        }
        parts.push(center::redact(arg));
    }
    parts.join(" ")
}

/* ---------------------------------------------------------------- parsing */

static AZURE_DEVICE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?i)open the page\s+(https://\S+?)\s+and enter the code\s+([A-Za-z0-9-]+)").unwrap()
});
static OIDC_CODE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(?i)enter the following code when asked in your browser:\s*([A-Za-z0-9-]+)").unwrap());
static AWS_DEVICE_URL: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"^https://device\.sso\.[a-z0-9-]+\.amazonaws\.com/\S*$").unwrap());
static AWS_CODE: Lazy<Regex> = Lazy::new(|| Regex::new(r"^[A-Z0-9]{4}-[A-Z0-9]{4}$").unwrap());
static URL: Lazy<Regex> = Lazy::new(|| Regex::new(r#"https?://[^\s"'<>`]+"#).unwrap());

fn trim_url(url: &str) -> &str {
    url.trim_end_matches(['.', ',', ';', ':', ')', ']', '}', '\'', '"', '>'])
}

/// URLs the app opens: https, or http to the local machine (callbacks of
/// browser flows).
pub(crate) fn openable(url: &str) -> bool {
    let lower = url.to_ascii_lowercase();
    if lower.starts_with("https://") {
        return lower.len() > "https://".len();
    }
    let Some(rest) = lower.strip_prefix("http://") else {
        return false;
    };
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    let host = match authority.strip_prefix('[') {
        Some(v6) => v6.split(']').next().unwrap_or(""),
        None => authority.split(':').next().unwrap_or(""),
    };
    matches!(host, "localhost" | "127.0.0.1" | "::1")
}

fn carries_secrets(url: &str) -> bool {
    let lower = url.to_ascii_lowercase();
    ["access_token=", "id_token=", "refresh_token=", "client_secret="]
        .iter()
        .any(|param| lower.contains(param))
}

fn query_param(url: &str, name: &str) -> Option<String> {
    let query = url.split_once('?')?.1;
    query
        .split('&')
        .filter_map(|pair| pair.split_once('='))
        .find(|(key, _)| *key == name)
        .map(|(_, value)| value.to_string())
        .filter(|value| !value.is_empty())
}

/// Finds device codes and sign-in URLs in login output, line by line.
#[derive(Debug, Default)]
pub(crate) struct PromptParser {
    pending_uri: Option<String>,
    pending_code: Option<String>,
    /// The output announced a code on one of the next lines (aws).
    expect_code: bool,
    seen_codes: HashSet<String>,
    seen_urls: HashSet<String>,
}

impl PromptParser {
    fn device_code(&mut self, code: &str, uri: &str, complete: Option<String>) -> Option<LoginEvent> {
        self.expect_code = false;
        self.pending_code = None;
        if !self.seen_codes.insert(code.to_string()) {
            return None;
        }
        self.seen_urls.insert(uri.to_string());
        Some(LoginEvent::DeviceCode {
            user_code: code.to_string(),
            verification_uri: uri.to_string(),
            verification_uri_complete: complete,
        })
    }

    fn url(&mut self, url: &str) -> Option<LoginEvent> {
        self.seen_urls
            .insert(url.to_string())
            .then(|| LoginEvent::Url { url: url.to_string() })
    }

    pub fn feed(&mut self, line: &str) -> Vec<LoginEvent> {
        let trimmed = line.trim();
        let mut events = Vec::new();
        if trimmed.is_empty() {
            return events;
        }

        // kubelogin (Azure) / az: one line with URL and code.
        if let Some(caps) = AZURE_DEVICE.captures(trimmed) {
            let uri = trim_url(&caps[1]).to_string();
            events.extend(self.device_code(&caps[2], &uri, None));
            return events;
        }

        // oidc-login device flow: the code and the URL on separate lines.
        if let Some(caps) = OIDC_CODE.captures(trimmed) {
            let code = caps[1].to_string();
            match self.pending_uri.clone() {
                Some(uri) => events.extend(self.device_code(&code, &uri, None)),
                None => self.pending_code = Some(code),
            }
            return events;
        }

        // aws sso login: the verification URL alone on a line, the code a
        // few lines later (or in the URL).
        if AWS_DEVICE_URL.is_match(trimmed) {
            let url = trim_url(trimmed).to_string();
            if let Some(code) = query_param(&url, "user_code") {
                let base = url.split('?').next().unwrap_or(&url).to_string();
                events.extend(self.device_code(&code, &base, Some(url)));
            } else {
                events.extend(self.url(&url));
                self.pending_uri = Some(url);
                self.expect_code = true;
            }
            return events;
        }
        if self.expect_code && AWS_CODE.is_match(trimmed) {
            if let Some(uri) = self.pending_uri.clone() {
                events.extend(self.device_code(trimmed, &uri, None));
            }
            return events;
        }
        if trimmed.to_ascii_lowercase().contains("enter the code") {
            self.expect_code = true;
        }

        // Any other sign-in URL.
        for found in URL.find_iter(trimmed) {
            let url = trim_url(found.as_str()).to_string();
            if !openable(&url) || carries_secrets(&url) {
                continue;
            }
            match self.pending_code.clone() {
                Some(code) => events.extend(self.device_code(&code, &url, None)),
                None => events.extend(self.url(&url)),
            }
            self.pending_uri = Some(url);
        }
        events
    }
}

/* --------------------------------------------------------------- sessions */

struct Session {
    id: String,
    target: (String, String),
    /// URLs this session showed (the only ones `auth_login_open_url` opens).
    urls: Mutex<HashSet<String>>,
    cancel: watch::Sender<bool>,
    pid: Arc<Mutex<Option<u32>>>,
}

static SESSIONS: Lazy<Mutex<HashMap<String, Arc<Session>>>> = Lazy::new(|| Mutex::new(HashMap::new()));

/// Everything a session needs, read up front.
#[derive(Clone)]
pub(crate) struct Prepared {
    /// Resolved kubeconfig path.
    kube_config: String,
    context: String,
    user: String,
    /// As `kube::Config` loads it (cluster info filled in).
    exec: ExecConfig,
    plan: SignInPlan,
}

impl Prepared {
    fn key(&self) -> CredentialKey {
        CredentialKey::new(&self.kube_config, &self.user, &self.exec)
    }
}

async fn prepare(target: &ContextRef) -> Result<Prepared, String> {
    let path = resolve_kubeconfig_path(Some(&target.kube_config));
    let kubeconfig = read_kubeconfig(Some(&path)).map_err(|e| read_error_message(&e))?;
    let found = status::context_auth(&kubeconfig, &target.context)
        .ok_or_else(|| format!("The context {} is not defined in this kubeconfig", target.context))?;
    if !broker::uses_exec(&found.auth) {
        return Err(format!(
            "The context {} does not sign in through a command (it uses static credentials)",
            target.context
        ));
    }
    let options = KubeConfigOptions {
        context: Some(target.context.clone()),
        cluster: None,
        user: None,
    };
    let config = kube::Config::from_custom_kubeconfig(kubeconfig, &options)
        .await
        .map_err(|e| read_error_message(&e))?;
    let exec = config
        .auth_info
        .exec
        .clone()
        .ok_or_else(|| format!("The context {} has no exec credential plugin", target.context))?;
    let aws = status::aws_config_path(&exec, status::home_dir().as_deref(), status::process_aws_config_file())
        .and_then(|p| AwsConfig::read(&p));
    let plan = sign_in_plan(&exec, aws.as_ref());
    Ok(Prepared {
        kube_config: path,
        context: target.context.clone(),
        user: found.user,
        exec,
        plan,
    })
}

/// Starts a sign-in for `target`. Events (see `LoginEvent`) arrive on
/// `on_event`; the returned id is passed to `auth_login_open_url` and
/// `auth_login_cancel`.
#[tauri::command]
pub async fn auth_login_start(target: ContextRef, on_event: Channel<LoginEvent>) -> Result<String, String> {
    let sink: LoginSink = Arc::new(move |event| on_event.send(event).is_ok());
    start(target, sink).await
}

pub(crate) async fn start(target: ContextRef, sink: LoginSink) -> Result<String, String> {
    let prepared = prepare(&target).await?;
    let id = uuid::Uuid::new_v4().to_string();
    let (cancel, cancel_rx) = watch::channel(false);
    let session = Arc::new(Session {
        id: id.clone(),
        target: (prepared.kube_config.clone(), prepared.context.clone()),
        urls: Mutex::new(HashSet::new()),
        cancel,
        pid: Arc::new(Mutex::new(None)),
    });
    {
        let mut sessions = lock(&SESSIONS);
        // One sign-in per context: a new one replaces a running one (two
        // would fight over the same callback port / token cache).
        for other in sessions.values().filter(|s| s.target == session.target) {
            other.cancel.send_replace(true);
        }
        sessions.insert(id.clone(), session.clone());
    }
    info!("Sign-in {} for {}: {}", id, prepared.context, prepared.plan.label());
    tauri::async_runtime::spawn(run(session, prepared, cancel_rx, sink));
    Ok(id)
}

/// Opens a URL the session showed (https, or http to localhost) in the
/// browser.
#[tauri::command]
pub async fn auth_login_open_url(session_id: String, url: String) -> Result<(), String> {
    let session = lock(&SESSIONS)
        .get(&session_id)
        .cloned()
        .ok_or("The sign-in has ended")?;
    if !lock(&session.urls).contains(&url) || !openable(&url) {
        return Err("This URL was not shown by the sign-in".to_string());
    }
    tauri::async_runtime::spawn_blocking(move || open::that_detached(&url))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| format!("Unable to open the browser: {e}"))
}

/// Cancels a sign-in (kills its process tree). A finished session is fine.
#[tauri::command]
pub fn auth_login_cancel(session_id: String) {
    if let Some(session) = lock(&SESSIONS).get(&session_id) {
        session.cancel.send_replace(true);
    }
}

/// Kills every running sign-in (app exit: their tasks may not run again).
pub fn cancel_all() {
    let sessions: Vec<Arc<Session>> = lock(&SESSIONS).drain().map(|(_, s)| s).collect();
    for session in sessions {
        session.cancel.send_replace(true);
        if let Some(pid) = lock(&session.pid).take() {
            broker::kill_tree(pid);
        }
    }
}

enum LoginError {
    Cancelled,
    Failed(String),
}

async fn run(session: Arc<Session>, prepared: Prepared, cancel: watch::Receiver<bool>, sink: LoginSink) {
    let outcome = tokio::time::timeout(SESSION_LIMIT, drive(&session, &prepared, cancel, &sink)).await;
    let event = match outcome {
        Ok(Ok(minted)) => match finish(&prepared, minted).await {
            Ok(expires_at) => LoginEvent::Succeeded { expires_at },
            Err(message) => LoginEvent::Failed { message },
        },
        Ok(Err(LoginError::Cancelled)) => LoginEvent::Cancelled,
        Ok(Err(LoginError::Failed(message))) => LoginEvent::Failed { message },
        Err(_) => LoginEvent::Failed {
            message: "The sign-in did not finish within 10 minutes".to_string(),
        },
    };
    match &event {
        LoginEvent::Failed { message } => warn!("Sign-in {} failed: {}", session.id, message),
        other => info!("Sign-in {} ended: {:?}", session.id, other),
    }
    sink(event);
    let mut sessions = lock(&SESSIONS);
    if sessions.get(&session.id).is_some_and(|s| Arc::ptr_eq(s, &session)) {
        sessions.remove(&session.id);
    }
}

/// Redacts and streams lines, and turns prompts into events.
struct LineHandler {
    session: Arc<Session>,
    sink: LoginSink,
    stdout: Redactor,
    stderr: Redactor,
    parser: PromptParser,
}

impl LineHandler {
    fn line(&mut self, stream: StreamKind, raw: &str) -> LineVerdict {
        let redactor = match stream {
            StreamKind::Stdout => &mut self.stdout,
            StreamKind::Stderr => &mut self.stderr,
        };
        let text = redactor.line(raw);
        if !text.trim().is_empty() {
            (self.sink)(LoginEvent::Line { stream, text });
        }
        for event in self.parser.feed(raw) {
            {
                let mut urls = lock(&self.session.urls);
                match &event {
                    LoginEvent::Url { url } => {
                        urls.insert(url.clone());
                    }
                    LoginEvent::DeviceCode {
                        verification_uri,
                        verification_uri_complete,
                        ..
                    } => {
                        urls.insert(verification_uri.clone());
                        if let Some(complete) = verification_uri_complete {
                            urls.insert(complete.clone());
                        }
                    }
                    _ => {}
                }
            }
            (self.sink)(event);
        }
        LineVerdict::Continue
    }
}

fn run_error(error: RunError, command: &str) -> LoginError {
    match error {
        RunError::Cancelled => LoginError::Cancelled,
        RunError::NotFound => LoginError::Failed(format!("{command} is not installed or not on PATH")),
        RunError::Timeout => LoginError::Failed("The sign-in did not finish within 10 minutes".to_string()),
        RunError::StdoutTooLarge => LoginError::Failed(format!("{command} printed more than 1 MiB")),
        RunError::Aborted(_) => LoginError::Failed(format!("{command} was stopped")),
        RunError::Start(message) => LoginError::Failed(format!("Unable to run {command}: {message}")),
    }
}

/// Runs the plan's process. Returns the credential when the exec plugin
/// itself ran.
async fn drive(
    session: &Arc<Session>,
    prepared: &Prepared,
    cancel: watch::Receiver<bool>,
    sink: &LoginSink,
) -> Result<Option<Credential>, LoginError> {
    let mut handler = LineHandler {
        session: session.clone(),
        sink: sink.clone(),
        stdout: Redactor::default(),
        stderr: Redactor::default(),
        parser: PromptParser::default(),
    };
    let mut on_line = |stream: StreamKind, line: &str| handler.line(stream, line);

    match prepared.plan.tool_command() {
        None => {
            let command = broker::display_command(&prepared.exec);
            // Interactive, unless the kubeconfig says the plugin never is.
            let interactive = prepared.exec.interactive_mode != Some(ExecInteractiveMode::Never);
            let cmd = broker::plugin_command(&prepared.exec, interactive).map_err(|e| LoginError::Failed(e.to_string()))?;
            sink(LoginEvent::Started {
                command: display_invocation(&prepared.exec),
            });
            let run = broker::run_process(
                cmd,
                RunOptions {
                    timeout: SESSION_LIMIT,
                    // The ExecCredential: parsed, never streamed.
                    stdout: StdoutMode::Capture,
                    on_line: &mut on_line,
                    cancel: Some(cancel),
                    pid: Some(session.pid.clone()),
                },
            )
            .await
            .map_err(|e| run_error(e, &command))?;
            if !run.status.success() {
                return Err(LoginError::Failed(
                    broker::failure_from_stderr(&command, run.status, &run.stderr_tail).to_string(),
                ));
            }
            broker::parse_exec_credential(&run.stdout)
                .map(Some)
                .map_err(|message| LoginError::Failed(format!("{command}: {message}")))
        }
        Some((program, args)) => {
            // `which` finds gcloud.cmd / az.cmd on Windows.
            let resolved = which::which(program).map_err(|_| {
                LoginError::Failed(format!("{program} is not installed or not on PATH"))
            })?;
            let mut cmd = broker::spawnable(resolved);
            cmd.args(&args);
            // The plugin's env (AWS_CONFIG_FILE, CLOUDSDK_CONFIG, ...).
            for env in prepared.exec.env.iter().flatten() {
                if let (Some(name), Some(value)) = (env.get("name"), env.get("value")) {
                    cmd.env(name, value);
                }
            }
            sink(LoginEvent::Started {
                command: format!("{program} {}", args.join(" ")),
            });
            let run = broker::run_process(
                cmd,
                RunOptions {
                    timeout: SESSION_LIMIT,
                    stdout: StdoutMode::Lines,
                    on_line: &mut on_line,
                    cancel: Some(cancel),
                    pid: Some(session.pid.clone()),
                },
            )
            .await
            .map_err(|e| run_error(e, program))?;
            if !run.status.success() {
                let detail = center::redact(run.stderr_tail.trim());
                let code = run
                    .status
                    .code()
                    .map(|c| format!("exit code {c}"))
                    .unwrap_or_else(|| "a signal".to_string());
                return Err(LoginError::Failed(if detail.is_empty() {
                    format!("{program} failed ({code})")
                } else {
                    format!("{program} failed ({code}): {detail}")
                }));
            }
            Ok(None)
        }
    }
}

/// A context that shares the signed-in credential.
struct Affected {
    kube_config: String,
    context: String,
    key: Option<CredentialKey>,
}

fn shares_login(plan: &SignInPlan, exec: &ExecConfig, aws_profiles: &HashSet<String>) -> bool {
    let command = broker::display_command(exec).to_ascii_lowercase();
    match plan {
        SignInPlan::AwsSso { .. } => command == "aws" && aws_profile(exec).is_some_and(|p| aws_profiles.contains(&p)),
        SignInPlan::Gcloud => command == "gke-gcloud-auth-plugin",
        SignInPlan::AzureCli => command == "kubelogin" && kubelogin_mode(exec).as_deref() == Some("azurecli"),
        SignInPlan::ExecPlugin { .. } => false,
    }
}

/// Every known context that the sign-in refreshed: the same kubeconfig
/// user, the same plugin invocation, or the same tool login (AWS SSO
/// session, gcloud account, Azure CLI), across the kubeconfigs in use.
fn affected_contexts(prepared: &Prepared) -> Vec<Affected> {
    let target_key = prepared.key();
    let aws_profiles: HashSet<String> = match &prepared.plan {
        SignInPlan::AwsSso { profile, sso } => {
            let aws = status::aws_config_path(&prepared.exec, status::home_dir().as_deref(), status::process_aws_config_file())
                .and_then(|p| AwsConfig::read(&p));
            let mut profiles = aws.map(|aws| aws.profiles_sharing(sso)).unwrap_or_default();
            profiles.insert(profile.clone());
            profiles
        }
        _ => HashSet::new(),
    };

    let mut paths = vec![prepared.kube_config.clone()];
    for path in cached_kubeconfig_paths() {
        if !paths.contains(&path) {
            paths.push(path);
        }
    }

    let mut affected = Vec::new();
    for path in paths {
        let Ok(config) = read_kubeconfig(Some(&path)) else { continue };
        for named in &config.contexts {
            let Some(found) = status::context_auth(&config, &named.name) else { continue };
            let exec = found.auth.exec.as_ref().filter(|_| broker::uses_exec(&found.auth));
            let key = exec.map(|exec| CredentialKey::with_server(&path, &found.user, exec, found.server.as_deref()));
            let same_user = path == prepared.kube_config && found.user == prepared.user;
            let same_spec = key.as_ref().is_some_and(|k| k.spec == target_key.spec);
            let same_login = exec.is_some_and(|exec| shares_login(&prepared.plan, exec, &aws_profiles));
            if same_user || same_spec || same_login {
                affected.push(Affected {
                    kube_config: path.clone(),
                    context: named.name.clone(),
                    key,
                });
            }
        }
    }
    if !affected
        .iter()
        .any(|a| a.kube_config == prepared.kube_config && a.context == prepared.context)
    {
        affected.push(Affected {
            kube_config: prepared.kube_config.clone(),
            context: prepared.context.clone(),
            key: Some(target_key),
        });
    }
    affected
}

/// After the sign-in: refresh the broker cache, verify by minting, rebuild
/// clients, restart what failed and tell the UI.
async fn finish(prepared: &Prepared, minted: Option<Credential>) -> Result<Option<i64>, String> {
    let affected = {
        let prepared = prepared.clone();
        tauri::async_runtime::spawn_blocking(move || affected_contexts(&prepared))
            .await
            .map_err(|e| e.to_string())?
    };
    let target_key = prepared.key();
    broker::slot(&target_key).clear();
    for key in affected.iter().filter_map(|a| a.key.as_ref()) {
        broker::slot(key).clear();
    }
    if let Some(credential) = minted {
        // Same plugin invocation: same credential.
        broker::slot(&target_key).store(credential.clone());
        for key in affected.iter().filter_map(|a| a.key.as_ref()).filter(|k| k.spec == target_key.spec) {
            broker::slot(key).store(credential.clone());
        }
    }
    let credential = broker::credential(&target_key, &prepared.exec)
        .await
        .map_err(|e| e.to_string())?;

    let pairs: Vec<(String, String)> = affected
        .iter()
        .map(|a| (a.kube_config.clone(), a.context.clone()))
        .collect();
    invalidate_clients(&pairs);
    let contexts: Vec<ContextRef> = pairs
        .iter()
        .map(|(kube_config, context)| ContextRef {
            kube_config: kube_config.clone(),
            context: context.clone(),
        })
        .collect();
    center::clear_issues(&contexts);
    let restart = pairs.clone();
    tauri::async_runtime::spawn(async move {
        let watches = crate::watch::restart_unauthorized(&restart).await;
        let pollers = crate::metrics::retry_contexts(&restart).await;
        if watches + pollers > 0 {
            info!("Restarted {} watches and {} metrics pollers after sign-in", watches, pollers);
        }
    });
    info!(
        "Signed in: {}",
        contexts.iter().map(|c| c.context.as_str()).collect::<Vec<_>>().join(", ")
    );
    center::emit_resolved(contexts);
    Ok(credential.expires_at_ms())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn feed_all(lines: &str) -> Vec<LoginEvent> {
        let mut parser = PromptParser::default();
        lines.lines().flat_map(|line| parser.feed(line)).collect()
    }

    #[test]
    fn kubelogin_and_az_device_codes() {
        let events = feed_all(
            "To sign in, use a web browser to open the page https://microsoft.com/devicelogin and enter the code FQ8RLYZ3K to authenticate.\n",
        );
        assert_eq!(
            events,
            vec![LoginEvent::DeviceCode {
                user_code: "FQ8RLYZ3K".into(),
                verification_uri: "https://microsoft.com/devicelogin".into(),
                verification_uri_complete: None,
            }]
        );
    }

    #[test]
    fn aws_sso_device_flow() {
        let output = "\
Attempting to automatically open the SSO authorization page in your default browser.
If the browser does not open or you wish to use a different device to authorize this request, open the following URL:

https://device.sso.eu-west-1.amazonaws.com/

Then enter the code:

WDKX-PQLM
Successfully logged into Start URL: https://corp.awsapps.com/start
";
        let events = feed_all(output);
        assert_eq!(
            events[0],
            LoginEvent::Url {
                url: "https://device.sso.eu-west-1.amazonaws.com/".into()
            }
        );
        assert_eq!(
            events[1],
            LoginEvent::DeviceCode {
                user_code: "WDKX-PQLM".into(),
                verification_uri: "https://device.sso.eu-west-1.amazonaws.com/".into(),
                verification_uri_complete: None,
            }
        );

        // Newer CLIs put the code into the URL.
        let events = feed_all("https://device.sso.us-east-1.amazonaws.com/?user_code=ABCD-EFGH\n");
        assert_eq!(
            events,
            vec![LoginEvent::DeviceCode {
                user_code: "ABCD-EFGH".into(),
                verification_uri: "https://device.sso.us-east-1.amazonaws.com/".into(),
                verification_uri_complete: Some("https://device.sso.us-east-1.amazonaws.com/?user_code=ABCD-EFGH".into()),
            }]
        );

        // PKCE (authorization code) flow: a plain URL.
        let pkce = "https://oidc.eu-west-1.amazonaws.com/authorize?response_type=code&client_id=abc&redirect_uri=http%3A%2F%2F127.0.0.1%3A49152%2Foauth%2Fcallback&state=xyz&code_challenge_method=S256&scopes=sso%3Aaccount%3Aaccess&code_challenge=Q2hhbGxlbmdl";
        let events = feed_all(&format!("open the following URL:\n\n{pkce}\n"));
        assert_eq!(events, vec![LoginEvent::Url { url: pkce.into() }]);
    }

    #[test]
    fn oidc_login_and_gcloud_urls() {
        let events = feed_all("Please visit the following URL in your browser: http://localhost:8000\n");
        assert_eq!(events, vec![LoginEvent::Url { url: "http://localhost:8000".into() }]);

        let events = feed_all(
            "Please enter the following code when asked in your browser: QWER-TYUI\nPlease visit the following URL in your browser: https://issuer.example/device\n",
        );
        assert_eq!(
            events,
            vec![LoginEvent::DeviceCode {
                user_code: "QWER-TYUI".into(),
                verification_uri: "https://issuer.example/device".into(),
                verification_uri_complete: None,
            }]
        );

        let gcloud = "Your browser has been opened to visit:\n\n    https://accounts.google.com/o/oauth2/auth?response_type=code&client_id=32555940559.apps.googleusercontent.com&redirect_uri=http%3A%2F%2Flocalhost%3A8085%2F&scope=openid&state=abc&access_type=offline&code_challenge=xyz&code_challenge_method=S256\n\n";
        let events = feed_all(gcloud);
        assert_eq!(events.len(), 1);
        assert!(matches!(&events[0], LoginEvent::Url { url } if url.starts_with("https://accounts.google.com/o/oauth2/auth?")));

        let az = "A web browser has been opened at https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize. Please continue the login in the web browser.";
        assert_eq!(
            feed_all(az),
            vec![LoginEvent::Url {
                url: "https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize".into()
            }]
        );

        // Not offered: remote http, URLs with tokens, duplicates.
        assert!(feed_all("see http://example.com/login").is_empty());
        assert!(feed_all("https://x.example/cb#access_token=abc").is_empty());
        assert_eq!(feed_all("https://a.example\nhttps://a.example").len(), 1);
    }

    #[test]
    fn openable_urls() {
        assert!(openable("https://microsoft.com/devicelogin"));
        assert!(openable("http://localhost:8000"));
        assert!(openable("http://127.0.0.1:49152/oauth/callback"));
        assert!(openable("http://[::1]:8000/"));
        assert!(!openable("http://localhost.evil.example/"));
        assert!(!openable("http://example.com"));
        assert!(!openable("file:///etc/passwd"));
        assert!(!openable("javascript:alert(1)"));
        assert!(!openable("https://"));
    }

    fn exec(command: &str, args: &[&str], env: &[(&str, &str)]) -> ExecConfig {
        ExecConfig {
            command: Some(command.into()),
            args: Some(args.iter().map(|a| a.to_string()).collect()),
            env: Some(
                env.iter()
                    .map(|(n, v)| HashMap::from([("name".to_string(), n.to_string()), ("value".to_string(), v.to_string())]))
                    .collect(),
            ),
            ..Default::default()
        }
    }

    #[test]
    fn plans_and_labels() {
        let aws = AwsConfig::parse("[profile prod-admin]\nsso_session = corp\n[sso-session corp]\nsso_start_url = https://corp.awsapps.com/start\n[profile -evil]\nsso_start_url = https://x\n");
        let plan = sign_in_plan(&exec("aws", &["eks", "get-token"], &[("AWS_PROFILE", "prod-admin")]), Some(&aws));
        assert!(matches!(&plan, SignInPlan::AwsSso { profile, .. } if profile == "prod-admin"));
        assert_eq!(plan.label(), "Sign in with AWS SSO (profile prod-admin)");
        assert_eq!(
            plan.tool_command().unwrap().1,
            vec!["sso", "login", "--profile", "prod-admin"]
        );
        // Flag-like profile names never reach the command line.
        let plan = sign_in_plan(&exec("aws", &["eks", "get-token", "--profile", "-evil"], &[]), Some(&aws));
        assert!(matches!(plan, SignInPlan::ExecPlugin { .. }));
        // Not an SSO profile: run the plugin.
        let plan = sign_in_plan(&exec("aws", &["eks", "get-token"], &[("AWS_PROFILE", "keys")]), Some(&aws));
        assert_eq!(plan, SignInPlan::ExecPlugin { command: "aws".into() });

        assert_eq!(sign_in_plan(&exec("/usr/bin/gke-gcloud-auth-plugin", &[], &[]), None), SignInPlan::Gcloud);
        assert_eq!(
            sign_in_plan(&exec("kubelogin", &["get-token", "-l", "azurecli", "--server-id", "x"], &[]), None),
            SignInPlan::AzureCli
        );
        assert_eq!(
            sign_in_plan(&exec("kubelogin", &["get-token"], &[("AAD_LOGIN_METHOD", "azurecli")]), None),
            SignInPlan::AzureCli
        );
        assert_eq!(
            sign_in_plan(&exec("kubelogin", &["get-token", "--login", "devicecode"], &[]), None).label(),
            "Sign in with kubelogin"
        );
        assert_eq!(
            sign_in_plan(&exec("kubectl", &["oidc-login", "get-token"], &[]), None).label(),
            "Sign in with oidc-login"
        );
    }

    #[test]
    fn invocations_hide_secret_flags() {
        let shown = display_invocation(&exec(
            "/usr/local/bin/kubectl",
            &["oidc-login", "get-token", "--oidc-client-secret=s3cr3t", "--oidc-client-id", "app", "--token", "abc"],
            &[],
        ));
        assert_eq!(
            shown,
            "kubectl oidc-login get-token --oidc-client-secret=*** --oidc-client-id app --token ***"
        );
    }

    /// A fake `kubelogin` that prints a device code to stderr, then the
    /// ExecCredential to stdout.
    #[cfg(unix)]
    #[tokio::test]
    async fn exec_plugin_sign_in_streams_the_prompt_and_never_the_credential() {
        use super::super::broker::tests::{script, token_credential};
        let dir = tempfile::tempdir().unwrap();
        let info = dir.path().join("info");
        let plugin = script(
            dir.path(),
            "kubelogin",
            &format!(
                "printf '%s' \"$KUBERNETES_EXEC_INFO\" > '{}'\n\
                 echo 'To sign in, use a web browser to open the page https://microsoft.com/devicelogin and enter the code ABCD12345 to authenticate.' >&2\n\
                 sleep 0.2\n\
                 echo '{}'\n",
                info.display(),
                token_credential("super-secret-login-token", Some(3600))
            ),
        );
        let kubeconfig = dir.path().join("kubeconfig.yaml");
        std::fs::write(
            &kubeconfig,
            format!(
                "apiVersion: v1\nkind: Config\nclusters:\n- name: c\n  cluster:\n    server: https://k8s.example\ncontexts:\n- name: aks\n  context:\n    cluster: c\n    user: aad\n- name: aks-2\n  context:\n    cluster: c\n    user: aad\nusers:\n- name: aad\n  user:\n    exec:\n      apiVersion: client.authentication.k8s.io/v1beta1\n      command: {}\n      args: [get-token, --login, devicecode, --server-id, x]\n",
                plugin.display()
            ),
        )
        .unwrap();
        let kube_config = kubeconfig.to_string_lossy().into_owned();

        let events: Arc<Mutex<Vec<LoginEvent>>> = Arc::default();
        let collected = events.clone();
        let sink: LoginSink = Arc::new(move |event| {
            lock(&collected).push(event);
            true
        });
        let id = start(
            ContextRef {
                kube_config: kube_config.clone(),
                context: "aks".into(),
            },
            sink,
        )
        .await
        .unwrap();

        let deadline = std::time::Instant::now() + Duration::from_secs(20);
        loop {
            let done = lock(&events)
                .iter()
                .any(|e| matches!(e, LoginEvent::Succeeded { .. } | LoginEvent::Failed { .. } | LoginEvent::Cancelled));
            if done {
                break;
            }
            assert!(std::time::Instant::now() < deadline, "sign-in did not finish: {:?}", lock(&events));
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        let events = lock(&events).clone();
        assert!(matches!(&events[0], LoginEvent::Started { command } if command == "kubelogin get-token --login devicecode --server-id x"));
        assert!(events.contains(&LoginEvent::DeviceCode {
            user_code: "ABCD12345".into(),
            verification_uri: "https://microsoft.com/devicelogin".into(),
            verification_uri_complete: None,
        }));
        assert!(events.iter().any(|e| matches!(e, LoginEvent::Line { stream: StreamKind::Stderr, text } if text.contains("devicelogin"))));
        assert!(matches!(events.last(), Some(LoginEvent::Succeeded { expires_at: Some(_) })), "{events:?}");
        let json = serde_json::to_string(&events).unwrap();
        assert!(!json.contains("super-secret-login-token"), "stdout leaked: {json}");
        assert!(!json.contains("ExecCredential"), "stdout leaked: {json}");

        // Ran interactively; the credential is cached for both contexts of
        // the user.
        let info: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(info).unwrap()).unwrap();
        assert_eq!(info["spec"]["interactive"], true);
        let config = read_kubeconfig(Some(&kube_config)).unwrap();
        let found = status::context_auth(&config, "aks").unwrap();
        let key = CredentialKey::with_server(&kube_config, "aad", found.auth.exec.as_ref().unwrap(), None);
        assert!(broker::cached_meta(&key).is_some_and(|m| m.fresh));

        // The session is gone; its URLs can't be opened anymore.
        assert!(auth_login_open_url(id, "https://microsoft.com/devicelogin".into()).await.is_err());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn cancelling_kills_the_sign_in() {
        use super::super::broker::tests::script;
        let dir = tempfile::tempdir().unwrap();
        let plugin = script(
            dir.path(),
            "oidc",
            "echo 'Please visit the following URL in your browser: http://localhost:8000' >&2\nsleep 300\n",
        );
        let kubeconfig = dir.path().join("kubeconfig.yaml");
        std::fs::write(
            &kubeconfig,
            format!(
                "apiVersion: v1\nkind: Config\nclusters:\n- name: c\n  cluster:\n    server: https://k8s.example\ncontexts:\n- name: oidc\n  context:\n    cluster: c\n    user: u\nusers:\n- name: u\n  user:\n    exec:\n      apiVersion: client.authentication.k8s.io/v1beta1\n      command: {}\n",
                plugin.display()
            ),
        )
        .unwrap();
        let events: Arc<Mutex<Vec<LoginEvent>>> = Arc::default();
        let collected = events.clone();
        let sink: LoginSink = Arc::new(move |event| {
            lock(&collected).push(event);
            true
        });
        let id = start(
            ContextRef {
                kube_config: kubeconfig.to_string_lossy().into_owned(),
                context: "oidc".into(),
            },
            sink,
        )
        .await
        .unwrap();

        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        while !lock(&events).iter().any(|e| matches!(e, LoginEvent::Url { .. })) {
            assert!(std::time::Instant::now() < deadline, "no url: {:?}", lock(&events));
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        // Only shown URLs may be opened.
        assert!(auth_login_open_url(id.clone(), "https://evil.example".into()).await.is_err());

        auth_login_cancel(id);
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        while !lock(&events).contains(&LoginEvent::Cancelled) {
            assert!(std::time::Instant::now() < deadline, "not cancelled: {:?}", lock(&events));
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }

    #[tokio::test]
    async fn static_credentials_cannot_sign_in() {
        let dir = tempfile::tempdir().unwrap();
        let kubeconfig = dir.path().join("kubeconfig.yaml");
        std::fs::write(
            &kubeconfig,
            "apiVersion: v1\nkind: Config\nclusters:\n- name: c\n  cluster:\n    server: https://k8s.example\ncontexts:\n- name: t\n  context:\n    cluster: c\n    user: u\nusers:\n- name: u\n  user:\n    token: abc\n",
        )
        .unwrap();
        let sink: LoginSink = Arc::new(|_| true);
        let err = start(
            ContextRef {
                kube_config: kubeconfig.to_string_lossy().into_owned(),
                context: "t".into(),
            },
            sink,
        )
        .await
        .unwrap_err();
        assert!(err.contains("static credentials"), "{err}");
    }
}

//! Credential broker: runs exec credential plugins for the API clients
//! instead of kube-rs.
//!
//! kube-rs runs exec plugins synchronously while creating a client (up to
//! three times), without a timeout and with stderr inherited, so device
//! codes are lost and a plugin waiting for a sign-in hangs the caller. The
//! broker runs them with tokio instead:
//!
//! - stdin closed, `KUBERNETES_EXEC_INFO` with `"interactive": false` (plus
//!   the cluster when `provideClusterInfo`), the exec env, no console window
//!   on Windows, own process group on unix, killed (with its children) on
//!   timeout or drop;
//! - 20 s timeout, stdout capped at 1 MiB and parsed as an ExecCredential
//!   (v1 / v1beta1 JSON), stderr captured;
//! - a plugin that prints a sign-in prompt (device code, browser URL) is
//!   killed right away: `BrokerError::InteractionRequired`;
//! - credentials are cached per `CredentialKey` (kubeconfig + user + exec
//!   spec) until 60 s before their `expirationTimestamp` (15 min without
//!   one); concurrent requests for a key share one plugin run.
//!
//! Clients get the token per request through `layer::BrokerTokenLayer`, or
//! the client certificate injected into their TLS config (with
//! `valid_until`, so the client cache rebuilds them in time).
//!
//! The broker can be switched off (`auth_set_broker(false)`): clients then
//! go back to kube-rs' own exec handling.

use std::collections::HashMap;
use std::ffi::OsStr;
use std::fmt;
use std::hash::{Hash, Hasher};
use std::process::{ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use kube::config::{AuthInfo, ExecAuthCluster, ExecConfig, ExecInteractiveMode};
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::sync::{mpsc, watch};
use tracing::{debug, info, warn};

use super::center::{self, AuthErrorInfo, AuthErrorKind, AuthFailure};
use super::classify::command_basename;
use crate::util::lock;

/// Plugin runs in the background (client builds, token refreshes).
pub const BACKGROUND_TIMEOUT: Duration = Duration::from_secs(20);
/// Max ExecCredential size.
pub const STDOUT_LIMIT: usize = 1024 * 1024;
/// Credentials are refreshed this long before they expire.
pub const REFRESH_MARGIN: Duration = Duration::from_secs(60);
/// Lifetime of credentials without an expiration timestamp.
pub const NO_EXPIRY_TTL: Duration = Duration::from_secs(15 * 60);
/// A failed mint is reused this long (one plugin run per burst of requests).
const FAILURE_TTL: Duration = Duration::from_secs(10);
/// ... and this long when the plugin wanted a human: it would only ask again.
const INTERACTION_FAILURE_TTL: Duration = Duration::from_secs(60);
/// Lines longer than this are split.
const MAX_LINE: usize = 16 * 1024;
/// A partial line (a prompt without newline) is passed on after this long.
const PARTIAL_LINE_FLUSH: Duration = Duration::from_millis(300);
/// Stderr kept for error messages.
const STDERR_TAIL: usize = 4096;

/* ------------------------------------------------------------------ flag */

static ENABLED: AtomicBool = AtomicBool::new(true);

/// Whether API clients get exec credentials from the broker (default) or
/// from kube-rs.
pub fn enabled() -> bool {
    ENABLED.load(Ordering::SeqCst)
}

/// Switches the credential broker on (default) or off (kube-rs runs exec
/// plugins itself, the pre-1.42 behaviour). Cached clients and credentials
/// are dropped so the next request uses the selected path.
#[tauri::command]
pub fn auth_set_broker(enabled: bool) {
    let previous = ENABLED.swap(enabled, Ordering::SeqCst);
    if previous != enabled {
        info!("Credential broker {}", if enabled { "enabled" } else { "disabled" });
        invalidate_all();
        crate::kubernetes::client::clear_client_cache();
    }
}

/* ------------------------------------------------------------ credentials */

/// Identifies a credential: the kubeconfig file ("" = default resolution),
/// the kubeconfig user and a hash of the exec spec (command, args, env,
/// apiVersion, cluster).
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct CredentialKey {
    pub kube_config: String,
    pub user: String,
    pub spec: u64,
}

impl CredentialKey {
    /// For an exec config as loaded by `kube::Config` (cluster info filled in
    /// when `provideClusterInfo`).
    pub fn new(kube_config: &str, user: &str, exec: &ExecConfig) -> Self {
        let server = exec.cluster.as_ref().and_then(|c| c.server.as_deref());
        Self::with_server(kube_config, user, exec, server)
    }

    /// For an exec config read straight from a kubeconfig file, where the
    /// cluster info isn't filled in: `server` is the context's cluster.
    pub fn with_server(kube_config: &str, user: &str, exec: &ExecConfig, server: Option<&str>) -> Self {
        CredentialKey {
            kube_config: kube_config.to_string(),
            user: user.to_string(),
            spec: spec_hash(exec, server),
        }
    }
}

/// Hash of what determines a plugin's output. Values (which may be secrets)
/// only ever enter this in-memory hash.
fn spec_hash(exec: &ExecConfig, server: Option<&str>) -> u64 {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    exec.command.hash(&mut hasher);
    exec.args.hash(&mut hasher);
    exec.api_version.hash(&mut hasher);
    for env in exec.env.iter().flatten() {
        env.get("name").hash(&mut hasher);
        env.get("value").hash(&mut hasher);
    }
    exec.provide_cluster_info.hash(&mut hasher);
    if exec.provide_cluster_info {
        server.hash(&mut hasher);
    }
    hasher.finish()
}

/// Credentials minted by a plugin. Never serialized, never logged.
#[derive(Clone)]
pub struct Credential {
    pub token: Option<String>,
    /// PEM.
    pub client_certificate: Option<String>,
    /// PEM.
    pub client_key: Option<String>,
    pub expires_at: Option<SystemTime>,
    pub minted_at: SystemTime,
}

impl fmt::Debug for Credential {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Credential")
            .field("token", &self.token.as_ref().map(|_| "[redacted]"))
            .field("client_certificate", &self.client_certificate.is_some())
            .field("client_key", &self.client_key.as_ref().map(|_| "[redacted]"))
            .field("expires_at", &self.expires_at)
            .field("minted_at", &self.minted_at)
            .finish()
    }
}

impl Credential {
    /// Until when the credential is handed out without asking the plugin.
    pub fn fresh_until(&self) -> SystemTime {
        match self.expires_at {
            Some(expires_at) => expires_at.checked_sub(REFRESH_MARGIN).unwrap_or(UNIX_EPOCH),
            None => self.minted_at + NO_EXPIRY_TTL,
        }
    }

    pub fn is_fresh(&self) -> bool {
        SystemTime::now() < self.fresh_until()
    }

    /// Still accepted by the server (if it expires at all): used when a
    /// refresh fails.
    fn still_usable(&self) -> bool {
        match self.expires_at {
            Some(expires_at) => SystemTime::now() + Duration::from_secs(5) < expires_at,
            None => self.is_fresh(),
        }
    }

    pub fn expires_at_ms(&self) -> Option<i64> {
        self.expires_at.map(system_time_ms)
    }

    pub fn client_identity(&self) -> Option<(&str, &str)> {
        Some((self.client_certificate.as_deref()?, self.client_key.as_deref()?))
    }
}

pub fn system_time_ms(time: SystemTime) -> i64 {
    match time.duration_since(UNIX_EPOCH) {
        Ok(d) => d.as_millis() as i64,
        Err(e) => -(e.duration().as_millis() as i64),
    }
}

#[derive(Deserialize)]
struct RawExecCredential {
    #[serde(rename = "apiVersion")]
    api_version: Option<String>,
    kind: Option<String>,
    status: Option<RawExecStatus>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawExecStatus {
    expiration_timestamp: Option<String>,
    token: Option<String>,
    client_certificate_data: Option<String>,
    client_key_data: Option<String>,
}

/// Parses a plugin's stdout. Errors never quote the output (it holds the
/// credential).
pub fn parse_exec_credential(stdout: &[u8]) -> Result<Credential, String> {
    let raw: RawExecCredential = serde_json::from_slice(stdout.trim_ascii())
        .map_err(|_| "the plugin did not print an ExecCredential (JSON)".to_string())?;
    if raw.kind.as_deref().is_some_and(|kind| kind != "ExecCredential") {
        return Err("the plugin did not print an ExecCredential".to_string());
    }
    if let Some(api_version) = raw.api_version.as_deref() {
        if !api_version.starts_with("client.authentication.k8s.io/") {
            return Err(format!("the plugin printed an unsupported apiVersion ({api_version})"));
        }
    }
    let status = raw.status.ok_or("the ExecCredential has no status")?;
    let non_empty = |value: Option<String>| value.filter(|v| !v.trim().is_empty());
    let token = non_empty(status.token);
    let client_certificate = non_empty(status.client_certificate_data);
    let client_key = non_empty(status.client_key_data);
    if client_certificate.is_some() != client_key.is_some() {
        return Err("the ExecCredential has a client certificate without a key (or a key without a certificate)".to_string());
    }
    if token.is_none() && client_certificate.is_none() {
        return Err("the ExecCredential has neither a token nor a client certificate".to_string());
    }
    let expires_at = match non_empty(status.expiration_timestamp) {
        Some(timestamp) => Some(parse_timestamp(&timestamp).ok_or("the ExecCredential has an invalid expirationTimestamp")?),
        None => None,
    };
    Ok(Credential {
        token,
        client_certificate,
        client_key,
        expires_at,
        minted_at: SystemTime::now(),
    })
}

/// RFC 3339 (and the `...UTC` suffix older aws CLIs write).
pub fn parse_timestamp(value: &str) -> Option<SystemTime> {
    let value = value.trim();
    let parsed = chrono::DateTime::parse_from_rfc3339(value).ok().or_else(|| {
        let value = value.strip_suffix("UTC")?;
        chrono::DateTime::parse_from_rfc3339(&format!("{value}Z")).ok()
    })?;
    let millis = parsed.timestamp_millis();
    if millis >= 0 {
        Some(UNIX_EPOCH + Duration::from_millis(millis as u64))
    } else {
        Some(UNIX_EPOCH - Duration::from_millis(millis.unsigned_abs()))
    }
}

/* ----------------------------------------------------------------- errors */

#[derive(Debug, Clone, PartialEq)]
pub enum BrokerError {
    /// The plugin asked for a browser / device code sign-in.
    InteractionRequired { command: String, message: String },
    /// The plugin reported expired credentials / an expired SSO session.
    Expired { command: String, message: String },
    /// The plugin did not finish in time and was killed.
    Timeout { command: String, after: Duration },
    /// The plugin failed (non-zero exit).
    ExecFailed { command: String, message: String },
    /// The plugin is not installed.
    ExecMissing { command: String, hint: Option<String> },
    /// The plugin's output is not a usable ExecCredential.
    InvalidOutput { command: String, message: String },
}

impl BrokerError {
    pub fn kind(&self) -> AuthErrorKind {
        match self {
            BrokerError::InteractionRequired { .. } => AuthErrorKind::InteractionRequired,
            BrokerError::Expired { .. } => AuthErrorKind::Expired,
            BrokerError::Timeout { .. } => AuthErrorKind::Timeout,
            BrokerError::ExecFailed { .. } | BrokerError::InvalidOutput { .. } => AuthErrorKind::ExecFailed,
            BrokerError::ExecMissing { .. } => AuthErrorKind::ExecMissing,
        }
    }

    pub fn command(&self) -> &str {
        match self {
            BrokerError::InteractionRequired { command, .. }
            | BrokerError::Expired { command, .. }
            | BrokerError::Timeout { command, .. }
            | BrokerError::ExecFailed { command, .. }
            | BrokerError::ExecMissing { command, .. }
            | BrokerError::InvalidOutput { command, .. } => command,
        }
    }

    /// The error as a client failure of `kube_config` / `context`.
    pub fn to_failure(&self, kube_config: &str, context: &str) -> AuthFailure {
        AuthFailure {
            info: AuthErrorInfo {
                kube_config: kube_config.to_string(),
                context: context.to_string(),
                kind: self.kind(),
                command: Some(self.command().to_string()).filter(|c| !c.is_empty()),
            },
            message: self.to_string(),
        }
    }
}

/// Worded like kubectl ("executable aws failed: ...") and mentioning the
/// "exec credential plugin": the frontend's sign-in detection matches both.
impl fmt::Display for BrokerError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            BrokerError::InteractionRequired { command, message } => {
                write!(f, "executable {command} needs an interactive sign-in: the exec credential plugin asked for a browser or device code sign-in")?;
                if !message.is_empty() {
                    write!(f, " ({message})")?;
                }
                Ok(())
            }
            BrokerError::Expired { command, message } => {
                write!(f, "executable {command} failed: the credentials have expired, sign in again. {message}")
            }
            BrokerError::Timeout { command, after } => write!(
                f,
                "executable {command} did not finish within {} s: the exec credential plugin may be waiting for a sign-in",
                after.as_secs().max(1)
            ),
            BrokerError::ExecFailed { command, message } => {
                write!(f, "executable {command} failed: the exec credential plugin failed: {message}")
            }
            BrokerError::ExecMissing { command, hint } => {
                write!(
                    f,
                    "executable {command} not found: the exec credential plugin is not installed or not on PATH"
                )?;
                if let Some(hint) = hint.as_deref().filter(|h| !h.trim().is_empty()) {
                    write!(f, ". {}", hint.trim())?;
                }
                Ok(())
            }
            BrokerError::InvalidOutput { command, message } => {
                write!(f, "executable {command} failed: {message}")
            }
        }
    }
}

impl std::error::Error for BrokerError {}

/* -------------------------------------------------------------- processes */

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum StreamKind {
    Stdout,
    Stderr,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LineVerdict {
    Continue,
    /// Kill the process now (`RunError::Aborted`).
    Abort,
}

pub enum StdoutMode {
    /// Collect stdout (at most `STDOUT_LIMIT`); it never reaches `on_line`.
    Capture,
    /// Pass stdout lines to `on_line`.
    Lines,
}

pub struct RunOptions<'a> {
    pub timeout: Duration,
    pub stdout: StdoutMode,
    pub on_line: &'a mut (dyn FnMut(StreamKind, &str) -> LineVerdict + Send),
    /// Kills the process when it becomes true.
    pub cancel: Option<watch::Receiver<bool>>,
    /// Receives the pid once the process runs (app-exit cleanup).
    pub pid: Option<Arc<Mutex<Option<u32>>>>,
}

pub struct ProcessRun {
    pub status: ExitStatus,
    /// Empty unless `StdoutMode::Capture`.
    pub stdout: Vec<u8>,
    /// The end of stderr (raw, redact before showing).
    pub stderr_tail: String,
}

#[derive(Debug, Clone, PartialEq)]
pub enum RunError {
    NotFound,
    Start(String),
    Timeout,
    /// `on_line` aborted on this line.
    Aborted(String),
    Cancelled,
    StdoutTooLarge,
}

/// A command with stdin closed, stdout / stderr piped, `kill_on_drop`, no
/// console window on Windows and its own process group on unix (so the
/// whole tree can be killed).
pub fn spawnable(program: impl AsRef<OsStr>) -> tokio::process::Command {
    // tokio's own `process_group` is unstable: set it on the std command.
    let mut std_cmd = std::process::Command::new(program);
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        std_cmd.process_group(0);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        std_cmd.creation_flags(crate::process::CREATE_NO_WINDOW);
    }
    let mut cmd = tokio::process::Command::from(std_cmd);
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    cmd
}

/// Kills a process and its children: the process group on unix (the
/// process leads its own, see `spawnable`), `taskkill /T` on Windows.
pub fn kill_tree(pid: u32) {
    #[cfg(unix)]
    {
        if let Ok(pgid) = libc::pid_t::try_from(pid) {
            if pgid > 0 {
                // SAFETY: plain syscall; pgid is the group of a child we
                // spawned and have not reaped yet.
                unsafe {
                    libc::killpg(pgid, libc::SIGKILL);
                }
            }
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let _ = std::process::Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .creation_flags(crate::process::CREATE_NO_WINDOW)
            .spawn();
    }
}

/// Kills the process tree on drop unless disarmed (the process finished).
struct TreeGuard {
    pid: Option<u32>,
    armed: bool,
}

impl Drop for TreeGuard {
    fn drop(&mut self) {
        if self.armed {
            if let Some(pid) = self.pid {
                kill_tree(pid);
            }
        }
    }
}

async fn read_capped(mut reader: impl AsyncRead + Unpin, limit: usize) -> Result<Vec<u8>, RunError> {
    let mut out = Vec::new();
    let mut buf = [0u8; 8192];
    loop {
        match reader.read(&mut buf).await {
            Ok(0) | Err(_) => return Ok(out),
            Ok(n) => {
                if out.len() + n > limit {
                    return Err(RunError::StdoutTooLarge);
                }
                out.extend_from_slice(&buf[..n]);
            }
        }
    }
}

/// Splits a stream into lines (`\n` / `\r`). A partial line that sits
/// there for `PARTIAL_LINE_FLUSH` (a prompt) is passed on as well.
async fn read_lines(
    mut reader: impl AsyncRead + Unpin,
    kind: StreamKind,
    tx: mpsc::Sender<(StreamKind, String)>,
) -> Result<(), RunError> {
    let mut buf = [0u8; 4096];
    let mut partial: Vec<u8> = Vec::new();
    loop {
        let read = if partial.is_empty() {
            reader.read(&mut buf).await
        } else {
            tokio::select! {
                read = reader.read(&mut buf) => read,
                _ = tokio::time::sleep(PARTIAL_LINE_FLUSH) => {
                    let line = String::from_utf8_lossy(&std::mem::take(&mut partial)).into_owned();
                    if tx.send((kind, line)).await.is_err() {
                        return Ok(());
                    }
                    continue;
                }
            }
        };
        let n = match read {
            Ok(0) | Err(_) => break,
            Ok(n) => n,
        };
        for &byte in &buf[..n] {
            if byte == b'\n' || byte == b'\r' || partial.len() >= MAX_LINE {
                if !partial.is_empty() {
                    let line = String::from_utf8_lossy(&std::mem::take(&mut partial)).into_owned();
                    if tx.send((kind, line)).await.is_err() {
                        return Ok(());
                    }
                }
                if byte == b'\n' || byte == b'\r' {
                    continue;
                }
            }
            partial.push(byte);
        }
    }
    if !partial.is_empty() {
        let _ = tx.send((kind, String::from_utf8_lossy(&partial).into_owned())).await;
    }
    Ok(())
}

async fn cancelled(cancel: Option<watch::Receiver<bool>>) {
    let Some(mut cancel) = cancel else {
        return std::future::pending().await;
    };
    loop {
        if *cancel.borrow_and_update() {
            return;
        }
        if cancel.changed().await.is_err() {
            return std::future::pending().await;
        }
    }
}

/// Runs `cmd` (see `spawnable`): lines go to `on_line` one at a time (stderr,
/// and stdout with `StdoutMode::Lines`). On timeout, cancellation, an
/// aborting line or oversized stdout the whole process tree is killed.
pub async fn run_process(mut cmd: tokio::process::Command, options: RunOptions<'_>) -> Result<ProcessRun, RunError> {
    let RunOptions {
        timeout,
        stdout: stdout_mode,
        on_line,
        cancel,
        pid,
    } = options;

    let mut child = cmd.spawn().map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => RunError::NotFound,
        _ => RunError::Start(e.to_string()),
    })?;
    let mut guard = TreeGuard {
        pid: child.id(),
        armed: true,
    };
    if let Some(slot) = &pid {
        *lock(slot) = child.id();
    }
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    let (tx, mut rx) = mpsc::channel::<(StreamKind, String)>(64);
    let stdout_tx = tx.clone();
    let stdout_task = async move {
        match (stdout, stdout_mode) {
            (None, _) => Ok(Vec::new()),
            (Some(stdout), StdoutMode::Capture) => {
                drop(stdout_tx);
                read_capped(stdout, STDOUT_LIMIT).await
            }
            (Some(stdout), StdoutMode::Lines) => read_lines(stdout, StreamKind::Stdout, stdout_tx).await.map(|_| Vec::new()),
        }
    };
    let stderr_task = async move {
        match stderr {
            Some(stderr) => read_lines(stderr, StreamKind::Stderr, tx).await,
            None => Ok(()),
        }
    };
    let mut stderr_tail = String::new();
    let consume = async {
        while let Some((kind, line)) = rx.recv().await {
            if kind == StreamKind::Stderr {
                stderr_tail.push_str(&line);
                stderr_tail.push('\n');
                if stderr_tail.len() > STDERR_TAIL {
                    let mut cut = stderr_tail.len() - STDERR_TAIL;
                    while !stderr_tail.is_char_boundary(cut) {
                        cut += 1;
                    }
                    stderr_tail.drain(..cut);
                }
            }
            if on_line(kind, &line) == LineVerdict::Abort {
                return Err(RunError::Aborted(line));
            }
        }
        Ok(())
    };

    let work = async {
        let (stdout, (), ()) = tokio::try_join!(stdout_task, stderr_task, consume)?;
        let status = child.wait().await.map_err(|e| RunError::Start(e.to_string()))?;
        Ok::<_, RunError>((stdout, status))
    };
    let result = tokio::select! {
        result = tokio::time::timeout(timeout, work) => match result {
            Ok(result) => result,
            Err(_) => Err(RunError::Timeout),
        },
        () = cancelled(cancel) => Err(RunError::Cancelled),
    };
    if let Some(slot) = &pid {
        *lock(slot) = None;
    }
    let (stdout, status) = result?;
    guard.armed = false;
    Ok(ProcessRun {
        status,
        stdout,
        stderr_tail,
    })
}

/* ---------------------------------------------------------------- minting */

/// `KUBERNETES_EXEC_INFO` for a plugin run.
pub fn exec_info(exec: &ExecConfig, interactive: bool) -> Result<String, String> {
    let api_version = exec
        .api_version
        .clone()
        .unwrap_or_else(|| "client.authentication.k8s.io/v1beta1".to_string());
    let mut spec = serde_json::Map::new();
    spec.insert("interactive".into(), interactive.into());
    if exec.provide_cluster_info {
        let cluster: &ExecAuthCluster = exec
            .cluster
            .as_ref()
            .ok_or("the kubeconfig asks to provide cluster info, but the cluster is missing")?;
        spec.insert(
            "cluster".into(),
            serde_json::to_value(cluster).map_err(|e| e.to_string())?,
        );
    }
    Ok(serde_json::json!({
        "apiVersion": api_version,
        "kind": "ExecCredential",
        "spec": spec,
    })
    .to_string())
}

/// Display name of an exec plugin (basename, never args or env).
pub fn display_command(exec: &ExecConfig) -> String {
    exec.command.as_deref().map(command_basename).unwrap_or_default()
}

/// The plugin as a command (see `spawnable`) with its args, env and
/// `KUBERNETES_EXEC_INFO`.
pub fn plugin_command(exec: &ExecConfig, interactive: bool) -> Result<tokio::process::Command, BrokerError> {
    let command = display_command(exec);
    let program = exec
        .command
        .as_deref()
        .filter(|c| !c.trim().is_empty())
        .ok_or_else(|| BrokerError::ExecFailed {
            command: command.clone(),
            message: "the kubeconfig exec config has no command".to_string(),
        })?;
    let info = exec_info(exec, interactive).map_err(|message| BrokerError::ExecFailed {
        command: command.clone(),
        message,
    })?;
    let mut cmd = spawnable(program);
    if let Some(args) = &exec.args {
        cmd.args(args);
    }
    for env in exec.env.iter().flatten() {
        if let (Some(name), Some(value)) = (env.get("name"), env.get("value")) {
            cmd.env(name, value);
        }
    }
    cmd.env("KUBERNETES_EXEC_INFO", info);
    for name in exec.drop_env.iter().flatten() {
        cmd.env_remove(name);
    }
    Ok(cmd)
}

/// A failed plugin run (non-zero exit) as a broker error.
pub fn failure_from_stderr(command: &str, status: ExitStatus, stderr: &str) -> BrokerError {
    let detail = center::redact(stderr.trim());
    let detail = if detail.is_empty() {
        match status.code() {
            Some(code) => format!("exit code {code}"),
            None => "terminated by a signal".to_string(),
        }
    } else {
        detail
    };
    match center::detect_kubectl_auth_failure(stderr) {
        Some(AuthErrorKind::InteractionRequired) => BrokerError::InteractionRequired {
            command: command.to_string(),
            message: detail,
        },
        Some(AuthErrorKind::Expired) => BrokerError::Expired {
            command: command.to_string(),
            message: detail,
        },
        _ => BrokerError::ExecFailed {
            command: command.to_string(),
            message: detail,
        },
    }
}

/// Credentials of clusters added in JET Pilot (`jetpilot-auth` exec
/// entries) come straight from the vault, in-process: spawning the helper
/// would need the vault unlocked "for terminals" in passphrase mode.
async fn mint_helper(
    request: jp_auth_core::request::Request,
    exec: &ExecConfig,
    timeout: Duration,
) -> Option<Result<Credential, BrokerError>> {
    use jp_auth_core::request::Request;
    let command = display_command(exec);
    let vault_error = |e: crate::clusters::error::AppError| BrokerError::ExecFailed {
        command: command.clone(),
        message: e.message,
    };
    match request {
        Request::CredentialStatic { id } => Some(match crate::secrets::static_credential(&id) {
            Ok(Some(stored)) => Ok(Credential {
                token: stored.token.clone(),
                client_certificate: stored.client_certificate_pem.clone(),
                client_key: stored.client_key_pem.clone(),
                expires_at: None,
                minted_at: SystemTime::now(),
            }),
            Ok(None) => Err(BrokerError::ExecFailed {
                command: command.clone(),
                message: "JET Pilot has no stored credentials for this cluster; add it again".to_string(),
            }),
            Err(e) => Err(vault_error(e)),
        }),
        Request::CredentialWrapExec { id, command: inner_command, args } => {
            let secrets = match crate::secrets::env_secrets(&id) {
                Ok(secrets) => secrets.unwrap_or_default(),
                Err(e) => return Some(Err(vault_error(e))),
            };
            let mut inner = exec.clone();
            inner.command = Some(inner_command);
            inner.args = Some(args);
            let mut env = inner.env.take().unwrap_or_default();
            for (name, value) in secrets.iter() {
                env.push(std::collections::HashMap::from([
                    ("name".to_string(), name.clone()),
                    ("value".to_string(), value.clone()),
                ]));
            }
            inner.env = Some(env);
            Some(Box::pin(mint(&inner, timeout)).await)
        }
        _ => None,
    }
}

/// Runs the plugin non-interactively and parses its credential.
pub async fn mint(exec: &ExecConfig, timeout: Duration) -> Result<Credential, BrokerError> {
    if let Some(request) = crate::clusters::managed_kubeconfig::helper_request(exec) {
        if let Some(result) = mint_helper(request, exec, timeout).await {
            return result;
        }
    }
    let command = display_command(exec);
    if exec.interactive_mode == Some(ExecInteractiveMode::Always) {
        return Err(BrokerError::InteractionRequired {
            command,
            message: "the kubeconfig marks it as always interactive".to_string(),
        });
    }
    let cmd = plugin_command(exec, false)?;
    let mut on_line = |_: StreamKind, line: &str| {
        if center::looks_interactive(line) {
            LineVerdict::Abort
        } else {
            LineVerdict::Continue
        }
    };
    let started = Instant::now();
    let run = run_process(
        cmd,
        RunOptions {
            timeout,
            stdout: StdoutMode::Capture,
            on_line: &mut on_line,
            cancel: None,
            pid: None,
        },
    )
    .await;
    debug!("Exec plugin {} ran for {:?}", command, started.elapsed());
    match run {
        Ok(run) if run.status.success() => {
            parse_exec_credential(&run.stdout).map_err(|message| BrokerError::InvalidOutput { command, message })
        }
        Ok(run) => Err(failure_from_stderr(&command, run.status, &run.stderr_tail)),
        Err(RunError::NotFound) => Err(BrokerError::ExecMissing {
            command,
            hint: exec.install_hint.clone(),
        }),
        Err(RunError::Timeout) => Err(BrokerError::Timeout { command, after: timeout }),
        Err(RunError::Aborted(line)) => Err(BrokerError::InteractionRequired {
            command,
            message: center::redact(line.trim()),
        }),
        Err(RunError::StdoutTooLarge) => Err(BrokerError::InvalidOutput {
            command,
            message: "the plugin printed more than 1 MiB".to_string(),
        }),
        Err(RunError::Start(message)) => Err(BrokerError::ExecFailed { command, message }),
        Err(RunError::Cancelled) => Err(BrokerError::ExecFailed {
            command,
            message: "cancelled".to_string(),
        }),
    }
}

/* ------------------------------------------------------------------ cache */

#[derive(Default)]
struct SlotState {
    credential: Option<Credential>,
    failure: Option<(BrokerError, Instant)>,
}

/// The cache entry of one credential. Clients hold on to their slot, so
/// invalidating clears it in place.
#[derive(Default)]
pub struct Slot {
    state: Mutex<SlotState>,
    /// Held while the plugin runs: concurrent requests wait for that run.
    minting: tokio::sync::Mutex<()>,
}

/// What the credential status may know about a cached credential.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct CredentialMeta {
    pub expires_at: Option<SystemTime>,
    pub minted_at: SystemTime,
    pub fresh: bool,
}

impl Slot {
    pub fn fresh(&self) -> Option<Credential> {
        lock(&self.state).credential.as_ref().filter(|c| c.is_fresh()).cloned()
    }

    fn recent_failure(&self) -> Option<BrokerError> {
        let state = lock(&self.state);
        let (error, at) = state.failure.as_ref()?;
        let ttl = match error {
            BrokerError::InteractionRequired { .. } => INTERACTION_FAILURE_TTL,
            _ => FAILURE_TTL,
        };
        (at.elapsed() < ttl).then(|| error.clone())
    }

    /// The credential while the server still accepts it (due for a
    /// refresh or not).
    fn usable(&self) -> Option<Credential> {
        lock(&self.state).credential.as_ref().filter(|c| c.still_usable()).cloned()
    }

    /// Records a failed refresh. Returns the previous credential when the
    /// server still accepts it.
    fn record_failure(&self, error: BrokerError) -> Option<Credential> {
        lock(&self.state).failure = Some((error, Instant::now()));
        self.usable()
    }

    pub fn store(&self, credential: Credential) {
        let mut state = lock(&self.state);
        state.credential = Some(credential);
        state.failure = None;
    }

    /// Forgets the credential and any recorded failure.
    pub fn clear(&self) {
        let mut state = lock(&self.state);
        state.credential = None;
        state.failure = None;
    }

    /// Forgets the credential when it was minted more than `min_age` ago
    /// (after the server rejected it: a fresh one is not re-minted on every
    /// rejected request).
    pub fn clear_if_older(&self, min_age: Duration) -> bool {
        let mut state = lock(&self.state);
        let stale = state
            .credential
            .as_ref()
            .is_some_and(|c| c.minted_at.elapsed().unwrap_or_default() >= min_age);
        if stale {
            state.credential = None;
        }
        stale
    }

    pub fn meta(&self) -> Option<CredentialMeta> {
        lock(&self.state).credential.as_ref().map(|c| CredentialMeta {
            expires_at: c.expires_at,
            minted_at: c.minted_at,
            fresh: c.is_fresh(),
        })
    }
}

static SLOTS: Lazy<Mutex<HashMap<CredentialKey, Arc<Slot>>>> = Lazy::new(|| Mutex::new(HashMap::new()));

/// The cache slot of `key` (created when missing).
pub fn slot(key: &CredentialKey) -> Arc<Slot> {
    lock(&SLOTS).entry(key.clone()).or_default().clone()
}

/// The cached credential's metadata, without creating a slot.
pub fn cached_meta(key: &CredentialKey) -> Option<CredentialMeta> {
    let slot = lock(&SLOTS).get(key).cloned()?;
    slot.meta()
}

/// The credential of `key`: cached, or minted by running the plugin
/// (background mode, 20 s).
pub async fn credential(key: &CredentialKey, exec: &ExecConfig) -> Result<Credential, BrokerError> {
    credential_in(&slot(key), exec, BACKGROUND_TIMEOUT).await
}

/// `credential` for a slot. Concurrent callers share one plugin run.
pub async fn credential_in(slot: &Slot, exec: &ExecConfig, timeout: Duration) -> Result<Credential, BrokerError> {
    if let Some(credential) = slot.fresh() {
        return Ok(credential);
    }
    let _minting = slot.minting.lock().await;
    // Minted by the caller we waited for.
    if let Some(credential) = slot.fresh() {
        return Ok(credential);
    }
    if let Some(error) = slot.recent_failure() {
        return slot.usable().ok_or(error);
    }
    match mint(exec, timeout).await {
        Ok(credential) => {
            slot.store(credential.clone());
            Ok(credential)
        }
        Err(error) => {
            warn!("Exec plugin {} failed: {:?}", error.command(), error.kind());
            match slot.record_failure(error.clone()) {
                Some(previous) => Ok(previous),
                None => Err(error),
            }
        }
    }
}

/// Clears the slots whose key matches. Returns how many were cleared.
pub fn invalidate(matches: impl Fn(&CredentialKey) -> bool) -> usize {
    let slots: Vec<Arc<Slot>> = lock(&SLOTS)
        .iter()
        .filter(|(key, _)| matches(key))
        .map(|(_, slot)| slot.clone())
        .collect();
    for slot in &slots {
        slot.clear();
    }
    slots.len()
}

pub fn invalidate_all() {
    invalidate(|_| true);
}

/* --------------------------------------------------------- client support */

/// Whether kube-rs would run the exec plugin of `auth` (it doesn't when an
/// auth provider, basic auth or a token wins).
pub fn uses_exec(auth: &AuthInfo) -> bool {
    auth.exec.is_some()
        && auth.auth_provider.is_none()
        && !(auth.username.is_some() && auth.password.is_some())
        && auth.token.is_none()
        && auth.token_file.is_none()
}

/// Takes the exec config kube-rs would run out of `auth`, so building the
/// client never runs it.
pub fn take_exec(auth: &mut AuthInfo) -> Option<ExecConfig> {
    if uses_exec(auth) {
        auth.exec.take()
    } else {
        None
    }
}

/// Puts a minted client certificate into `auth` (kube-rs then uses it as the
/// TLS identity). Returns the client's `valid_until`.
pub fn apply_client_certificate(auth: &mut AuthInfo, credential: &Credential) -> Option<k8s_openapi::jiff::Timestamp> {
    use base64::Engine;
    let (certificate, key) = credential.client_identity()?;
    let encode = |pem: &str| base64::engine::general_purpose::STANDARD.encode(pem.as_bytes());
    auth.client_certificate = None;
    auth.client_key = None;
    auth.client_certificate_data = Some(encode(certificate));
    auth.client_key_data = Some(encode(key).into());
    let expires_at = credential.expires_at?;
    k8s_openapi::jiff::Timestamp::from_millisecond(system_time_ms(expires_at)).ok()
}

#[cfg(all(test, unix))]
pub(crate) mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    use std::path::{Path, PathBuf};

    pub const TEST_CERT: &str = "-----BEGIN CERTIFICATE-----
MIIBhzCCAS2gAwIBAgIUOrS+sgTIWrd/hAXe4UxQrhHc9OMwCgYIKoZIzj0EAwIw
GTEXMBUGA1UEAwwOamV0LXBpbG90LXRlc3QwHhcNMjUwMTAxMDAwMDAwWhcNMzAw
MTAxMDAwMDAwWjAZMRcwFQYDVQQDDA5qZXQtcGlsb3QtdGVzdDBZMBMGByqGSM49
AgEGCCqGSM49AwEHA0IABCxPFjRZeT9KYTmv/fPTjJq0fUdSLVs14eCaRBcY0Ikd
CCxkoquo5P8QRdnDuytGmpwd7QUbm04XSgEo73yh9tKjUzBRMB0GA1UdDgQWBBTx
J2AUjmTMCNZS2gdswKAE/+uJyjAfBgNVHSMEGDAWgBTxJ2AUjmTMCNZS2gdswKAE
/+uJyjAPBgNVHRMBAf8EBTADAQH/MAoGCCqGSM49BAMCA0gAMEUCIBBf6BAu0HjU
mzSEC27qsiodM9vwCUOhXwczup/MMsQMAiEAz/eV+M7juzawEwVcyA+p2fT+DYp4
ES5J8EfC6QB0T5U=
-----END CERTIFICATE-----
";
    /// Throwaway key of `TEST_CERT` (generated for these tests only).
    pub const TEST_KEY: &str = "-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgFbMNr/4EPc4voDdl
6JFRukpPqxryOgbaXfw/iUT87DOhRANCAAQsTxY0WXk/SmE5r/3z04yatH1HUi1b
NeHgmkQXGNCJHQgsZKKrqOT/EEXZw7srRpqcHe0FG5tOF0oBKO98ofbS
-----END PRIVATE KEY-----
";

    /// Writes an executable shell script.
    pub fn script(dir: &Path, name: &str, body: &str) -> PathBuf {
        let path = dir.join(name);
        std::fs::write(&path, format!("#!/bin/sh\n{body}")).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        path
    }

    pub fn token_credential(token: &str, expires_in: Option<i64>) -> String {
        let expiry = expires_in
            .map(|secs| {
                let at = chrono::Utc::now() + chrono::Duration::seconds(secs);
                format!(r#","expirationTimestamp":"{}""#, at.to_rfc3339_opts(chrono::SecondsFormat::Secs, true))
            })
            .unwrap_or_default();
        format!(
            r#"{{"apiVersion":"client.authentication.k8s.io/v1beta1","kind":"ExecCredential","status":{{"token":"{token}"{expiry}}}}}"#
        )
    }

    pub fn exec_for(command: &Path, env: &[(&str, &str)]) -> ExecConfig {
        ExecConfig {
            api_version: Some("client.authentication.k8s.io/v1beta1".into()),
            command: Some(command.to_string_lossy().into_owned()),
            args: Some(vec![]),
            env: Some(
                env.iter()
                    .map(|(name, value)| {
                        HashMap::from([
                            ("name".to_string(), name.to_string()),
                            ("value".to_string(), value.to_string()),
                        ])
                    })
                    .collect(),
            ),
            ..Default::default()
        }
    }

    fn runs(counter: &Path) -> usize {
        std::fs::read_to_string(counter).map(|s| s.lines().count()).unwrap_or(0)
    }

    #[tokio::test]
    async fn ok_token_plugin_gets_exec_info_and_env() {
        let dir = tempfile::tempdir().unwrap();
        let info = dir.path().join("info");
        let plugin = script(
            dir.path(),
            "plugin",
            &format!(
                "printf '%s' \"$KUBERNETES_EXEC_INFO\" > '{}'\necho \"profile=$AWS_PROFILE\" >&2\necho '{}'\n",
                info.display(),
                token_credential("tok-1", Some(3600))
            ),
        );
        let exec = exec_for(&plugin, &[("AWS_PROFILE", "dev")]);
        let credential = mint(&exec, Duration::from_secs(10)).await.unwrap();
        assert_eq!(credential.token.as_deref(), Some("tok-1"));
        let expires = credential.expires_at.unwrap();
        assert!(expires > SystemTime::now() + Duration::from_secs(3500));
        assert!(credential.is_fresh());

        let info: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(info).unwrap()).unwrap();
        assert_eq!(info["spec"]["interactive"], false);
        assert_eq!(info["kind"], "ExecCredential");
        assert_eq!(info["apiVersion"], "client.authentication.k8s.io/v1beta1");
        assert!(info["spec"].get("cluster").is_none());
    }

    #[tokio::test]
    async fn v1_credentials_and_cluster_info() {
        let dir = tempfile::tempdir().unwrap();
        let info = dir.path().join("info");
        let plugin = script(
            dir.path(),
            "plugin",
            &format!(
                "printf '%s' \"$KUBERNETES_EXEC_INFO\" > '{}'\necho '{{\"apiVersion\":\"client.authentication.k8s.io/v1\",\"kind\":\"ExecCredential\",\"status\":{{\"token\":\"v1-token\"}}}}'\n",
                info.display()
            ),
        );
        let mut exec = exec_for(&plugin, &[]);
        exec.api_version = Some("client.authentication.k8s.io/v1".into());
        exec.provide_cluster_info = true;
        exec.cluster = Some(ExecAuthCluster {
            server: Some("https://k8s.example:6443".into()),
            ..Default::default()
        });
        let credential = mint(&exec, Duration::from_secs(10)).await.unwrap();
        assert_eq!(credential.token.as_deref(), Some("v1-token"));
        assert_eq!(credential.expires_at, None);

        let info: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(info).unwrap()).unwrap();
        assert_eq!(info["apiVersion"], "client.authentication.k8s.io/v1");
        assert_eq!(info["spec"]["cluster"]["server"], "https://k8s.example:6443");
    }

    #[tokio::test]
    async fn slow_plugin_times_out() {
        let dir = tempfile::tempdir().unwrap();
        let plugin = script(dir.path(), "slow", "sleep 30\n");
        let started = Instant::now();
        let err = mint(&exec_for(&plugin, &[]), Duration::from_millis(300)).await.unwrap_err();
        assert!(matches!(err, BrokerError::Timeout { .. }), "{err:?}");
        assert_eq!(err.kind(), AuthErrorKind::Timeout);
        assert!(started.elapsed() < Duration::from_secs(5));
    }

    #[cfg(target_os = "linux")]
    fn alive(pid: &str) -> bool {
        let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).unwrap_or_default();
        let state = stat.rsplit(')').next().unwrap_or("").split_whitespace().next();
        !matches!(state, None | Some("Z") | Some("X"))
    }

    #[tokio::test]
    async fn device_code_prompt_kills_the_plugin_and_its_children() {
        let dir = tempfile::tempdir().unwrap();
        let pids = dir.path().join("pids");
        let plugin = script(
            dir.path(),
            "kubelogin",
            &format!(
                "sleep 300 &\necho $! > '{}'\necho 'To sign in, use a web browser to open the page https://microsoft.com/devicelogin and enter the code ABCD12345 to authenticate.' >&2\nsleep 300\n",
                pids.display()
            ),
        );
        let started = Instant::now();
        let err = mint(&exec_for(&plugin, &[]), Duration::from_secs(20)).await.unwrap_err();
        assert!(matches!(err, BrokerError::InteractionRequired { .. }), "{err:?}");
        assert!(started.elapsed() < Duration::from_secs(5), "killed early, not at the timeout");
        assert!(err.to_string().contains("devicelogin"), "{err}");

        #[cfg(target_os = "linux")]
        {
            let child = std::fs::read_to_string(&pids).unwrap();
            let child = child.trim();
            let deadline = Instant::now() + Duration::from_secs(5);
            while alive(child) && Instant::now() < deadline {
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
            assert!(!alive(child), "the plugin's child process survived");
        }
    }

    #[tokio::test]
    async fn prompt_without_newline_is_detected() {
        let dir = tempfile::tempdir().unwrap();
        let plugin = script(
            dir.path(),
            "oidc",
            "printf 'Please visit the following URL in your browser: http://localhost:8000' >&2\nsleep 300\n",
        );
        let started = Instant::now();
        let err = mint(&exec_for(&plugin, &[]), Duration::from_secs(20)).await.unwrap_err();
        assert_eq!(err.kind(), AuthErrorKind::InteractionRequired);
        assert!(started.elapsed() < Duration::from_secs(5));
    }

    #[tokio::test]
    async fn failing_plugins_are_classified() {
        let dir = tempfile::tempdir().unwrap();
        let sso = script(
            dir.path(),
            "aws",
            "echo 'Error loading SSO Token: Token for prod-admin does not exist' >&2\nexit 255\n",
        );
        let err = mint(&exec_for(&sso, &[]), Duration::from_secs(10)).await.unwrap_err();
        assert_eq!(err.kind(), AuthErrorKind::Expired);
        let message = err.to_string();
        // The frontend's AWS SSO detection keys on these.
        assert!(message.contains("executable aws failed"), "{message}");
        assert!(message.contains("Error loading SSO Token"), "{message}");

        let boom = script(
            dir.path(),
            "boom",
            "echo 'something broke token=s3cr3t-value' >&2\necho '{\"status\":{\"token\":\"leaked\"}}'\nexit 1\n",
        );
        let err = mint(&exec_for(&boom, &[]), Duration::from_secs(10)).await.unwrap_err();
        assert_eq!(err.kind(), AuthErrorKind::ExecFailed);
        let message = err.to_string();
        assert!(message.contains("something broke"), "{message}");
        assert!(!message.contains("s3cr3t-value"), "{message}");
        assert!(!message.contains("leaked"), "stdout never shows: {message}");

        let garbage = script(dir.path(), "garbage", "echo 'not json token=abc'\n");
        let err = mint(&exec_for(&garbage, &[]), Duration::from_secs(10)).await.unwrap_err();
        assert!(matches!(err, BrokerError::InvalidOutput { .. }), "{err:?}");
        assert!(!err.to_string().contains("abc"));

        let mut missing = exec_for(&dir.path().join("not-installed"), &[]);
        missing.install_hint = Some("brew install not-installed".into());
        let err = mint(&missing, Duration::from_secs(10)).await.unwrap_err();
        assert_eq!(err.kind(), AuthErrorKind::ExecMissing);
        assert!(err.to_string().contains("brew install not-installed"));

        let mut always = exec_for(&boom, &[]);
        always.interactive_mode = Some(ExecInteractiveMode::Always);
        let err = mint(&always, Duration::from_secs(10)).await.unwrap_err();
        assert_eq!(err.kind(), AuthErrorKind::InteractionRequired);
    }

    #[tokio::test]
    async fn client_certificate_credentials() {
        let dir = tempfile::tempdir().unwrap();
        let body = serde_json::json!({
            "apiVersion": "client.authentication.k8s.io/v1beta1",
            "kind": "ExecCredential",
            "status": {
                "clientCertificateData": TEST_CERT,
                "clientKeyData": TEST_KEY,
                "expirationTimestamp": "2030-01-01T00:00:00Z"
            }
        });
        let json = dir.path().join("cred.json");
        std::fs::write(&json, body.to_string()).unwrap();
        let plugin = script(dir.path(), "certs", &format!("cat '{}'\n", json.display()));
        let credential = mint(&exec_for(&plugin, &[]), Duration::from_secs(10)).await.unwrap();
        assert_eq!(credential.token, None);
        let (cert, key) = credential.client_identity().unwrap();
        assert!(cert.contains("BEGIN CERTIFICATE"));
        assert!(key.contains("BEGIN PRIVATE KEY"));
        assert!(!format!("{credential:?}").contains("MIGHAgEA"), "Debug never prints the key");

        let mut auth = AuthInfo::default();
        let valid_until = apply_client_certificate(&mut auth, &credential).unwrap();
        assert_eq!(valid_until.as_second(), 1_893_456_000);
        assert!(auth.client_certificate_data.is_some());
        assert!(auth.client_key_data.is_some());
    }

    #[test]
    fn exec_credentials_are_validated() {
        assert!(parse_exec_credential(br#"{"kind":"ExecCredential","status":{"token":"t"}}"#).is_ok());
        assert!(parse_exec_credential(br#"{"kind":"Other","status":{"token":"t"}}"#).is_err());
        assert!(parse_exec_credential(br#"{"apiVersion":"v1","status":{"token":"t"}}"#).is_err());
        assert!(parse_exec_credential(br#"{"kind":"ExecCredential"}"#).is_err());
        assert!(parse_exec_credential(br#"{"kind":"ExecCredential","status":{}}"#).is_err());
        assert!(parse_exec_credential(br#"{"kind":"ExecCredential","status":{"clientCertificateData":"c"}}"#).is_err());
        let err = parse_exec_credential(br#"{"kind":"ExecCredential","status":{"token":"t","expirationTimestamp":"tomorrow"}}"#).unwrap_err();
        assert!(!err.contains("tomorrow") || err.contains("invalid"));
        assert!(parse_timestamp("2021-05-03T18:52:40UTC").is_some());
        assert!(parse_timestamp("2021-05-03T18:52:40Z").is_some());
        assert!(parse_timestamp("2021-05-03T18:52:40+02:00").is_some());
    }

    #[tokio::test]
    async fn concurrent_requests_share_one_plugin_run() {
        let dir = tempfile::tempdir().unwrap();
        let counter = dir.path().join("runs");
        let plugin = script(
            dir.path(),
            "plugin",
            &format!("echo run >> '{}'\nsleep 0.3\necho '{}'\n", counter.display(), token_credential("shared", Some(3600))),
        );
        let exec = exec_for(&plugin, &[]);
        let key = CredentialKey::new("/broker-test/single-flight", "u", &exec);
        let results = futures::future::join_all((0..6).map(|_| credential(&key, &exec))).await;
        assert!(results.iter().all(|r| r.as_ref().unwrap().token.as_deref() == Some("shared")));
        assert_eq!(runs(&counter), 1);

        // Cached afterwards.
        credential(&key, &exec).await.unwrap();
        assert_eq!(runs(&counter), 1);
        assert!(cached_meta(&key).unwrap().fresh);

        // Invalidated: minted again.
        assert_eq!(invalidate(|k| k == &key), 1);
        credential(&key, &exec).await.unwrap();
        assert_eq!(runs(&counter), 2);
    }

    #[tokio::test]
    async fn expiry_decides_caching() {
        let dir = tempfile::tempdir().unwrap();
        let counter = dir.path().join("runs");
        // Expires within the refresh margin: never cached.
        let soon = script(
            dir.path(),
            "soon",
            &format!("echo run >> '{}'\necho '{}'\n", counter.display(), token_credential("soon", Some(30))),
        );
        let exec = exec_for(&soon, &[]);
        let key = CredentialKey::new("/broker-test/expiry", "u", &exec);
        credential(&key, &exec).await.unwrap();
        credential(&key, &exec).await.unwrap();
        assert_eq!(runs(&counter), 2);

        // No expiry: cached for 15 minutes.
        let counter = dir.path().join("runs-forever");
        let forever = script(
            dir.path(),
            "forever",
            &format!("echo run >> '{}'\necho '{}'\n", counter.display(), token_credential("forever", None)),
        );
        let exec = exec_for(&forever, &[]);
        let key = CredentialKey::new("/broker-test/expiry", "u", &exec);
        let first = credential(&key, &exec).await.unwrap();
        credential(&key, &exec).await.unwrap();
        assert_eq!(runs(&counter), 1);
        let fresh_for = first.fresh_until().duration_since(SystemTime::now()).unwrap();
        assert!(fresh_for > Duration::from_secs(14 * 60) && fresh_for <= NO_EXPIRY_TTL);
    }

    #[tokio::test]
    async fn failures_are_reused_briefly_and_valid_tokens_survive_them() {
        let dir = tempfile::tempdir().unwrap();
        let counter = dir.path().join("runs");
        let plugin = script(
            dir.path(),
            "failing",
            &format!("echo run >> '{}'\necho 'nope' >&2\nexit 1\n", counter.display()),
        );
        let exec = exec_for(&plugin, &[]);
        let key = CredentialKey::new("/broker-test/failure", "u", &exec);
        assert!(credential(&key, &exec).await.is_err());
        assert!(credential(&key, &exec).await.is_err());
        assert_eq!(runs(&counter), 1, "a failure is cached for a few seconds");

        // A still valid (but due for refresh) token is used when the refresh fails.
        let slot = slot(&key);
        slot.store(Credential {
            token: Some("old".into()),
            client_certificate: None,
            client_key: None,
            expires_at: Some(SystemTime::now() + Duration::from_secs(40)),
            minted_at: SystemTime::now(),
        });
        let credential = credential_in(&slot, &exec, BACKGROUND_TIMEOUT).await.unwrap();
        assert_eq!(credential.token.as_deref(), Some("old"));
        assert_eq!(runs(&counter), 2);
    }

    #[test]
    fn keys_follow_the_exec_spec() {
        let exec = exec_for(Path::new("aws"), &[("AWS_PROFILE", "a")]);
        let other = exec_for(Path::new("aws"), &[("AWS_PROFILE", "b")]);
        assert_eq!(CredentialKey::new("/kc", "u", &exec), CredentialKey::new("/kc", "u", &exec));
        assert_ne!(CredentialKey::new("/kc", "u", &exec), CredentialKey::new("/kc", "u", &other));
        assert_ne!(CredentialKey::new("/kc", "u", &exec), CredentialKey::new("/kc", "v", &exec));

        // The cluster only counts with provideClusterInfo, and a raw
        // kubeconfig exec (no cluster filled in) gets the same key.
        let mut with_cluster = exec.clone();
        with_cluster.provide_cluster_info = true;
        with_cluster.cluster = Some(ExecAuthCluster {
            server: Some("https://a".into()),
            ..Default::default()
        });
        let mut raw = with_cluster.clone();
        raw.cluster = None;
        assert_eq!(
            CredentialKey::new("/kc", "u", &with_cluster),
            CredentialKey::with_server("/kc", "u", &raw, Some("https://a"))
        );
        assert_ne!(
            CredentialKey::new("/kc", "u", &with_cluster),
            CredentialKey::with_server("/kc", "u", &raw, Some("https://b"))
        );
    }

    #[test]
    fn exec_is_only_taken_when_kube_would_run_it() {
        let mut auth = AuthInfo {
            exec: Some(exec_for(Path::new("aws"), &[])),
            ..Default::default()
        };
        assert!(uses_exec(&auth));
        auth.token = Some("static".to_string().into());
        assert!(!uses_exec(&auth));
        assert!(take_exec(&mut auth).is_none());
        assert!(auth.exec.is_some());
        auth.token = None;
        assert!(take_exec(&mut auth).is_some());
        assert!(auth.exec.is_none());
    }
}

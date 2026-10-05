//! The auth center: one place that knows about credential problems.
//!
//! - `AuthErrorKind` / `AuthErrorInfo`: what went wrong with a context's
//!   credentials, attached to `SerializableKubeError::auth` and to issues.
//! - `report`: records an issue and emits `auth://issue` (debounced: at most
//!   once per kubeconfig + context + kind per 30 s). Reported from client
//!   builds and API calls (the client layers), watches, metrics and the
//!   kubectl-based paths (logs, port forwards, `run_kubectl`,
//!   `apply_manifest`) through `detect_kubectl_auth_failure`.
//! - `emit_resolved`: `auth://resolved` after a successful sign-in.
//! - `with_source`: tags a task (a watcher, a metrics poller) so issues the
//!   shared client layers detect inside it carry the right `source`.
//! - `redact` / `Redactor`: masks tokens, JWTs and private keys in text that
//!   may reach the UI (plugin stderr, login output).

use std::collections::HashMap;
use std::future::Future;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use once_cell::sync::{Lazy, OnceCell};
use regex::Regex;
use serde::{Deserialize, Serialize};
use tracing::{debug, warn};

use super::ContextRef;
use crate::util::lock;

pub const ISSUE_EVENT: &str = "auth://issue";
pub const RESOLVED_EVENT: &str = "auth://resolved";

/// An issue of a context + kind is emitted at most once per this period.
const DEBOUNCE: Duration = Duration::from_secs(30);
/// Issues remembered for the credential status (`needsLogin`).
const MAX_RECENT: usize = 500;
/// Issue messages are cut to this many characters.
const MAX_MESSAGE_CHARS: usize = 1000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AuthErrorKind {
    /// The credential plugin needs a human (browser, device code).
    InteractionRequired,
    /// The credentials (or the sign-in session behind them) expired.
    Expired,
    /// The API server rejected the credentials (401).
    Unauthorized,
    /// The credential plugin failed for another reason.
    ExecFailed,
    /// The credential plugin is not installed / not on PATH.
    ExecMissing,
    /// The credential plugin did not finish in time.
    Timeout,
}

impl AuthErrorKind {
    /// `SerializableKubeError::reason` for errors of this kind.
    /// `ExecAuthFailed` is what the frontend (and the clusters hub probe)
    /// already treat as "sign in again".
    pub fn reason(self) -> &'static str {
        match self {
            AuthErrorKind::InteractionRequired => "InteractionRequired",
            AuthErrorKind::Expired => "CredentialExpired",
            AuthErrorKind::Unauthorized => "Unauthorized",
            AuthErrorKind::ExecFailed => "ExecAuthFailed",
            AuthErrorKind::ExecMissing => "ToolMissing",
            AuthErrorKind::Timeout => "ExecTimeout",
        }
    }

    pub fn from_reason(reason: &str) -> Option<Self> {
        [
            AuthErrorKind::InteractionRequired,
            AuthErrorKind::Expired,
            AuthErrorKind::Unauthorized,
            AuthErrorKind::ExecFailed,
            AuthErrorKind::ExecMissing,
            AuthErrorKind::Timeout,
        ]
        .into_iter()
        .find(|kind| kind.reason() == reason)
    }

    /// Whether signing in again is the likely fix.
    pub fn needs_login(self) -> bool {
        !matches!(self, AuthErrorKind::ExecMissing | AuthErrorKind::Timeout)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum IssueSource {
    Api,
    Watch,
    Metrics,
    Logs,
    PortForward,
    Kubectl,
}

/// `SerializableKubeError::auth`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthErrorInfo {
    pub kube_config: String,
    pub context: String,
    pub kind: AuthErrorKind,
    /// Basename of the credential plugin, if any (never args or env).
    pub command: Option<String>,
}

/// `auth://issue` payload.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthIssue {
    pub kube_config: String,
    pub context: String,
    pub kind: AuthErrorKind,
    pub source: IssueSource,
    /// Redacted, user-facing.
    pub message: String,
    pub command: Option<String>,
}

/// `auth://resolved` payload.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthResolved {
    pub contexts: Vec<ContextRef>,
}

/// A credential failure of a client, carried through the tower stack as the
/// request error (kube wraps it in `kube::Error::Service`). Its message is
/// already redacted.
#[derive(Debug, Clone, PartialEq)]
pub struct AuthFailure {
    pub info: AuthErrorInfo,
    pub message: String,
}

impl std::fmt::Display for AuthFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for AuthFailure {}

impl AuthFailure {
    /// The `AuthFailure` inside a kube error, if that is what it is.
    pub fn of_kube_error(err: &kube::Error) -> Option<&AuthFailure> {
        match err {
            kube::Error::Service(inner) => inner.downcast_ref::<AuthFailure>(),
            _ => None,
        }
    }
}

/* ------------------------------------------------------------- emitting */

static APP: OnceCell<tauri::AppHandle> = OnceCell::new();

/// Called once from `main`'s setup: events need the app handle.
pub fn init(app: tauri::AppHandle) {
    let _ = APP.set(app);
}

fn emit<S: Serialize + Clone>(event: &str, payload: S) {
    use tauri::Emitter;
    if let Some(app) = APP.get() {
        if let Err(e) = app.emit(event, payload) {
            warn!("Failed to emit {}: {}", event, e);
        }
    }
}

#[derive(Default)]
struct IssueLog {
    /// Last emission per (kubeconfig, context, kind).
    emitted: HashMap<(String, String, AuthErrorKind), Instant>,
    /// Latest issue per (kubeconfig, context): kind and unix ms.
    recent: HashMap<(String, String), (AuthErrorKind, i64)>,
}

static ISSUES: Lazy<Mutex<IssueLog>> = Lazy::new(|| Mutex::new(IssueLog::default()));

/// Emitted issues, for tests (there is no app handle there).
#[cfg(test)]
pub(crate) static EMITTED: Lazy<Mutex<Vec<AuthIssue>>> = Lazy::new(|| Mutex::new(Vec::new()));

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// Records an issue and emits `auth://issue` unless the same kubeconfig +
/// context + kind was emitted in the last 30 s. Returns whether it was
/// emitted. The message is redacted here.
pub fn report(mut issue: AuthIssue) -> bool {
    issue.message = truncate(&redact(issue.message.trim()), MAX_MESSAGE_CHARS);
    let emit_now = {
        let mut log = lock(&ISSUES);
        let target = (issue.kube_config.clone(), issue.context.clone());
        if log.recent.len() >= MAX_RECENT && !log.recent.contains_key(&target) {
            // Forget the oldest.
            if let Some(oldest) = log.recent.iter().min_by_key(|(_, (_, at))| *at).map(|(k, _)| k.clone()) {
                log.recent.remove(&oldest);
            }
        }
        log.recent.insert(target, (issue.kind, now_ms()));

        let key = (issue.kube_config.clone(), issue.context.clone(), issue.kind);
        let fresh = log.emitted.get(&key).is_some_and(|at| at.elapsed() < DEBOUNCE);
        if !fresh {
            log.emitted.retain(|_, at| at.elapsed() < DEBOUNCE);
            log.emitted.insert(key, Instant::now());
        }
        !fresh
    };
    if !emit_now {
        return false;
    }
    debug!(
        "Auth issue {:?} for {} ({:?}): {}",
        issue.kind, issue.context, issue.source, issue.message
    );
    #[cfg(test)]
    lock(&EMITTED).push(issue.clone());
    emit(ISSUE_EVENT, issue);
    true
}

/// `report` for an `AuthFailure`.
pub fn report_failure(failure: &AuthFailure, source: IssueSource) -> bool {
    report(AuthIssue {
        kube_config: failure.info.kube_config.clone(),
        context: failure.info.context.clone(),
        kind: failure.info.kind,
        source,
        message: failure.message.clone(),
        command: failure.info.command.clone(),
    })
}

/// Checks the stderr of a failed kubectl (or of a credential plugin) for an
/// auth failure and reports it. Returns the kind found.
pub fn report_kubectl_failure(
    kube_config: &str,
    context: &str,
    source: IssueSource,
    stderr: &str,
) -> Option<AuthErrorKind> {
    if context.is_empty() {
        return None;
    }
    let kind = detect_kubectl_auth_failure(stderr)?;
    report(AuthIssue {
        kube_config: kube_config.to_string(),
        context: context.to_string(),
        kind,
        source,
        message: stderr.to_string(),
        command: exec_command_in_message(stderr),
    });
    Some(kind)
}

/// The latest issue of a context (kind, unix ms), for the credential status.
pub fn recent_issue(kube_config: &str, context: &str) -> Option<(AuthErrorKind, i64)> {
    lock(&ISSUES)
        .recent
        .get(&(kube_config.to_string(), context.to_string()))
        .copied()
}

/// Forgets the issues of `contexts` (after they signed in again), so the
/// next failure is reported right away.
pub fn clear_issues(contexts: &[ContextRef]) {
    let mut log = lock(&ISSUES);
    for target in contexts {
        log.recent.remove(&(target.kube_config.clone(), target.context.clone()));
        log.emitted
            .retain(|(kube_config, context, _), _| !(kube_config == &target.kube_config && context == &target.context));
    }
}

/// Bumped on every successful sign-in. Long running kubectl based streams
/// (log selectors) retry failed sources early when it changes.
static AUTH_EPOCH: AtomicU64 = AtomicU64::new(0);

pub fn auth_epoch() -> u64 {
    AUTH_EPOCH.load(Ordering::SeqCst)
}

/// Emits `auth://resolved` for `contexts` and bumps the auth epoch.
pub fn emit_resolved(contexts: Vec<ContextRef>) {
    AUTH_EPOCH.fetch_add(1, Ordering::SeqCst);
    emit(RESOLVED_EVENT, AuthResolved { contexts });
}

/* ----------------------------------------------------------------- source */

tokio::task_local! {
    static SOURCE: IssueSource;
}

/// Runs `fut` with `source` as the source of the issues detected inside it
/// (by the client layers, which can't know who sent a request).
pub async fn with_source<F: Future>(source: IssueSource, fut: F) -> F::Output {
    SOURCE.scope(source, fut).await
}

/// The source of the current task (`Api` outside `with_source`).
pub fn current_source() -> IssueSource {
    SOURCE.try_with(|source| *source).unwrap_or(IssueSource::Api)
}

/* -------------------------------------------------------------- detection */

/// Output of credential plugins (or of kubectl running one) that asks a
/// human to sign in: device codes, browser URLs.
const PROMPT_PATTERNS: &[&str] = &[
    // kubelogin (Azure) / az: "To sign in, use a web browser to open the
    // page https://microsoft.com/devicelogin and enter the code ..."
    "microsoft.com/devicelogin",
    "to sign in, use a web browser",
    "and enter the code",
    // aws sso login (device authorization)
    "device.sso.",
    "open the following url",
    // int128/kubelogin (kubectl oidc-login)
    "please visit the following url",
    "enter the following code when asked in your browser",
    "http://localhost:8000",
    "http://127.0.0.1:8000",
    // pinniped
    "log in by visiting this link",
    // gcloud / az browser flows
    "your browser has been opened",
    "a web browser has been opened",
];

/// Whether a line of plugin output asks a human to sign in.
pub fn looks_interactive(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    PROMPT_PATTERNS.iter().any(|pattern| lower.contains(pattern))
}

/// Classifies the stderr of kubectl (or of a credential plugin) as an auth
/// failure:
///
/// - a sign-in prompt (device code / browser URL) → `InteractionRequired`
/// - `executable ... not found` → `ExecMissing`
/// - an expired SSO session / token → `Expired`
/// - any other `getting credentials: exec:` failure → `ExecFailed`
/// - rejected credentials → `Unauthorized`
pub fn detect_kubectl_auth_failure(stderr: &str) -> Option<AuthErrorKind> {
    let lower = stderr.to_ascii_lowercase();
    if looks_interactive(&lower) {
        return Some(AuthErrorKind::InteractionRequired);
    }
    let exec_failed = lower.contains("getting credentials: exec:");
    if lower.contains("executable file not found")
        || (exec_failed && (lower.contains("not found") || lower.contains("no such file")))
    {
        return Some(AuthErrorKind::ExecMissing);
    }
    const EXPIRED: &[&str] = &[
        "error loading sso token",
        "token has expired",
        "token is expired",
        "the sso session associated with this profile has expired",
        "sso session has expired",
        "profile has expired",
        "error when retrieving token from sso",
        "refresh token has expired",
        "reauthentication required",
    ];
    if EXPIRED.iter().any(|pattern| lower.contains(pattern)) {
        return Some(AuthErrorKind::Expired);
    }
    if exec_failed {
        return Some(AuthErrorKind::ExecFailed);
    }
    if lower.contains("you must be logged in to the server")
        || lower.contains("the server has asked for the client to provide credentials")
        || lower.contains("unauthorized")
    {
        return Some(AuthErrorKind::Unauthorized);
    }
    None
}

static EXECUTABLE: Lazy<Regex> = Lazy::new(|| Regex::new(r"executable ([^\s:]+)").unwrap());

/// The plugin named in kubectl's "getting credentials: exec: executable X
/// failed" (basename only).
pub fn exec_command_in_message(text: &str) -> Option<String> {
    let command = EXECUTABLE.captures(text)?.get(1)?.as_str();
    let command = command.trim_matches(|c| c == '"' || c == '\'');
    if command.is_empty() || command == "file" {
        return None;
    }
    Some(super::classify::command_basename(command))
}

/* -------------------------------------------------------------- redaction */

const MASK: &str = "[redacted]";

static JWT: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]*").unwrap());
static EKS_TOKEN: Lazy<Regex> = Lazy::new(|| Regex::new(r"k8s-aws-v1\.[A-Za-z0-9_-]+").unwrap());
static AWS_KEY_ID: Lazy<Regex> = Lazy::new(|| Regex::new(r"\b(?:AKIA|ASIA)[A-Z0-9]{16}\b").unwrap());
static BEARER: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(?i)\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}").unwrap());
static KEY_VALUE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(
        r#"(?i)((?:access[_-]?token|id[_-]?token|refresh[_-]?token|session[_-]?token|bearer[_-]?token|client[_-]?secret|client[_-]?key[_-]?data|secret[_-]?access[_-]?key|private[_-]?key|password|passwd|secret|token)"?\s*[:=]\s*"?)([^\s",&'}]+)"#,
    )
    .unwrap()
});

/// Masks secrets in (possibly multi-line) text.
pub fn redact(text: &str) -> String {
    let mut redactor = Redactor::default();
    text.split('\n')
        .map(|line| redactor.line(line))
        .collect::<Vec<_>>()
        .join("\n")
}

/// Line by line redaction that also masks private key PEM blocks spanning
/// several lines.
#[derive(Debug, Default)]
pub struct Redactor {
    in_private_key: bool,
}

impl Redactor {
    pub fn line(&mut self, line: &str) -> String {
        if self.in_private_key {
            if line.contains("-----END") {
                self.in_private_key = false;
            }
            return MASK.to_string();
        }
        if line.contains("-----BEGIN") && line.contains("PRIVATE KEY") {
            self.in_private_key = !line.contains("-----END");
            return MASK.to_string();
        }
        redact_line(line)
    }
}

fn redact_line(line: &str) -> String {
    let line = JWT.replace_all(line, MASK);
    let line = EKS_TOKEN.replace_all(&line, MASK);
    let line = AWS_KEY_ID.replace_all(&line, MASK);
    let line = BEARER.replace_all(&line, format!("${{1}} {MASK}"));
    let line = KEY_VALUE.replace_all(&line, |caps: &regex::Captures| {
        if &caps[2] == MASK {
            caps[0].to_string()
        } else {
            format!("{}{}", &caps[1], MASK)
        }
    });
    // Long opaque strings (keys, tokens) that matched nothing above.
    let mut out = String::with_capacity(line.len());
    for (index, word) in line.split(' ').enumerate() {
        if index > 0 {
            out.push(' ');
        }
        if looks_like_secret(word) {
            out.push_str(MASK);
        } else {
            out.push_str(word);
        }
    }
    out
}

/// A long run of base64 / hex characters with mixed case and digits, which
/// is not a URL or a path.
fn looks_like_secret(word: &str) -> bool {
    let word = word.trim_matches(|c: char| matches!(c, '"' | '\'' | ',' | ';' | '(' | ')' | '[' | ']'));
    word.len() >= 40
        && !word.starts_with('/')
        && !word.contains("://")
        && word
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '/' | '=' | '_' | '-' | '.'))
        && word.chars().any(|c| c.is_ascii_digit())
        && word.chars().any(|c| c.is_ascii_uppercase())
        && word.chars().any(|c| c.is_ascii_lowercase())
}

fn truncate(text: &str, max_chars: usize) -> String {
    if text.chars().count() <= max_chars {
        return text.to_string();
    }
    let mut short: String = text.chars().take(max_chars - 1).collect();
    short.push('…');
    short
}

#[cfg(test)]
mod tests {
    use super::*;
    use AuthErrorKind::*;

    #[test]
    fn kubectl_auth_failures_are_detected() {
        let table: &[(&str, Option<AuthErrorKind>)] = &[
            ("error: You must be logged in to the server (Unauthorized)", Some(Unauthorized)),
            (
                "error: You must be logged in to the server (the server has asked for the client to provide credentials)",
                Some(Unauthorized),
            ),
            ("Unauthorized", Some(Unauthorized)),
            (
                "Unable to connect to the server: getting credentials: exec: executable kubelogin not found\n\nIt looks like you are trying to use a client-go credential plugin that is not installed.",
                Some(ExecMissing),
            ),
            (
                "Unable to connect to the server: getting credentials: exec: executable aws-iam-authenticator failed: exec: \"aws-iam-authenticator\": executable file not found in $PATH",
                Some(ExecMissing),
            ),
            (
                "Unable to connect to the server: getting credentials: exec: executable aws failed with exit code 255\nError loading SSO Token: Token for prod does not exist",
                Some(Expired),
            ),
            (
                "Error when retrieving token from sso: Token has expired and refresh failed",
                Some(Expired),
            ),
            ("error: failed to get token: token is expired", Some(Expired)),
            (
                "getting credentials: exec: executable gke-gcloud-auth-plugin failed with exit code 1",
                Some(ExecFailed),
            ),
            (
                "To sign in, use a web browser to open the page https://microsoft.com/devicelogin and enter the code ABCD12345 to authenticate.",
                Some(InteractionRequired),
            ),
            (
                "error: pods \"web-1\" is forbidden: User \"jane\" cannot get resource \"pods/log\"",
                None,
            ),
            ("error: dial tcp 10.0.0.1:443: i/o timeout", None),
            ("", None),
        ];
        for (stderr, expected) in table {
            assert_eq!(detect_kubectl_auth_failure(stderr), *expected, "{stderr}");
        }
    }

    #[test]
    fn exec_command_is_read_from_kubectl_messages() {
        assert_eq!(
            exec_command_in_message("getting credentials: exec: executable /usr/local/bin/aws failed with exit code 255").as_deref(),
            Some("aws")
        );
        assert_eq!(
            exec_command_in_message("exec: executable kubelogin not found").as_deref(),
            Some("kubelogin")
        );
        assert_eq!(exec_command_in_message("executable file not found in $PATH"), None);
        assert_eq!(exec_command_in_message("nothing here"), None);
    }

    #[test]
    fn secrets_are_redacted() {
        let jwt = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJqYW5lIn0.c2lnbmF0dXJl";
        let cases: &[(String, &[&str], &[&str])] = &[
            (format!("token: {jwt}"), &[jwt], &["token: "]),
            (format!("{{\"token\":\"{jwt}\"}}"), &[jwt], &[]),
            ("Authorization: Bearer abcdefghijklmnop".into(), &["abcdefghijklmnop"], &["Bearer"]),
            ("\"accessToken\": \"aoaAAAAAGabc123\"".into(), &["aoaAAAAAGabc123"], &["accessToken"]),
            ("aws_secret_access_key = wJalrXUtnFEMI/K7MDENG".into(), &["wJalrXUtnFEMI"], &["aws_secret_access_key"]),
            ("key AKIAIOSFODNN7EXAMPLE used".into(), &["AKIAIOSFODNN7EXAMPLE"], &["used"]),
            ("k8s-aws-v1.aHR0cHM6Ly9zdHM".into(), &["aHR0cHM6Ly9zdHM"], &[]),
            (
                "opaque Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MGFiY2RlZmdoaWprbG1ub3A0".into(),
                &["Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MGFiY2RlZmdoaWprbG1ub3A0"],
                &["opaque"],
            ),
        ];
        for (input, gone, kept) in cases {
            let out = redact(input);
            for secret in *gone {
                assert!(!out.contains(secret), "{input} -> {out}");
            }
            for text in *kept {
                assert!(out.contains(text), "{input} -> {out}");
            }
        }

        // Prompts stay readable.
        let prompt = "To sign in, use a web browser to open the page https://microsoft.com/devicelogin and enter the code FQ8RLYZ3K to authenticate.";
        assert_eq!(redact(prompt), prompt);
        let url = "https://oidc.eu-west-1.amazonaws.com/authorize?response_type=code&client_id=AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcdefgh&code_challenge=Xyz0123456789abcdefghijklmnopqrstuvwxyzABCD";
        assert_eq!(redact(url), url);
        assert_eq!(redact("/home/jane/.kube/cache/oidc-login/0123456789abcdefABCDEF0123456789abcdef"), "/home/jane/.kube/cache/oidc-login/0123456789abcdefABCDEF0123456789abcdef");
    }

    #[test]
    fn private_key_blocks_are_masked_across_lines() {
        let text = "before\n-----BEGIN EC PRIVATE KEY-----\nMHcCAQEEIIrYSSNQFaA2Hwf1duRSxKtLYX5CB04fSeQ6tF1aY/PuoAoGCCqGSM49\nAwEHoUQDQgAE\n-----END EC PRIVATE KEY-----\nafter";
        let out = redact(text);
        assert!(!out.contains("MHcCAQEE"));
        assert!(!out.contains("AwEHoUQDQgAE"));
        assert!(out.starts_with("before\n"));
        assert!(out.ends_with("\nafter"));
    }

    #[test]
    fn issues_are_debounced_per_context_and_kind() {
        let issue = |kind| AuthIssue {
            kube_config: "/center-test/kc".into(),
            context: "debounce".into(),
            kind,
            source: IssueSource::Watch,
            message: "token: secret-value".into(),
            command: None,
        };
        assert!(report(issue(Expired)));
        assert!(!report(issue(Expired)), "same kind within 30 s");
        assert!(report(issue(Unauthorized)), "another kind is a new issue");
        assert_eq!(recent_issue("/center-test/kc", "debounce").map(|(k, _)| k), Some(Unauthorized));
        let emitted = lock(&EMITTED)
            .iter()
            .filter(|i| i.context == "debounce")
            .cloned()
            .collect::<Vec<_>>();
        assert_eq!(emitted.len(), 2);
        assert!(emitted.iter().all(|i| !i.message.contains("secret-value")));

        clear_issues(&[ContextRef {
            kube_config: "/center-test/kc".into(),
            context: "debounce".into(),
        }]);
        assert_eq!(recent_issue("/center-test/kc", "debounce"), None);
        assert!(report(issue(Expired)), "cleared issues are reported again right away");
    }

    #[test]
    fn issues_serialize_like_the_frontend_contract() {
        let issue = AuthIssue {
            kube_config: "/kc".into(),
            context: "ctx".into(),
            kind: InteractionRequired,
            source: IssueSource::PortForward,
            message: "m".into(),
            command: Some("kubelogin".into()),
        };
        assert_eq!(
            serde_json::to_value(issue).unwrap(),
            serde_json::json!({
                "kubeConfig": "/kc",
                "context": "ctx",
                "kind": "interactionRequired",
                "source": "portForward",
                "message": "m",
                "command": "kubelogin"
            })
        );
        assert_eq!(AuthErrorKind::from_reason("CredentialExpired"), Some(Expired));
        assert_eq!(AuthErrorKind::from_reason("Nope"), None);
    }

    #[tokio::test]
    async fn source_is_scoped_to_the_task() {
        assert_eq!(current_source(), IssueSource::Api);
        let inner = with_source(IssueSource::Metrics, async { current_source() }).await;
        assert_eq!(inner, IssueSource::Metrics);
        assert_eq!(current_source(), IssueSource::Api);
    }
}

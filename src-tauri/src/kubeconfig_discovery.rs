//! Finding the user's kubeconfig files and describing what is in them, for
//! the welcome flow and the clusters hub.
//!
//! Discovery looks at `~/.kube/config`, every `$KUBECONFIG` entry, kubeconfig
//! looking files directly in `~/.kube/` (`*.yaml|*.yml|*.conf|*.kubeconfig`,
//! non-recursive, at most 5 MiB) and the files in `~/.kube/config.d/`. Files
//! from the two globs that aren't kubeconfigs are dropped silently; a
//! default or `$KUBECONFIG` file that can't be read is reported.
//!
//! Neither command ever returns a secret: no tokens, keys, passwords or exec
//! env values (other than `AWS_PROFILE`), and YAML errors are reduced to a
//! position, since the parser's message can quote the offending value.

use std::ffi::OsStr;
use std::path::{Path, PathBuf};

use kube::config::{AuthInfo, ExecConfig, Kubeconfig, KubeconfigError};
use serde::Serialize;
use tracing::{debug, warn};

use crate::kubernetes::client::SerializableKubeError;
use crate::paths;

const MAX_GLOBBED_BYTES: u64 = 5 * 1024 * 1024;
const MAX_CONTEXT_NAMES: usize = 50;
const KUBECONFIG_EXTENSIONS: &[&str] = &["yaml", "yml", "conf", "kubeconfig"];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Origin {
    /// `~/.kube/config`
    Default,
    /// An entry of `$KUBECONFIG`.
    Env,
    /// A file directly in `~/.kube/`.
    Directory,
    /// A file in `~/.kube/config.d/`.
    ConfigD,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveredKubeconfig {
    pub path: String,
    pub origin: Origin,
    pub readable: bool,
    pub error: Option<String>,
    pub context_count: usize,
    /// The first 50 context names.
    pub context_names: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KubeconfigReport {
    pub path: String,
    pub current_context: Option<String>,
    pub contexts: Vec<ContextSummary>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextSummary {
    pub name: String,
    pub cluster: String,
    pub server: Option<String>,
    pub user: String,
    pub namespace: Option<String>,
    pub auth: AuthSummary,
    pub problems: Vec<Problem>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum AuthKind {
    Token,
    ClientCert,
    Exec,
    AuthProvider,
    Basic,
    None,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthSummary {
    pub kind: AuthKind,
    /// Basename of the exec credential plugin.
    pub command: Option<String>,
    /// The AWS profile an exec plugin uses (`AWS_PROFILE` env or
    /// `--profile`), for AWS SSO re-login.
    pub aws_profile: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Severity {
    Warning,
    Error,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Problem {
    /// `clusterMissing` | `userMissing` | `execNotFound` | `fileRefMissing` |
    /// `insecureSkipTls` | `removedAuthProvider` | `basicAuth`
    pub code: String,
    pub severity: Severity,
    pub message: String,
}

impl Problem {
    fn new(code: &str, severity: Severity, message: String) -> Problem {
        Problem {
            code: code.to_string(),
            severity,
            message,
        }
    }
}

/* ---------------------------------------------------------------- discover */

/// Lists the kubeconfig files on this machine (see the module docs).
#[tauri::command]
pub async fn kubeconfig_discover() -> Vec<DiscoveredKubeconfig> {
    let kube_dir = paths::kube_dir();
    let env = std::env::var_os("KUBECONFIG");
    tauri::async_runtime::spawn_blocking(move || discover(kube_dir.as_deref(), env.as_deref()))
        .await
        .unwrap_or_else(|e| {
            warn!("Kubeconfig discovery failed: {}", e);
            Vec::new()
        })
}

fn discover(kube_dir: Option<&Path>, kubeconfig_env: Option<&OsStr>) -> Vec<DiscoveredKubeconfig> {
    let mut seen: Vec<PathBuf> = Vec::new();
    let mut found = Vec::new();
    for (path, origin) in candidates(kube_dir, kubeconfig_env) {
        if origin == Origin::Default && !path.exists() {
            continue;
        }
        // The first origin wins: default > env > directory > config.d.
        let key = std::fs::canonicalize(&path).unwrap_or_else(|_| path.clone());
        if seen.contains(&key) {
            continue;
        }
        seen.push(key);
        if let Some(entry) = inspect(&path, origin) {
            found.push(entry);
        }
    }
    debug!("Discovered {} kubeconfig file(s)", found.len());
    found
}

fn candidates(kube_dir: Option<&Path>, kubeconfig_env: Option<&OsStr>) -> Vec<(PathBuf, Origin)> {
    let mut candidates = Vec::new();
    if let Some(dir) = kube_dir {
        candidates.push((dir.join("config"), Origin::Default));
    }
    if let Some(env) = kubeconfig_env {
        candidates.extend(
            std::env::split_paths(env)
                .filter(|p| !p.as_os_str().is_empty())
                .map(|p| (p, Origin::Env)),
        );
    }
    if let Some(dir) = kube_dir {
        candidates.extend(
            list_files(dir, true)
                .into_iter()
                .map(|p| (p, Origin::Directory)),
        );
        candidates.extend(
            list_files(&dir.join("config.d"), false)
                .into_iter()
                .map(|p| (p, Origin::ConfigD)),
        );
    }
    candidates
}

/// Regular files (symlinks followed) directly in `dir`, sorted, at most
/// 5 MiB, no hidden files; with `kubeconfig_extension` only the kubeconfig
/// extensions. Subdirectories (`cache`, `http-cache`, `jet-pilot`, ...) are
/// never entered.
fn list_files(dir: &Path, kubeconfig_extension: bool) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut files: Vec<PathBuf> = entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| {
            let hidden = path
                .file_name()
                .is_none_or(|name| name.to_string_lossy().starts_with('.'));
            let extension_ok = !kubeconfig_extension
                || path.extension().is_some_and(|ext| {
                    let ext = ext.to_string_lossy().to_ascii_lowercase();
                    KUBECONFIG_EXTENSIONS.contains(&ext.as_str())
                });
            !hidden
                && extension_ok
                && std::fs::metadata(path)
                    .is_ok_and(|m| m.is_file() && m.len() <= MAX_GLOBBED_BYTES)
        })
        .collect();
    files.sort();
    files
}

/// Any sign of a kubeconfig: unrelated YAML maps parse as an empty one.
fn looks_like_kubeconfig(config: &Kubeconfig) -> bool {
    config.kind.as_deref() == Some("Config")
        || !config.clusters.is_empty()
        || !config.contexts.is_empty()
        || !config.auth_infos.is_empty()
}

fn inspect(path: &Path, origin: Origin) -> Option<DiscoveredKubeconfig> {
    let globbed = matches!(origin, Origin::Directory | Origin::ConfigD);
    let mut entry = DiscoveredKubeconfig {
        path: path.to_string_lossy().into_owned(),
        origin,
        readable: false,
        error: None,
        context_count: 0,
        context_names: Vec::new(),
    };
    match Kubeconfig::read_from(path) {
        Ok(config) if globbed && !looks_like_kubeconfig(&config) => None,
        Ok(config) => {
            entry.readable = true;
            entry.context_count = config.contexts.len();
            entry.context_names = config
                .contexts
                .into_iter()
                .take(MAX_CONTEXT_NAMES)
                .map(|c| c.name)
                .collect();
            Some(entry)
        }
        Err(_) if globbed => None,
        Err(e) => {
            entry.error = Some(read_error_message(&e));
            Some(entry)
        }
    }
}

/// A user-facing message for a kubeconfig that can't be read. YAML errors
/// only keep their position: the parser's message can quote file contents.
pub(crate) fn read_error_message(error: &KubeconfigError) -> String {
    match error {
        KubeconfigError::ReadConfig(e, _) if e.kind() == std::io::ErrorKind::NotFound => {
            "The file does not exist.".to_string()
        }
        KubeconfigError::ReadConfig(e, _) => format!("The file could not be read: {e}"),
        KubeconfigError::Parse(e) => match e.location() {
            Some(at) => format!(
                "Not a valid kubeconfig: YAML error at line {}, column {}.",
                at.line(),
                at.column()
            ),
            None => "Not a valid kubeconfig: the YAML could not be parsed.".to_string(),
        },
        e => format!("Not a valid kubeconfig: {e}"),
    }
}

/* ---------------------------------------------------------------- describe */

/// Summarises every context of the kubeconfig at `path` with the problems
/// found in it (missing clusters/users/files, unavailable exec plugins,
/// removed auth providers, ...). Never returns secrets.
#[tauri::command]
pub async fn kubeconfig_describe(path: String) -> Result<KubeconfigReport, SerializableKubeError> {
    tauri::async_runtime::spawn_blocking(move || {
        let config = Kubeconfig::read_from(&path).map_err(|e| {
            let reason = match e {
                KubeconfigError::Parse(_) => "KubeconfigInvalid",
                _ => "KubeconfigUnreadable",
            };
            SerializableKubeError {
                message: read_error_message(&e),
                code: None,
                reason: Some(reason.to_string()),
                details: None,
            }
        })?;
        Ok(describe(&path, &config, &|command| {
            which::which(command).is_ok()
        }))
    })
    .await
    .map_err(|e| SerializableKubeError {
        message: e.to_string(),
        code: None,
        reason: None,
        details: None,
    })?
}

/// `command_on_path` resolves a bare exec command (injected for tests).
fn describe(
    path: &str,
    config: &Kubeconfig,
    command_on_path: &dyn Fn(&str) -> bool,
) -> KubeconfigReport {
    let contexts = config
        .contexts
        .iter()
        .map(|named| {
            let context = named.context.as_ref();
            let cluster_name = context.map(|c| c.cluster.clone()).unwrap_or_default();
            let user_name = context.and_then(|c| c.user.clone()).unwrap_or_default();
            let mut problems = Vec::new();

            let cluster = config
                .clusters
                .iter()
                .find(|c| !cluster_name.is_empty() && c.name == cluster_name)
                .and_then(|c| c.cluster.as_ref());
            match cluster {
                Some(cluster) => {
                    if cluster.insecure_skip_tls_verify == Some(true) {
                        problems.push(Problem::new(
                            "insecureSkipTls",
                            Severity::Warning,
                            "TLS certificate verification is turned off for this cluster."
                                .to_string(),
                        ));
                    }
                    check_file(
                        &mut problems,
                        "certificate authority",
                        cluster.certificate_authority.as_deref(),
                    );
                }
                None if cluster_name.is_empty() => problems.push(Problem::new(
                    "clusterMissing",
                    Severity::Error,
                    "The context does not name a cluster.".to_string(),
                )),
                None => problems.push(Problem::new(
                    "clusterMissing",
                    Severity::Error,
                    format!("The cluster \"{cluster_name}\" is not defined in this kubeconfig."),
                )),
            }

            let user = config.auth_infos.iter().find(|u| u.name == user_name);
            if !user_name.is_empty() && user.is_none() {
                problems.push(Problem::new(
                    "userMissing",
                    Severity::Error,
                    format!("The user \"{user_name}\" is not defined in this kubeconfig."),
                ));
            }
            let auth_info = user.and_then(|u| u.auth_info.as_ref());
            if let Some(auth_info) = auth_info {
                check_auth_info(&mut problems, auth_info, command_on_path);
            }

            ContextSummary {
                name: named.name.clone(),
                cluster: cluster_name,
                server: cluster.and_then(|c| c.server.clone()),
                user: user_name,
                namespace: context.and_then(|c| c.namespace.clone()),
                auth: auth_info.map(summarize_auth).unwrap_or(AuthSummary {
                    kind: AuthKind::None,
                    command: None,
                    aws_profile: None,
                }),
                problems,
            }
        })
        .collect();

    KubeconfigReport {
        path: path.to_string(),
        current_context: config.current_context.clone().filter(|c| !c.is_empty()),
        contexts,
    }
}

/// `fileRefMissing` for a referenced file that doesn't exist. Relative
/// paths were made absolute (against the kubeconfig's directory) by
/// `Kubeconfig::read_from`.
fn check_file(problems: &mut Vec<Problem>, what: &str, path: Option<&str>) {
    if let Some(path) = path.filter(|p| !p.is_empty()) {
        if !Path::new(path).exists() {
            problems.push(Problem::new(
                "fileRefMissing",
                Severity::Error,
                format!("The {what} file {path} does not exist."),
            ));
        }
    }
}

fn check_auth_info(
    problems: &mut Vec<Problem>,
    auth: &AuthInfo,
    command_on_path: &dyn Fn(&str) -> bool,
) {
    check_file(
        problems,
        "client certificate",
        auth.client_certificate.as_deref(),
    );
    check_file(problems, "client key", auth.client_key.as_deref());
    check_file(problems, "token", auth.token_file.as_deref());

    if let Some(command) = auth.exec.as_ref().and_then(|e| e.command.as_deref()) {
        if !exec_command_exists(command, command_on_path) {
            problems.push(Problem::new(
                "execNotFound",
                Severity::Warning,
                format!("The credential plugin \"{command}\" was not found on your PATH."),
            ));
        }
    }

    if let Some(provider) = &auth.auth_provider {
        let replacement = match provider.name.as_str() {
            "gcp" => Some("gke-gcloud-auth-plugin"),
            "azure" => Some("kubelogin"),
            _ => None,
        };
        if let Some(replacement) = replacement {
            problems.push(Problem::new(
                "removedAuthProvider",
                Severity::Error,
                format!(
                    "The \"{}\" auth provider was removed from kubectl. Use {replacement} instead.",
                    provider.name
                ),
            ));
        }
    }

    if auth.username.is_some() || auth.password.is_some() {
        problems.push(Problem::new(
            "basicAuth",
            Severity::Warning,
            "Basic authentication (username and password) is no longer supported by Kubernetes."
                .to_string(),
        ));
    }
}

/// Paths (absolute, or relative with a separator, already resolved by
/// `read_from`) must exist; bare names must be on `PATH`.
fn exec_command_exists(command: &str, command_on_path: &dyn Fn(&str) -> bool) -> bool {
    let path = Path::new(command);
    if path.is_absolute() || command.contains('/') || command.contains(std::path::MAIN_SEPARATOR) {
        path.is_file()
    } else {
        command_on_path(command)
    }
}

fn summarize_auth(auth: &AuthInfo) -> AuthSummary {
    let kind = if auth.exec.is_some() {
        AuthKind::Exec
    } else if auth.auth_provider.is_some() {
        AuthKind::AuthProvider
    } else if auth.token.is_some() || auth.token_file.is_some() {
        AuthKind::Token
    } else if auth.client_certificate.is_some() || auth.client_certificate_data.is_some() {
        AuthKind::ClientCert
    } else if auth.username.is_some() || auth.password.is_some() {
        AuthKind::Basic
    } else {
        AuthKind::None
    };
    let exec = auth.exec.as_ref();
    AuthSummary {
        kind,
        command: exec.and_then(|e| e.command.as_deref()).map(|command| {
            Path::new(command)
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_else(|| command.to_string())
        }),
        aws_profile: exec.and_then(aws_profile),
    }
}

/// `AWS_PROFILE` from the exec env, else `--profile` from its args.
fn aws_profile(exec: &ExecConfig) -> Option<String> {
    let from_env = exec.env.as_ref().and_then(|envs| {
        envs.iter()
            .find(|env| env.get("name").map(String::as_str) == Some("AWS_PROFILE"))
            .and_then(|env| env.get("value").cloned())
    });
    let from_args = || {
        let args = exec.args.as_ref()?;
        args.iter()
            .enumerate()
            .find_map(|(i, arg)| match arg.strip_prefix("--profile") {
                Some("") => args.get(i + 1).cloned(),
                Some(value) => value.strip_prefix('=').map(str::to_string),
                None => None,
            })
    };
    from_env.or_else(from_args).filter(|p| !p.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    const TOKEN_CONFIG: &str = r#"
apiVersion: v1
kind: Config
current-context: do-ams3
clusters:
- name: do-ams3-cluster
  cluster:
    server: https://abc.k8s.ondigitalocean.com
    certificate-authority-data: Q0E=
contexts:
- name: do-ams3
  context:
    cluster: do-ams3-cluster
    user: do-ams3-admin
    namespace: web
users:
- name: do-ams3-admin
  user:
    token: dop_v1_super-secret-token
"#;

    fn write(dir: &Path, name: &str, contents: &str) -> PathBuf {
        let path = dir.join(name);
        std::fs::write(&path, contents).unwrap();
        path
    }

    fn describe_yaml(dir: &Path, yaml: &str, on_path: &[&str]) -> KubeconfigReport {
        let path = write(dir, "describe.yaml", yaml);
        let config = Kubeconfig::read_from(&path).unwrap();
        describe(&path.to_string_lossy(), &config, &|command| {
            on_path.contains(&command)
        })
    }

    fn codes(context: &ContextSummary) -> Vec<&str> {
        context.problems.iter().map(|p| p.code.as_str()).collect()
    }

    #[test]
    fn describes_a_token_context_without_secrets() {
        let dir = tempfile::tempdir().unwrap();
        let report = describe_yaml(dir.path(), TOKEN_CONFIG, &[]);
        assert_eq!(report.current_context.as_deref(), Some("do-ams3"));
        let context = &report.contexts[0];
        assert_eq!(context.name, "do-ams3");
        assert_eq!(context.cluster, "do-ams3-cluster");
        assert_eq!(
            context.server.as_deref(),
            Some("https://abc.k8s.ondigitalocean.com")
        );
        assert_eq!(context.user, "do-ams3-admin");
        assert_eq!(context.namespace.as_deref(), Some("web"));
        assert_eq!(context.auth.kind, AuthKind::Token);
        assert!(context.problems.is_empty());

        let json = serde_json::to_string(&report).unwrap();
        assert!(!json.contains("super-secret"));
        assert!(json.contains("\"currentContext\""));
        assert!(json.contains("\"kind\":\"token\""));
    }

    #[test]
    fn describes_exec_cert_provider_and_basic_auth() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("ca.crt"), "CA").unwrap();
        std::fs::write(dir.path().join("client.crt"), "CERT").unwrap();
        let yaml = r#"
apiVersion: v1
kind: Config
clusters:
- name: eks
  cluster:
    server: https://ABC.gr7.eu-west-1.eks.amazonaws.com
    certificate-authority: ca.crt
- name: kind
  cluster:
    server: https://127.0.0.1:6443
    insecure-skip-tls-verify: true
- name: gke
  cluster:
    server: https://34.1.2.3
contexts:
- name: eks-prod
  context: {cluster: eks, user: eks-user}
- name: eks-args
  context: {cluster: eks, user: eks-args-user}
- name: kind
  context: {cluster: kind, user: kind-user}
- name: gke-legacy
  context: {cluster: gke, user: gke-user}
- name: azure-legacy
  context: {cluster: gke, user: azure-user}
- name: basic
  context: {cluster: gke, user: basic-user}
- name: oidc
  context: {cluster: gke, user: oidc-user}
users:
- name: eks-user
  user:
    exec:
      apiVersion: client.authentication.k8s.io/v1beta1
      command: aws
      args: [eks, get-token, --cluster-name, prod]
      env:
      - {name: AWS_PROFILE, value: prod-admin}
      - {name: AWS_SECRET_ACCESS_KEY, value: exec-env-secret}
- name: eks-args-user
  user:
    exec:
      apiVersion: client.authentication.k8s.io/v1beta1
      command: /opt/aws/bin/aws
      args: [eks, get-token, --profile=dev, --cluster-name, dev]
- name: kind-user
  user:
    client-certificate: client.crt
    client-key: missing.key
- name: gke-user
  user:
    auth-provider:
      name: gcp
      config: {access-token: gcp-secret-token}
- name: azure-user
  user:
    auth-provider:
      name: azure
      config: {apiserver-id: x}
- name: basic-user
  user:
    username: admin
    password: basic-secret-password
- name: oidc-user
  user:
    exec:
      apiVersion: client.authentication.k8s.io/v1beta1
      command: kubectl
      args: [oidc-login, get-token]
"#;
        let report = describe_yaml(dir.path(), yaml, &["aws"]);
        let by_name = |name: &str| report.contexts.iter().find(|c| c.name == name).unwrap();

        let eks = by_name("eks-prod");
        assert_eq!(
            eks.auth,
            AuthSummary {
                kind: AuthKind::Exec,
                command: Some("aws".into()),
                aws_profile: Some("prod-admin".into()),
            }
        );
        // The relative CA path resolves next to the kubeconfig.
        assert!(eks.problems.is_empty(), "{:?}", eks.problems);

        let args = by_name("eks-args");
        assert_eq!(args.auth.command.as_deref(), Some("aws"));
        assert_eq!(args.auth.aws_profile.as_deref(), Some("dev"));
        assert_eq!(codes(args), vec!["execNotFound"]);
        assert!(args.problems[0].message.contains("/opt/aws/bin/aws"));

        let kind = by_name("kind");
        assert_eq!(kind.auth.kind, AuthKind::ClientCert);
        assert_eq!(codes(kind), vec!["insecureSkipTls", "fileRefMissing"]);
        assert!(kind.problems[1].message.contains("missing.key"));
        assert_eq!(kind.problems[1].severity, Severity::Error);

        let gke = by_name("gke-legacy");
        assert_eq!(gke.auth.kind, AuthKind::AuthProvider);
        assert_eq!(codes(gke), vec!["removedAuthProvider"]);
        assert!(gke.problems[0].message.contains("gke-gcloud-auth-plugin"));
        assert!(by_name("azure-legacy").problems[0]
            .message
            .contains("kubelogin"));

        let basic = by_name("basic");
        assert_eq!(basic.auth.kind, AuthKind::Basic);
        assert_eq!(codes(basic), vec!["basicAuth"]);
        assert_eq!(basic.problems[0].severity, Severity::Warning);

        let oidc = by_name("oidc");
        assert_eq!(codes(oidc), vec!["execNotFound"]);
        assert!(oidc.problems[0].message.contains("\"kubectl\""));

        let json = serde_json::to_string(&report).unwrap();
        for secret in [
            "exec-env-secret",
            "gcp-secret-token",
            "basic-secret-password",
        ] {
            assert!(!json.contains(secret), "{secret} leaked");
        }
        assert!(json.contains("\"awsProfile\":\"prod-admin\""));
        assert!(json.contains("\"kind\":\"clientCert\""));
        assert!(json.contains("\"kind\":\"authProvider\""));
    }

    #[test]
    fn missing_clusters_and_users_are_errors() {
        let dir = tempfile::tempdir().unwrap();
        let yaml = r#"
apiVersion: v1
kind: Config
clusters:
- name: c
  cluster: {server: "https://c.example"}
contexts:
- name: no-user
  context: {cluster: c, user: ghost}
- name: no-cluster
  context: {cluster: gone, user: ""}
- name: empty
"#;
        let report = describe_yaml(dir.path(), yaml, &[]);
        assert_eq!(report.current_context, None);

        let no_user = &report.contexts[0];
        assert_eq!(codes(no_user), vec!["userMissing"]);
        assert_eq!(no_user.problems[0].severity, Severity::Error);
        assert!(no_user.problems[0].message.contains("ghost"));
        assert_eq!(no_user.auth.kind, AuthKind::None);
        assert_eq!(no_user.server.as_deref(), Some("https://c.example"));

        let no_cluster = &report.contexts[1];
        assert_eq!(codes(no_cluster), vec!["clusterMissing"]);
        assert_eq!(no_cluster.server, None);

        assert_eq!(codes(&report.contexts[2]), vec!["clusterMissing"]);
    }

    #[test]
    fn yaml_errors_never_quote_the_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = write(
            dir.path(),
            "broken",
            "apiVersion: v1\nusers:\n- name: u\n  user:\n    token: [leaked-secret-value\n",
        );
        let error = Kubeconfig::read_from(&path).unwrap_err();
        let message = read_error_message(&error);
        assert!(message.starts_with("Not a valid kubeconfig"), "{message}");
        assert!(!message.contains("leaked-secret-value"), "{message}");

        let missing = Kubeconfig::read_from(dir.path().join("nope")).unwrap_err();
        assert_eq!(read_error_message(&missing), "The file does not exist.");
    }

    #[test]
    fn discovers_default_env_directory_and_config_d() {
        let home = tempfile::tempdir().unwrap();
        let kube = home.path().join(".kube");
        std::fs::create_dir_all(kube.join("config.d")).unwrap();
        std::fs::create_dir_all(kube.join("cache")).unwrap();
        std::fs::create_dir_all(kube.join("jet-pilot")).unwrap();
        let config = write(&kube, "config", TOKEN_CONFIG);
        write(
            &kube,
            "staging.yaml",
            &TOKEN_CONFIG.replace("do-ams3", "staging"),
        );
        write(&kube, "kind.KUBECONFIG", TOKEN_CONFIG);
        // Unrelated or broken YAML in the globs is dropped silently.
        write(
            &kube,
            "docker-compose.yml",
            "services:\n  web:\n    image: nginx\n",
        );
        write(&kube, "broken.yaml", "{ not: [yaml");
        write(&kube, "notes.txt", TOKEN_CONFIG);
        write(&kube, ".hidden.yaml", TOKEN_CONFIG);
        write(&kube.join("cache"), "nested.yaml", TOKEN_CONFIG);
        write(&kube.join("jet-pilot"), "config.yaml", TOKEN_CONFIG);
        let big = std::fs::File::create(kube.join("huge.yaml")).unwrap();
        big.set_len(MAX_GLOBBED_BYTES + 1).unwrap();
        write(&kube.join("config.d"), "prod", TOKEN_CONFIG);
        write(&kube.join("config.d"), "readme.md", "# just docs");

        let elsewhere = tempfile::tempdir().unwrap();
        let env_file = write(elsewhere.path(), "team.yaml", TOKEN_CONFIG);
        let env_broken = write(elsewhere.path(), "broken.yaml", "{ not: [yaml");
        let env = std::env::join_paths([
            config.clone(),
            env_file.clone(),
            PathBuf::new(),
            env_broken.clone(),
            elsewhere.path().join("missing.yaml"),
            kube.join("staging.yaml"),
        ])
        .unwrap();

        let found = discover(Some(&kube), Some(&env));
        let summary: Vec<(String, Origin, bool)> = found
            .iter()
            .map(|f| {
                let name = Path::new(&f.path)
                    .file_name()
                    .unwrap()
                    .to_string_lossy()
                    .into_owned();
                (name, f.origin, f.readable)
            })
            .collect();
        assert_eq!(
            summary,
            vec![
                ("config".to_string(), Origin::Default, true),
                ("team.yaml".to_string(), Origin::Env, true),
                ("broken.yaml".to_string(), Origin::Env, false),
                ("missing.yaml".to_string(), Origin::Env, false),
                // Listed in $KUBECONFIG first, so it keeps the env origin.
                ("staging.yaml".to_string(), Origin::Env, true),
                ("kind.KUBECONFIG".to_string(), Origin::Directory, true),
                ("prod".to_string(), Origin::ConfigD, true),
            ]
        );
        assert_eq!(found[0].context_count, 1);
        assert_eq!(found[0].context_names, vec!["do-ams3"]);
        assert_eq!(found[4].context_names, vec!["staging"]);
        assert!(found[2]
            .error
            .as_deref()
            .unwrap()
            .starts_with("Not a valid kubeconfig"));
        assert_eq!(found[3].error.as_deref(), Some("The file does not exist."));

        let json = serde_json::to_value(&found[6]).unwrap();
        assert_eq!(json["origin"], "configD");
        assert_eq!(json["contextCount"], 1);
    }

    #[test]
    fn missing_default_kubeconfig_is_skipped_and_names_are_capped() {
        let home = tempfile::tempdir().unwrap();
        let kube = home.path().join(".kube");
        std::fs::create_dir_all(&kube).unwrap();
        assert!(discover(Some(&kube), None).is_empty());
        assert!(discover(None, None).is_empty());

        let mut yaml = String::from("apiVersion: v1\nkind: Config\ncontexts:\n");
        for i in 0..80 {
            yaml.push_str(&format!(
                "- name: ctx-{i}\n  context: {{cluster: c, user: u}}\n"
            ));
        }
        write(&kube, "many.yaml", &yaml);
        let found = discover(Some(&kube), None);
        assert_eq!(found[0].context_count, 80);
        assert_eq!(found[0].context_names.len(), MAX_CONTEXT_NAMES);
    }
}

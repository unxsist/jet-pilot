//! Importing a kubeconfig (pasted text or a file) into the managed
//! kubeconfig, in two steps:
//!
//! 1. `kubeconfig_import_preview` parses it (at most 1 MiB), describes each
//!    context (auth, problems, exec command to confirm, duplicates of
//!    contexts already loaded, name conflicts) and keeps the parsed document
//!    server-side for 10 minutes under a `previewId`, so credentials never
//!    travel back through the webview.
//! 2. `kubeconfig_import_commit` copies the chosen contexts: CA files are
//!    inlined, tokens / client certificates / keys move to the vault (users
//!    then run `jetpilot-auth credential static`), exec plugins with secret
//!    environment variables are wrapped (`credential wrap-exec`, the secret
//!    env in the vault), other exec plugins are copied with their command
//!    resolved to an absolute path so external terminals find it.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use base64::Engine;
use kube::config::{
    AuthInfo, Cluster, Context, ExecConfig, Kubeconfig, NamedAuthInfo, NamedCluster, NamedContext,
};
use once_cell::sync::Lazy;
use secrecy::ExposeSecret;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use jp_auth_core::credentials::{
    env_secret_id, is_secret_env_name, static_secret_id, StaticCredential,
};

use super::error::AppError;
use super::managed_kubeconfig::{self as managed, ClusterMeta};
use super::naming;
use crate::kubeconfig_discovery::{self, AuthSummary, Problem, Severity};
use crate::probe::ContextRef;
use crate::util::lock;

const MAX_IMPORT_BYTES: u64 = 1024 * 1024;
const PREVIEW_TTL: Duration = Duration::from_secs(10 * 60);

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ImportSource {
    Text { text: String },
    Path { path: String },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportPreview {
    pub preview_id: String,
    pub contexts: Vec<ImportContext>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportContext {
    pub name: String,
    pub cluster: String,
    pub server: Option<String>,
    pub user: String,
    pub namespace: Option<String>,
    pub auth: AuthSummary,
    /// Contexts with an `error` problem can't be imported.
    pub problems: Vec<Problem>,
    /// The same server and identity is already loaded here.
    pub duplicate_of: Option<ContextRef>,
    /// A context with this name is already loaded.
    pub name_conflict: bool,
    /// The name it gets unless renamed (unique, `-2` suffixes).
    pub suggested_name: String,
    /// The program an exec credential plugin runs (to confirm before
    /// importing: it executes code).
    pub exec_command: Option<ExecCommand>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecCommand {
    pub command: String,
    pub args: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportChoice {
    pub context: String,
    pub include: bool,
    #[serde(default)]
    pub rename: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
    pub added: Vec<ContextRef>,
}

#[derive(Clone)]
pub(crate) struct StoredPreview {
    created: Instant,
    pub config: Kubeconfig,
    pub source_path: Option<String>,
    pub contexts: Vec<ImportContext>,
}

static PREVIEWS: Lazy<Mutex<HashMap<String, StoredPreview>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

fn purge(previews: &mut HashMap<String, StoredPreview>) {
    previews.retain(|_, p| p.created.elapsed() < PREVIEW_TTL);
}

/* --------------------------------------------------------- known names */

/// Context names and identity fingerprints of every loaded kubeconfig (the
/// managed one and those discovery finds).
#[derive(Debug, Default, Clone)]
pub(crate) struct Known {
    pub names: HashSet<String>,
    pub fingerprints: HashMap<String, ContextRef>,
}

impl Known {
    pub(crate) fn load() -> Known {
        let managed_path = managed::managed_path();
        let mut configs = Vec::new();
        if let Ok(doc) = managed::read(&managed_path) {
            configs.push((managed_path.to_string_lossy().into_owned(), doc));
        }
        for path in kubeconfig_discovery::known_kubeconfig_paths() {
            if path == managed_path {
                continue;
            }
            if let Ok(doc) = Kubeconfig::read_from(&path) {
                configs.push((path.to_string_lossy().into_owned(), doc));
            }
        }
        Known::from_configs(configs)
    }

    pub(crate) fn from_configs(configs: Vec<(String, Kubeconfig)>) -> Known {
        let mut known = Known::default();
        for (path, doc) in configs {
            for context in &doc.contexts {
                known.names.insert(context.name.clone());
                if let Some(fp) = managed::context_fingerprint(&doc, context) {
                    known.fingerprints.entry(fp).or_insert_with(|| ContextRef {
                        kube_config: path.clone(),
                        context: context.name.clone(),
                    });
                }
            }
        }
        known
    }
}

/* ------------------------------------------------------------- preview */

fn too_large(field: &str) -> AppError {
    AppError::invalid(field, "The kubeconfig is larger than 1 MiB.")
}

/// Reads and parses the source; the path of a file source.
pub(crate) fn load_source(source: ImportSource) -> Result<(Kubeconfig, Option<String>), AppError> {
    let (config, path, field) = match source {
        ImportSource::Text { text } => {
            if text.len() as u64 > MAX_IMPORT_BYTES {
                return Err(too_large("text"));
            }
            let config = managed::parse(&text).map_err(|m| AppError::invalid("text", m))?;
            (config, None, "text")
        }
        ImportSource::Path { path } => {
            let meta = std::fs::metadata(&path)
                .map_err(|e| AppError::invalid("path", format!("{path} can't be read: {e}")))?;
            if !meta.is_file() {
                return Err(AppError::invalid("path", format!("{path} is not a file.")));
            }
            if meta.len() > MAX_IMPORT_BYTES {
                return Err(too_large("path"));
            }
            // read_from resolves relative file references next to the file.
            let config = Kubeconfig::read_from(&path).map_err(|e| {
                AppError::invalid("path", kubeconfig_discovery::read_error_message(&e))
            })?;
            (config, Some(path), "path")
        }
    };
    if config.contexts.is_empty() {
        return Err(AppError::invalid(
            field,
            "There are no contexts in this kubeconfig.",
        ));
    }
    Ok((config, path))
}

fn user_of<'a>(config: &'a Kubeconfig, context: &NamedContext) -> Option<&'a AuthInfo> {
    let name = context.context.as_ref()?.user.as_deref()?;
    config
        .auth_infos
        .iter()
        .find(|u| u.name == name)
        .and_then(|u| u.auth_info.as_ref())
}

pub(crate) fn build_preview(
    config: &Kubeconfig,
    label: &str,
    known: &Known,
    command_on_path: &dyn Fn(&str) -> bool,
) -> Vec<ImportContext> {
    let report = kubeconfig_discovery::describe(label, config, command_on_path);
    let mut taken = known.names.clone();
    report
        .contexts
        .into_iter()
        .zip(config.contexts.iter())
        .map(|(summary, named)| {
            let user = user_of(config, named);
            let mut problems = summary.problems;
            if let Some(provider) = user.and_then(|u| u.auth_provider.as_ref()) {
                if !problems.iter().any(|p| p.code == "removedAuthProvider") {
                    problems.push(Problem {
                        code: "authProviderUnsupported".to_string(),
                        severity: Severity::Error,
                        message: format!(
                            "The \"{}\" auth provider can't be imported. Use an exec credential plugin instead.",
                            provider.name
                        ),
                    });
                }
            }
            let exec_command = user.and_then(|u| u.exec.as_ref()).map(|exec| ExecCommand {
                command: exec.command.clone().unwrap_or_default(),
                args: exec.args.iter().flatten().map(|a| jp_auth_core::redact(a)).collect(),
            });
            let duplicate_of = managed::context_fingerprint(config, named)
                .and_then(|fp| known.fingerprints.get(&fp).cloned());
            let suggested_name = naming::unique_name(&summary.name, &taken);
            taken.insert(suggested_name.clone());
            ImportContext {
                name_conflict: known.names.contains(&summary.name),
                name: summary.name,
                cluster: summary.cluster,
                server: summary.server,
                user: summary.user,
                namespace: summary.namespace,
                auth: summary.auth,
                problems,
                duplicate_of,
                suggested_name,
                exec_command,
            }
        })
        .collect()
}

/// Parses a source and describes its contexts (see the module docs).
#[tauri::command]
pub async fn kubeconfig_import_preview(source: ImportSource) -> Result<ImportPreview, AppError> {
    super::blocking(move || {
        let (config, source_path) = load_source(source)?;
        let known = Known::load();
        let label = source_path
            .clone()
            .unwrap_or_else(|| "pasted kubeconfig".to_string());
        let contexts = build_preview(&config, &label, &known, &|c| which::which(c).is_ok());
        let preview_id = uuid::Uuid::new_v4().to_string();
        let mut previews = lock(&PREVIEWS);
        purge(&mut previews);
        previews.insert(
            preview_id.clone(),
            StoredPreview {
                created: Instant::now(),
                config,
                source_path,
                contexts: contexts.clone(),
            },
        );
        Ok(ImportPreview {
            preview_id,
            contexts,
        })
    })
    .await
}

/* -------------------------------------------------------------- commit */

/// One context ready to be written.
pub(crate) struct Planned {
    pub name: String,
    pub cluster: NamedCluster,
    pub user: NamedAuthInfo,
    pub context: NamedContext,
    pub secrets: Vec<(String, Value)>,
}

impl std::fmt::Debug for Planned {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Planned")
            .field("name", &self.name)
            .field("secrets", &self.secrets.len())
            .finish()
    }
}

fn decode_base64(data: &str, what: &str) -> Result<String, AppError> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data.trim())
        .map_err(|_| {
            AppError::invalid("context", format!("The {what} data is not valid base64."))
        })?;
    String::from_utf8(bytes)
        .map_err(|_| AppError::invalid("context", format!("The {what} data is not PEM text.")))
}

fn read_text(path: &str, what: &str) -> Result<String, AppError> {
    let bytes = managed::read_small_file(path)
        .map_err(|e| AppError::io(format!("The {what} file {path} can't be read"), e))?;
    String::from_utf8(bytes)
        .map_err(|_| AppError::invalid("context", format!("The {what} file {path} is not text.")))
}

/// The cluster with a CA file inlined as `certificate-authority-data`.
pub(crate) fn convert_cluster(cluster: Option<&Cluster>) -> Result<Cluster, AppError> {
    let mut out = cluster.cloned().unwrap_or_default();
    let ca_file = out.certificate_authority.take();
    if out.certificate_authority_data.is_none() {
        if let Some(path) = ca_file.filter(|p| !p.is_empty()) {
            let bytes = managed::read_small_file(&path).map_err(|e| {
                AppError::io(
                    format!("The certificate authority file {path} can't be read"),
                    e,
                )
            })?;
            out.certificate_authority_data =
                Some(base64::engine::general_purpose::STANDARD.encode(bytes));
        }
    }
    Ok(out)
}

fn is_bare_command(command: &str) -> bool {
    !command.contains('/') && !command.contains('\\')
}

/// The user rewritten for the managed kubeconfig, and the secrets to store
/// for it. `resolve` finds a bare exec command on `PATH`.
pub(crate) fn convert_user(
    id: &str,
    auth: Option<&AuthInfo>,
    helper: &Path,
    resolve: &dyn Fn(&str) -> Option<PathBuf>,
) -> Result<(AuthInfo, Vec<(String, Value)>), AppError> {
    let Some(auth) = auth else {
        return Ok((AuthInfo::default(), Vec::new()));
    };
    // Keep what isn't a credential (impersonation, extensions, unknown
    // fields); basic auth and legacy auth providers are dropped.
    let mut out = AuthInfo {
        impersonate: auth.impersonate.clone(),
        impersonate_uid: auth.impersonate_uid.clone(),
        impersonate_groups: auth.impersonate_groups.clone(),
        impersonate_user_extra: auth.impersonate_user_extra.clone(),
        extensions: auth.extensions.clone(),
        other: auth.other.clone(),
        ..AuthInfo::default()
    };
    let mut secrets = Vec::new();

    if let Some(exec) = &auth.exec {
        let command = exec
            .command
            .clone()
            .filter(|c| !c.is_empty())
            .ok_or_else(|| AppError::invalid("context", "The credential plugin has no command."))?;
        let resolved = if is_bare_command(&command) {
            resolve(&command)
                .map(|p| p.to_string_lossy().into_owned())
                .unwrap_or(command)
        } else {
            command
        };
        let (secret_env, plain_env): (Vec<_>, Vec<_>) = exec
            .env
            .clone()
            .unwrap_or_default()
            .into_iter()
            .partition(|e| e.get("name").is_some_and(|n| is_secret_env_name(n)));
        if secret_env.is_empty() {
            out.exec = Some(ExecConfig {
                command: Some(resolved),
                ..exec.clone()
            });
        } else {
            let env: BTreeMap<String, String> = secret_env
                .into_iter()
                .filter_map(|e| {
                    Some((
                        e.get("name")?.clone(),
                        e.get("value").cloned().unwrap_or_default(),
                    ))
                })
                .collect();
            secrets.push((
                env_secret_id(id),
                serde_json::to_value(env).expect("env serializes"),
            ));
            out.exec = Some(managed::wrap_exec(id, helper, exec, &resolved, plain_env));
        }
        return Ok((out, secrets));
    }

    let token = match (&auth.token, auth.token_file.as_deref()) {
        (Some(token), _) => Some(token.expose_secret().trim().to_string()),
        (None, Some(path)) if !path.is_empty() => {
            Some(read_text(path, "token")?.trim().to_string())
        }
        _ => None,
    };
    let cert = match (
        &auth.client_certificate_data,
        auth.client_certificate.as_deref(),
    ) {
        (Some(data), _) => Some(decode_base64(data, "client certificate")?),
        (None, Some(path)) if !path.is_empty() => Some(read_text(path, "client certificate")?),
        _ => None,
    };
    let key = match (&auth.client_key_data, auth.client_key.as_deref()) {
        (Some(data), _) => Some(decode_base64(data.expose_secret(), "client key")?),
        (None, Some(path)) if !path.is_empty() => Some(read_text(path, "client key")?),
        _ => None,
    };
    if cert.is_some() != key.is_some() {
        return Err(AppError::invalid(
            "context",
            "A client certificate needs both the certificate and its key.",
        ));
    }
    let credential = StaticCredential {
        token: token.filter(|t| !t.is_empty()),
        client_certificate_pem: cert,
        client_key_pem: key,
    };
    if !credential.is_empty() {
        secrets.push((
            static_secret_id(id),
            serde_json::to_value(&credential).expect("credentials serialize"),
        ));
        out.exec = Some(managed::static_exec(id, helper));
    }
    Ok((out, secrets))
}

/// Turns the chosen contexts of a preview into managed entries.
pub(crate) fn plan_import(
    preview: &StoredPreview,
    choices: &[ImportChoice],
    known: &Known,
    helper: &Path,
    resolve: &dyn Fn(&str) -> Option<PathBuf>,
) -> Result<Vec<Planned>, AppError> {
    let config = &preview.config;
    let mut taken = known.names.clone();
    let mut planned = Vec::new();
    for choice in choices.iter().filter(|c| c.include) {
        let field = choice.context.as_str();
        let summary = preview
            .contexts
            .iter()
            .find(|c| c.name == choice.context)
            .ok_or_else(|| {
                AppError::not_found(format!("\"{field}\" is not in this kubeconfig."))
            })?;
        if let Some(problem) = summary
            .problems
            .iter()
            .find(|p| p.severity == Severity::Error)
        {
            return Err(AppError::invalid(
                field,
                format!("\"{field}\" can't be imported: {}", problem.message),
            ));
        }
        let name = match choice
            .rename
            .as_deref()
            .map(str::trim)
            .filter(|r| !r.is_empty())
        {
            Some(rename) => {
                let name = naming::validate_context_name(rename, field)?;
                if taken.contains(&name) {
                    return Err(AppError::invalid(
                        field,
                        format!("Another context is already called \"{name}\"."),
                    ));
                }
                name
            }
            None => naming::unique_name(&summary.name, &taken),
        };
        taken.insert(name.clone());

        let named = config
            .contexts
            .iter()
            .find(|c| c.name == choice.context)
            .ok_or_else(|| {
                AppError::not_found(format!("\"{field}\" is not in this kubeconfig."))
            })?;
        let source_context = named.context.clone().unwrap_or_default();
        let cluster = config
            .clusters
            .iter()
            .find(|c| c.name == source_context.cluster)
            .and_then(|c| c.cluster.as_ref());

        let id = naming::new_cluster_id();
        let internal = naming::internal_name(&id);
        let with_field = |e: AppError| {
            if e.field.as_deref() == Some("context") {
                e.with_field(field)
            } else {
                e
            }
        };
        let cluster = convert_cluster(cluster).map_err(with_field)?;
        let (user, secrets) =
            convert_user(&id, user_of(config, named), helper, resolve).map_err(with_field)?;

        let mut context = Context {
            cluster: internal.clone(),
            user: Some(internal.clone()),
            namespace: source_context.namespace.clone(),
            extensions: source_context.extensions.clone(),
            other: source_context.other.clone(),
        };
        managed::set_meta(
            &mut context,
            &ClusterMeta {
                id,
                origin: "import".to_string(),
                added_at: managed::now_ms(),
                source_path: preview.source_path.clone(),
                fingerprint: managed::context_fingerprint(config, named),
            },
        );
        planned.push(Planned {
            name: name.clone(),
            cluster: NamedCluster {
                name: internal.clone(),
                cluster: Some(cluster),
                other: managed::no_other(),
            },
            user: NamedAuthInfo {
                name: internal,
                auth_info: Some(user),
                other: managed::no_other(),
            },
            context: NamedContext {
                name,
                context: Some(context),
                other: named.other.clone(),
            },
            secrets,
        });
    }
    if planned.is_empty() {
        return Err(AppError::invalid(
            "choices",
            "Choose at least one context to add.",
        ));
    }
    Ok(planned)
}

/// Stores the secrets, then writes the entries (removing the secrets again
/// when the kubeconfig write fails).
pub(crate) fn apply(planned: Vec<Planned>, path: &Path) -> Result<Vec<ContextRef>, AppError> {
    let secrets: Vec<(String, Value)> = planned.iter().flat_map(|p| p.secrets.clone()).collect();
    let ids: Vec<String> = secrets.iter().map(|(id, _)| id.clone()).collect();
    crate::secrets::put_many(secrets)?;
    let path_text = path.to_string_lossy().into_owned();
    let result = managed::update(path, |doc| {
        for p in &planned {
            if managed::context_names(doc).any(|n| n == p.name) {
                return Err(AppError::conflict(format!(
                    "A cluster called \"{}\" was added meanwhile. Try again.",
                    p.name
                )));
            }
        }
        let mut added = Vec::new();
        for p in planned {
            added.push(ContextRef {
                kube_config: path_text.clone(),
                context: p.name.clone(),
            });
            doc.clusters.push(p.cluster);
            doc.auth_infos.push(p.user);
            doc.contexts.push(p.context);
        }
        if doc.current_context.as_deref().is_none_or(str::is_empty) {
            doc.current_context = added.first().map(|r| r.context.clone());
        }
        Ok(added)
    });
    if result.is_err() {
        let _ = crate::secrets::remove_many(&ids);
    }
    result
}

/// Adds the chosen contexts of a preview to the managed kubeconfig. A
/// preview stays usable until it expires or is committed, so a commit that
/// failed on a locked vault can be retried after unlocking.
#[tauri::command]
pub async fn kubeconfig_import_commit(
    preview_id: String,
    choices: Vec<ImportChoice>,
) -> Result<ImportResult, AppError> {
    super::blocking(move || {
        let preview = {
            let mut previews = lock(&PREVIEWS);
            purge(&mut previews);
            previews.get(&preview_id).cloned()
        }
        .ok_or_else(|| {
            AppError::not_found("This import expired. Paste or choose the kubeconfig again.")
        })?;
        let known = Known::load();
        let helper = jp_auth_core::paths::helper_path();
        let planned = plan_import(&preview, &choices, &known, &helper, &|c| {
            which::which(c).ok()
        })?;
        let added = apply(planned, &managed::managed_path())?;
        lock(&PREVIEWS).remove(&preview_id);
        Ok(ImportResult { added })
    })
    .await
}

#[cfg(test)]
pub(crate) fn stored_preview(
    config: Kubeconfig,
    source_path: Option<String>,
    contexts: Vec<ImportContext>,
) -> StoredPreview {
    StoredPreview {
        created: Instant::now(),
        config,
        source_path,
        contexts,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::auth::classify::InteractiveClass;
    use crate::kubeconfig_discovery::AuthKind;
    use crate::secrets::test_support::memory_env;
    use serde_json::json;

    const CERT_PEM: &str =
        "-----BEGIN CERTIFICATE-----\nMIIBszCCAVmgAwIBAgIUQ0VSVA==\n-----END CERTIFICATE-----\n";
    const KEY_PEM: &str =
        "-----BEGIN EC PRIVATE KEY-----\nMHcCAQEEIEtFWS1TRUNSRVQ=\n-----END EC PRIVATE KEY-----\n";

    fn b64(s: &str) -> String {
        base64::engine::general_purpose::STANDARD.encode(s)
    }

    fn fixture(dir: &Path) -> String {
        std::fs::write(dir.join("ca.crt"), "CA-FROM-FILE").unwrap();
        std::fs::write(dir.join("client.crt"), CERT_PEM).unwrap();
        std::fs::write(dir.join("client.key"), KEY_PEM).unwrap();
        std::fs::write(dir.join("token"), "file-token-secret\n").unwrap();
        format!(
            r#"
apiVersion: v1
kind: Config
current-context: tok
clusters:
- name: c-token
  cluster: {{server: "https://token.example:6443", certificate-authority-data: Q0E=, x-extra: kept}}
- name: c-files
  cluster: {{server: "https://files.example", certificate-authority: ca.crt}}
- name: c-eks
  cluster: {{server: "https://ABC.gr7.eu-west-1.eks.amazonaws.com"}}
contexts:
- name: tok
  context: {{cluster: c-token, user: u-token, namespace: web}}
- name: certdata
  context: {{cluster: c-token, user: u-certdata}}
- name: files
  context: {{cluster: c-files, user: u-files}}
- name: tokfile
  context: {{cluster: c-files, user: u-tokfile}}
- name: eks
  context: {{cluster: c-eks, user: u-aws}}
- name: eks-keys
  context: {{cluster: c-eks, user: u-aws-keys}}
- name: gke-legacy
  context: {{cluster: c-token, user: u-gcp}}
users:
- name: u-token
  user: {{token: inline-token-secret, as: admin}}
- name: u-certdata
  user: {{client-certificate-data: {cert}, client-key-data: {key}}}
- name: u-files
  user: {{client-certificate: client.crt, client-key: client.key}}
- name: u-tokfile
  user: {{tokenFile: token}}
- name: u-aws
  user:
    exec:
      apiVersion: client.authentication.k8s.io/v1beta1
      command: aws
      args: [eks, get-token, --cluster-name, prod]
      env: [{{name: AWS_PROFILE, value: prod-admin}}]
- name: u-aws-keys
  user:
    exec:
      apiVersion: client.authentication.k8s.io/v1beta1
      command: aws
      args: [eks, get-token, --cluster-name, prod]
      env:
      - {{name: AWS_REGION, value: eu-west-1}}
      - {{name: AWS_SECRET_ACCESS_KEY, value: aws-secret-value}}
      - {{name: AWS_SESSION_TOKEN, value: aws-session-value}}
- name: u-gcp
  user:
    auth-provider:
      name: gcp
      config: {{access-token: gcp-secret-token}}
"#,
            cert = b64(CERT_PEM),
            key = b64(KEY_PEM)
        )
    }

    fn on_path(command: &str) -> bool {
        command == "aws"
    }

    fn resolve(command: &str) -> Option<PathBuf> {
        (command == "aws").then(|| PathBuf::from("/usr/local/bin/aws"))
    }

    fn preview_of(dir: &Path, known: &Known) -> StoredPreview {
        let path = dir.join("import.yaml");
        std::fs::write(&path, fixture(dir)).unwrap();
        let (config, source) = load_source(ImportSource::Path {
            path: path.to_string_lossy().into_owned(),
        })
        .unwrap();
        let contexts = build_preview(&config, "import.yaml", known, &on_path);
        stored_preview(config, source, contexts)
    }

    fn include(names: &[&str]) -> Vec<ImportChoice> {
        names
            .iter()
            .map(|n| ImportChoice {
                context: n.to_string(),
                include: true,
                rename: None,
            })
            .collect()
    }

    #[test]
    fn preview_describes_contexts_without_secrets() {
        let dir = tempfile::tempdir().unwrap();
        let existing = managed::parse(
            r#"
contexts:
- name: tok
  context: {cluster: x, user: y}
clusters:
- name: x
  cluster: {server: "https://TOKEN.example:6443/"}
users:
- name: y
  user: {token: inline-token-secret}
"#,
        )
        .unwrap();
        let known = Known::from_configs(vec![("/home/me/.kube/config".into(), existing)]);
        let preview = preview_of(dir.path(), &known);
        let by_name = |n: &str| preview.contexts.iter().find(|c| c.name == n).unwrap();

        let tok = by_name("tok");
        assert!(tok.name_conflict);
        assert_eq!(tok.suggested_name, "tok-2");
        assert_eq!(
            tok.duplicate_of,
            Some(ContextRef {
                kube_config: "/home/me/.kube/config".into(),
                context: "tok".into()
            })
        );
        assert_eq!(tok.namespace.as_deref(), Some("web"));
        assert_eq!(tok.auth.kind, AuthKind::Token);

        let files = by_name("files");
        assert!(files.problems.is_empty(), "{:?}", files.problems);
        assert!(!files.name_conflict && files.duplicate_of.is_none());

        let eks = by_name("eks");
        assert_eq!(
            eks.exec_command,
            Some(ExecCommand {
                command: "aws".into(),
                args: ["eks", "get-token", "--cluster-name", "prod"]
                    .map(String::from)
                    .to_vec()
            })
        );
        assert_eq!(eks.auth.aws_profile.as_deref(), Some("prod-admin"));
        assert_eq!(eks.auth.interactive, InteractiveClass::NonInteractive);

        let gke = by_name("gke-legacy");
        assert_eq!(gke.problems[0].code, "removedAuthProvider");

        let json = serde_json::to_string(&preview.contexts).unwrap();
        for secret in [
            "inline-token-secret",
            "aws-secret-value",
            "gcp-secret-token",
            "file-token-secret",
            "S0VZ",
        ] {
            assert!(!json.contains(secret), "{secret} leaked");
        }
        assert!(json.contains("\"duplicateOf\":{\"kubeConfig\""));
        assert!(json.contains("\"suggestedName\":\"tok-2\""));
        assert!(json.contains("\"execCommand\""));
    }

    #[test]
    fn commit_moves_credentials_to_the_vault() {
        let _guard = lock(&crate::secrets::TEST_VAULT_LOCK);
        let dir = tempfile::tempdir().unwrap();
        let (env, _) = memory_env(dir.path(), true);
        crate::secrets::use_test_env(env);
        let managed_path = dir.path().join("jp").join("config");
        let helper = Path::new("/home/me/.kube/jet-pilot/bin/jetpilot-auth");

        let known = Known::default();
        let preview = preview_of(dir.path(), &known);
        let choices = include(&["tok", "certdata", "files", "tokfile", "eks", "eks-keys"]);
        let planned = plan_import(&preview, &choices, &known, helper, &resolve).unwrap();
        let added = apply(planned, &managed_path).unwrap();
        assert_eq!(added.len(), 6);
        assert_eq!(added[0].kube_config, managed_path.to_string_lossy());

        let text = std::fs::read_to_string(&managed_path).unwrap();
        for secret in [
            "inline-token-secret",
            "file-token-secret",
            "aws-secret-value",
            "aws-session-value",
            &b64(KEY_PEM),
            "S0VZ",
        ] {
            assert!(
                !text.contains(secret),
                "{secret} written to the managed kubeconfig"
            );
        }
        let doc = managed::parse(&text).unwrap();
        assert_eq!(doc.current_context.as_deref(), Some("tok"));
        let user_of_ctx = |name: &str| {
            let ctx = doc.contexts.iter().find(|c| c.name == name).unwrap();
            let user = ctx.context.as_ref().unwrap().user.clone().unwrap();
            assert!(user.starts_with("jetpilot-"));
            doc.auth_infos
                .iter()
                .find(|u| u.name == user)
                .unwrap()
                .auth_info
                .clone()
                .unwrap()
        };
        let meta = |name: &str| {
            managed::meta_of(doc.contexts.iter().find(|c| c.name == name).unwrap()).unwrap()
        };

        // Static credentials: helper user, secret in the vault.
        let tok = user_of_ctx("tok");
        assert_eq!(tok.impersonate.as_deref(), Some("admin"));
        let exec = tok.exec.unwrap();
        assert_eq!(exec.command.as_deref(), Some(helper.to_str().unwrap()));
        let id = meta("tok").id;
        assert_eq!(
            exec.args.unwrap(),
            vec!["credential", "static", "--id", &id]
        );
        assert_eq!(meta("tok").origin, "import");
        assert!(meta("tok").fingerprint.is_some());
        assert_eq!(
            crate::secrets::get(&static_secret_id(&id)).unwrap(),
            Some(json!({"token": "inline-token-secret"}))
        );
        let cert_id = meta("certdata").id;
        assert_eq!(
            crate::secrets::get(&static_secret_id(&cert_id)).unwrap(),
            Some(json!({"clientCertificatePem": CERT_PEM, "clientKeyPem": KEY_PEM}))
        );
        // Files were read and inlined.
        let files_id = meta("files").id;
        assert_eq!(
            crate::secrets::get(&static_secret_id(&files_id)).unwrap(),
            Some(json!({"clientCertificatePem": CERT_PEM, "clientKeyPem": KEY_PEM}))
        );
        let files_cluster = doc
            .clusters
            .iter()
            .find(|c| c.name == format!("jetpilot-{files_id}"))
            .unwrap()
            .cluster
            .clone()
            .unwrap();
        assert_eq!(files_cluster.certificate_authority, None);
        assert_eq!(
            files_cluster.certificate_authority_data,
            Some(b64("CA-FROM-FILE"))
        );
        assert_eq!(
            crate::secrets::get(&static_secret_id(&meta("tokfile").id)).unwrap(),
            Some(json!({"token": "file-token-secret"}))
        );
        // Unknown cluster fields survive.
        let tok_cluster = doc
            .clusters
            .iter()
            .find(|c| c.name == format!("jetpilot-{id}"))
            .unwrap();
        assert_eq!(
            tok_cluster.cluster.as_ref().unwrap().other.get("x-extra"),
            Some(&json!("kept"))
        );

        // Exec with AWS_PROFILE: copied, command made absolute.
        let eks = user_of_ctx("eks").exec.unwrap();
        assert_eq!(eks.command.as_deref(), Some("/usr/local/bin/aws"));
        assert_eq!(
            eks.args.unwrap(),
            vec!["eks", "get-token", "--cluster-name", "prod"]
        );
        assert_eq!(
            eks.env.unwrap()[0].get("value").map(String::as_str),
            Some("prod-admin")
        );

        // Exec with secret env: wrapped, secrets in the vault.
        let keys = user_of_ctx("eks-keys").exec.unwrap();
        let keys_id = meta("eks-keys").id;
        assert_eq!(keys.command.as_deref(), Some(helper.to_str().unwrap()));
        assert_eq!(
            keys.api_version.as_deref(),
            Some("client.authentication.k8s.io/v1beta1")
        );
        assert_eq!(
            keys.args.unwrap(),
            vec![
                "credential",
                "wrap-exec",
                "--id",
                &keys_id,
                "--",
                "/usr/local/bin/aws",
                "eks",
                "get-token",
                "--cluster-name",
                "prod"
            ]
        );
        let plain = keys.env.unwrap();
        assert_eq!(plain.len(), 1);
        assert_eq!(plain[0].get("name").map(String::as_str), Some("AWS_REGION"));
        assert_eq!(
            crate::secrets::get(&env_secret_id(&keys_id)).unwrap(),
            Some(
                json!({"AWS_SECRET_ACCESS_KEY": "aws-secret-value", "AWS_SESSION_TOKEN": "aws-session-value"})
            )
        );

        // A second import of the same file: duplicates and -2 names.
        let known = Known::from_configs(vec![(managed_path.to_string_lossy().into_owned(), doc)]);
        let again = preview_of(dir.path(), &known);
        let tok = again.contexts.iter().find(|c| c.name == "tok").unwrap();
        assert!(tok.name_conflict);
        assert_eq!(tok.suggested_name, "tok-2");
        assert_eq!(tok.duplicate_of.as_ref().unwrap().context, "tok");
        let eks = again
            .contexts
            .iter()
            .find(|c| c.name == "eks-keys")
            .unwrap();
        assert_eq!(eks.duplicate_of.as_ref().unwrap().context, "eks-keys");
    }

    #[test]
    fn commit_validates_choices() {
        let dir = tempfile::tempdir().unwrap();
        let known = Known::from_configs(vec![(
            "/k".into(),
            managed::parse("contexts:\n- name: taken\n  context: {cluster: c, user: u}\n").unwrap(),
        )]);
        let preview = preview_of(dir.path(), &known);
        let helper = Path::new("/h/jetpilot-auth");

        let err = plan_import(
            &preview,
            &include(&["gke-legacy"]),
            &known,
            helper,
            &resolve,
        )
        .unwrap_err();
        assert_eq!(err.field.as_deref(), Some("gke-legacy"));
        assert!(err.message.contains("can't be imported"));

        let err = plan_import(&preview, &include(&["nope"]), &known, helper, &resolve).unwrap_err();
        assert_eq!(err.code, crate::clusters::error::AppErrorCode::NotFound);

        let none: Vec<ImportChoice> = vec![ImportChoice {
            context: "tok".into(),
            include: false,
            rename: None,
        }];
        assert_eq!(
            plan_import(&preview, &none, &known, helper, &resolve)
                .unwrap_err()
                .field
                .as_deref(),
            Some("choices")
        );

        let rename = |to: &str| {
            vec![ImportChoice {
                context: "tok".into(),
                include: true,
                rename: Some(to.into()),
            }]
        };
        let err = plan_import(&preview, &rename("taken"), &known, helper, &resolve).unwrap_err();
        assert_eq!(err.field.as_deref(), Some("tok"));
        let planned = plan_import(&preview, &rename("  mine  "), &known, helper, &resolve).unwrap();
        assert_eq!(planned[0].name, "mine");

        // Two contexts can't be renamed to the same name.
        let mut both = rename("same");
        both.push(ImportChoice {
            context: "eks".into(),
            include: true,
            rename: Some("same".into()),
        });
        assert!(plan_import(&preview, &both, &known, helper, &resolve).is_err());
    }

    #[test]
    fn sources_are_capped_and_multi_document_text_is_merged() {
        let big = "#".repeat(MAX_IMPORT_BYTES as usize + 1);
        assert_eq!(
            load_source(ImportSource::Text { text: big })
                .unwrap_err()
                .field
                .as_deref(),
            Some("text")
        );
        let err = load_source(ImportSource::Text {
            text: "users:\n- name: u\n  user:\n    token: [leaked-secret\n".into(),
        })
        .unwrap_err();
        assert!(!err.message.contains("leaked-secret"), "{}", err.message);
        assert!(load_source(ImportSource::Text {
            text: "kind: Config\n".into()
        })
        .is_err());
        assert_eq!(
            load_source(ImportSource::Path {
                path: "/definitely/not/here".into()
            })
            .unwrap_err()
            .field
            .as_deref(),
            Some("path")
        );

        let multi = "contexts:\n- name: a\n  context: {cluster: ca, user: ua}\n---\ncontexts:\n- name: b\n  context: {cluster: cb, user: ub}\nclusters:\n- name: cb\n  cluster: {server: \"https://b.example\"}\nusers:\n- name: ub\n  user: {}\n";
        let (config, path) = load_source(ImportSource::Text { text: multi.into() }).unwrap();
        assert_eq!(path, None);
        let names: Vec<_> = config.contexts.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(names, vec!["a", "b"]);
        let preview = build_preview(&config, "pasted", &Known::default(), &on_path);
        assert_eq!(preview[0].problems[0].code, "clusterMissing");
        assert!(preview[1].problems.is_empty());
        assert_eq!(preview[1].server.as_deref(), Some("https://b.example"));

        let source: ImportSource =
            serde_json::from_value(json!({"kind": "text", "text": "x"})).unwrap();
        assert!(matches!(source, ImportSource::Text { .. }));
        let source: ImportSource =
            serde_json::from_value(json!({"kind": "path", "path": "/x"})).unwrap();
        assert!(matches!(source, ImportSource::Path { .. }));
    }
}

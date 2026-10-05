//! The managed kubeconfig, `~/.kube/jet-pilot/config` (0600, directory
//! 0700): clusters added in JET Pilot, usable from external terminals too.
//!
//! - Cluster and user entries are named `jetpilot-<clusterId>`; the context
//!   carries the human name and our metadata in its `extensions`
//!   (`jet-pilot.app/cluster`), which kubectl preserves. Entries we didn't
//!   write are left alone.
//! - It never contains secrets: tokens and keys live in the vault and users
//!   run the `jetpilot-auth` helper. [`update`] refuses to write inline
//!   credentials.
//! - Writes follow client-go's convention (an `O_EXCL` `config.lock` next to
//!   the file, removed afterwards), so kubectl writing the same file (e.g.
//!   `kubectl config use-context`) never interleaves with us: read, mutate,
//!   check, serialize, temp file + fsync + rename, then
//!   `clusters://managed-changed`.
//!
//! The document is kube-rs' `Kubeconfig`, which keeps unknown fields
//! (`other`) and extensions, serialized with serde-saphyr.

use std::collections::BTreeMap;
use std::fs::OpenOptions;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime};

use kube::config::{
    AuthInfo, Context, ExecConfig, ExecInteractiveMode, Kubeconfig, NamedContext, NamedExtension,
};
use secrecy::ExposeSecret;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::error::AppError;
use super::naming::INTERNAL_PREFIX;

/// Context extension with our metadata.
pub const EXTENSION_CLUSTER: &str = "jet-pilot.app/cluster";
pub const INSTALL_HINT: &str =
    "Added with JET Pilot. Open JET Pilot to reinstall its credential helper.";
pub const MANAGED_CHANGED_EVENT: &str = "clusters://managed-changed";

const LOCK_WAIT: Duration = Duration::from_secs(5);
/// A lock file older than this was left by a crashed writer.
const STALE_LOCK: Duration = Duration::from_secs(60);

/// `~/.kube/jet-pilot/config`.
pub fn managed_path() -> PathBuf {
    jp_auth_core::paths::managed_kubeconfig()
}

/// Metadata of a cluster added in JET Pilot.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClusterMeta {
    pub id: String,
    /// `import` | `manual`
    pub origin: String,
    /// Milliseconds since the epoch.
    pub added_at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_path: Option<String>,
    /// Server + identity fingerprint, for duplicate detection (a truncated
    /// hash; never reversible to a credential).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fingerprint: Option<String>,
}

/// A cluster of the managed kubeconfig, for the hub.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedCluster {
    pub context: String,
    pub cluster_id: String,
    pub origin: String,
    /// Milliseconds since the epoch.
    pub added_at: i64,
    pub server: Option<String>,
}

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or_default()
}

/* ------------------------------------------------------------- metadata */

pub fn meta_of(context: &NamedContext) -> Option<ClusterMeta> {
    context
        .context
        .as_ref()?
        .extensions
        .as_ref()?
        .iter()
        .find(|ext| ext.name == EXTENSION_CLUSTER)
        .and_then(|ext| serde_json::from_value(ext.extension.clone()).ok())
}

pub fn set_meta(context: &mut Context, meta: &ClusterMeta) {
    let extension = serde_json::to_value(meta).expect("metadata always serializes");
    let extensions = context.extensions.get_or_insert_with(Vec::new);
    extensions.retain(|ext| ext.name != EXTENSION_CLUSTER);
    extensions.push(NamedExtension {
        name: EXTENSION_CLUSTER.to_string(),
        extension,
    });
}

/// The clusters JET Pilot added (contexts with our metadata).
pub fn list(doc: &Kubeconfig) -> Vec<ManagedCluster> {
    doc.contexts
        .iter()
        .filter_map(|named| {
            let meta = meta_of(named)?;
            let cluster_name = named.context.as_ref().map(|c| c.cluster.as_str())?;
            let server = doc
                .clusters
                .iter()
                .find(|c| c.name == cluster_name)
                .and_then(|c| c.cluster.as_ref()?.server.clone());
            Some(ManagedCluster {
                context: named.name.clone(),
                cluster_id: meta.id,
                origin: meta.origin,
                added_at: meta.added_at,
                server,
            })
        })
        .collect()
}

/* ----------------------------------------------------------- helper exec */

fn helper_command(helper: &Path) -> String {
    helper.to_string_lossy().into_owned()
}

/// `jetpilot-auth credential static --id <id>`.
pub fn static_exec(cluster_id: &str, helper: &Path) -> ExecConfig {
    ExecConfig {
        api_version: Some(jp_auth_core::exec_credential::API_VERSION_V1.to_string()),
        command: Some(helper_command(helper)),
        args: Some(jp_auth_core::request::static_args(cluster_id)),
        install_hint: Some(INSTALL_HINT.to_string()),
        interactive_mode: Some(ExecInteractiveMode::Never),
        ..ExecConfig::default()
    }
}

/// `jetpilot-auth credential wrap-exec --id <id> -- <command> <args>`,
/// keeping the original plugin's apiVersion (its output is passed through),
/// interactive mode and non-secret `env`.
pub fn wrap_exec(
    cluster_id: &str,
    helper: &Path,
    original: &ExecConfig,
    command: &str,
    plain_env: Vec<std::collections::HashMap<String, String>>,
) -> ExecConfig {
    let args = original.args.clone().unwrap_or_default();
    ExecConfig {
        api_version: original
            .api_version
            .clone()
            .or_else(|| Some(jp_auth_core::exec_credential::API_VERSION_V1BETA1.to_string())),
        command: Some(helper_command(helper)),
        args: Some(jp_auth_core::request::wrap_exec_args(
            cluster_id, command, &args,
        )),
        env: (!plain_env.is_empty()).then_some(plain_env),
        install_hint: Some(INSTALL_HINT.to_string()),
        interactive_mode: original.interactive_mode.clone(),
        provide_cluster_info: original.provide_cluster_info,
        other: original.other.clone(),
        ..ExecConfig::default()
    }
}

/// The helper request of an exec config that runs `jetpilot-auth`.
pub fn helper_request(exec: &ExecConfig) -> Option<jp_auth_core::request::Request> {
    let command = exec.command.as_deref()?;
    let file = Path::new(command).file_name()?.to_string_lossy();
    let file = file.strip_suffix(".exe").unwrap_or(&file);
    if file != jp_auth_core::HELPER_NAME {
        return None;
    }
    jp_auth_core::request::parse(exec.args.clone().unwrap_or_default()).ok()
}

/* ------------------------------------------------------- fingerprinting */

fn sha_hex(data: &[u8]) -> String {
    Sha256::digest(data)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// `https://host:443/` and `https://HOST` compare equal.
pub fn normalize_server(server: &str) -> String {
    let lower = server.trim().trim_end_matches('/').to_ascii_lowercase();
    match lower.strip_prefix("https://") {
        Some(rest) => format!("https://{}", rest.strip_suffix(":443").unwrap_or(rest)),
        None => lower,
    }
}

/// Reads a referenced file, at most 1 MiB.
pub fn read_small_file(path: &str) -> std::io::Result<Vec<u8>> {
    let meta = std::fs::metadata(path)?;
    if meta.len() > 1024 * 1024 {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "the file is larger than 1 MiB",
        ));
    }
    std::fs::read(path)
}

/// A stable description of who a user is, with secret parts hashed.
pub fn identity_of(auth: Option<&AuthInfo>) -> String {
    let Some(auth) = auth else {
        return "anonymous".to_string();
    };
    if let Some(exec) = &auth.exec {
        let command = exec
            .command
            .as_deref()
            .map(crate::auth::classify::command_basename)
            .unwrap_or_default();
        let mut env: Vec<String> = exec
            .env
            .iter()
            .flatten()
            .filter_map(|e| {
                let name = e.get("name")?;
                let value = e.get("value").map(String::as_str).unwrap_or_default();
                Some(if jp_auth_core::credentials::is_secret_env_name(name) {
                    format!("{name}=#{}", sha_hex(value.as_bytes()))
                } else {
                    format!("{name}={value}")
                })
            })
            .collect();
        env.sort();
        return format!(
            "exec:{command}\0{}\0{}",
            exec.args.clone().unwrap_or_default().join("\0"),
            env.join("\0")
        );
    }
    let token = auth
        .token
        .as_ref()
        .map(|t| t.expose_secret().trim().to_string())
        .or_else(|| {
            let path = auth.token_file.as_deref()?;
            Some(
                String::from_utf8_lossy(&read_small_file(path).ok()?)
                    .trim()
                    .to_string(),
            )
        });
    if let Some(token) = token.filter(|t| !t.is_empty()) {
        return format!("token:{}", sha_hex(token.as_bytes()));
    }
    let cert = auth
        .client_certificate_data
        .as_deref()
        .and_then(|data| {
            use base64::Engine;
            base64::engine::general_purpose::STANDARD
                .decode(data.trim())
                .ok()
        })
        .or_else(|| read_small_file(auth.client_certificate.as_deref()?).ok());
    if let Some(cert) = cert {
        return cert_identity(&String::from_utf8_lossy(&cert));
    }
    if let Some(provider) = &auth.auth_provider {
        let mut config: Vec<String> = provider
            .config
            .iter()
            .map(|(k, v)| format!("{k}=#{}", sha_hex(v.as_bytes())))
            .collect();
        config.sort();
        return format!("provider:{}\0{}", provider.name, config.join("\0"));
    }
    if let Some(user) = &auth.username {
        return format!("basic:{user}");
    }
    "anonymous".to_string()
}

/// The identity of a client certificate (whitespace-insensitive PEM).
pub fn cert_identity(pem: &str) -> String {
    let compact: String = pem.chars().filter(|c| !c.is_whitespace()).collect();
    format!("cert:{}", sha_hex(compact.as_bytes()))
}

/// The identity of a bearer token.
pub fn token_identity(token: &str) -> String {
    format!("token:{}", sha_hex(token.trim().as_bytes()))
}

/// Truncated hash of (normalized server, identity).
pub fn fingerprint(server: Option<&str>, identity: &str) -> String {
    let server = server.map(normalize_server).unwrap_or_default();
    sha_hex(format!("{server}\n{identity}").as_bytes())[..32].to_string()
}

/// Fingerprint of a context of `doc` (our recorded one for managed entries).
pub fn context_fingerprint(doc: &Kubeconfig, context: &NamedContext) -> Option<String> {
    if let Some(fp) = meta_of(context).and_then(|m| m.fingerprint) {
        return Some(fp);
    }
    let ctx = context.context.as_ref()?;
    let server = doc
        .clusters
        .iter()
        .find(|c| c.name == ctx.cluster)
        .and_then(|c| c.cluster.as_ref()?.server.clone())?;
    let user = ctx.user.as_deref().and_then(|name| {
        doc.auth_infos
            .iter()
            .find(|u| u.name == name)
            .and_then(|u| u.auth_info.as_ref())
    });
    Some(fingerprint(Some(&server), &identity_of(user)))
}

/* ------------------------------------------------------- reading/writing */

/// Parses kubeconfig YAML (multiple documents are merged). Errors only keep
/// a position: the parser's message can quote file contents.
pub fn parse(text: &str) -> Result<Kubeconfig, String> {
    Kubeconfig::from_yaml(text).map_err(|e| crate::kubeconfig_discovery::read_error_message(&e))
}

pub fn new_doc() -> Kubeconfig {
    Kubeconfig {
        api_version: Some("v1".to_string()),
        kind: Some("Config".to_string()),
        ..Kubeconfig::default()
    }
}

/// Reads `path`; a missing file is an empty document.
pub fn read(path: &Path) -> Result<Kubeconfig, AppError> {
    match std::fs::read_to_string(path) {
        Ok(text) => parse(&text)
            .map_err(|message| AppError::io(format!("{} can't be read", path.display()), message)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(new_doc()),
        Err(e) => Err(AppError::io(format!("{} can't be read", path.display()), e)),
    }
}

pub fn serialize(doc: &Kubeconfig) -> Result<String, AppError> {
    // Plain scalars like kubectl writes them (no folded base64 blocks).
    let options = serde_saphyr::ser_options! { prefer_block_scalars: false };
    serde_saphyr::to_string_with_options(doc, options)
        .map_err(|e| AppError::internal(format!("The kubeconfig could not be written: {e}")))
}

/// Refuses documents with credentials in them: tokens, client keys,
/// passwords, auth-provider tokens and secret exec environment variables.
pub fn assert_no_inline_secrets(doc: &Kubeconfig) -> Result<(), AppError> {
    for user in &doc.auth_infos {
        let Some(auth) = &user.auth_info else {
            continue;
        };
        let mut found = Vec::new();
        if auth.token.is_some() {
            found.push("a token");
        }
        if auth.client_key_data.is_some() {
            found.push("a client key");
        }
        if auth.password.is_some() {
            found.push("a password");
        }
        if auth.auth_provider.as_ref().is_some_and(|p| {
            p.config.keys().any(|k| {
                let k = k.to_ascii_lowercase();
                k.contains("token") || k.contains("secret")
            })
        }) {
            found.push("auth provider tokens");
        }
        if auth.exec.as_ref().is_some_and(|exec| {
            exec.env.iter().flatten().any(|e| {
                e.get("name")
                    .is_some_and(|n| jp_auth_core::credentials::is_secret_env_name(n))
            })
        }) {
            found.push("secret environment variables");
        }
        if let Some(what) = found.first() {
            return Err(AppError::internal(format!(
                "Refusing to write {what} for user \"{}\" into the managed kubeconfig.",
                user.name
            )));
        }
    }
    Ok(())
}

/// Serialises writers in this process (the lock file covers others).
static WRITE_LOCK: Mutex<()> = Mutex::new(());

/// client-go's kubeconfig lock: `<file>.lock` created with `O_EXCL` and
/// removed when done. A lock older than a minute is considered stale.
pub struct KubeconfigLock {
    path: PathBuf,
}

impl KubeconfigLock {
    pub fn acquire(file: &Path) -> Result<KubeconfigLock, AppError> {
        let mut name = file.file_name().unwrap_or_default().to_os_string();
        name.push(".lock");
        let path = file.with_file_name(name);
        let started = Instant::now();
        let mut removed_stale = false;
        loop {
            let mut options = OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            match options.open(&path) {
                Ok(_) => return Ok(KubeconfigLock { path }),
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                    let stale = std::fs::metadata(&path)
                        .and_then(|m| m.modified())
                        .ok()
                        .and_then(|t| t.elapsed().ok())
                        .is_some_and(|age| age > STALE_LOCK);
                    if stale && !removed_stale {
                        removed_stale = true;
                        let _ = std::fs::remove_file(&path);
                        continue;
                    }
                    if started.elapsed() > LOCK_WAIT {
                        return Err(AppError::conflict(format!(
                            "{} is being changed by another program ({} exists). Try again in a moment.",
                            file.display(),
                            path.display()
                        )));
                    }
                    std::thread::sleep(Duration::from_millis(50));
                }
                Err(e) => {
                    return Err(AppError::io(
                        format!("{} can't be locked", file.display()),
                        e,
                    ))
                }
            }
        }
    }
}

impl Drop for KubeconfigLock {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

/// Writes `text` to `path` atomically with `mode`.
pub fn write_file(path: &Path, text: &str, mode: u32) -> Result<(), AppError> {
    jp_auth_core::fsutil::write_atomic(path, text.as_bytes(), mode)
        .map_err(|e| AppError::io(format!("{} can't be written", path.display()), e))
}

/// Read-modify-write of the managed kubeconfig at `path` (see the module
/// docs). `change` returns a value; nothing is written when it fails.
pub fn update<T>(
    path: &Path,
    change: impl FnOnce(&mut Kubeconfig) -> Result<T, AppError>,
) -> Result<T, AppError> {
    let _guard = crate::util::lock(&WRITE_LOCK);
    if let Some(dir) = path.parent() {
        jp_auth_core::paths::ensure_private_dir(dir)
            .map_err(|e| AppError::io(format!("{} can't be created", dir.display()), e))?;
    }
    let _lock = KubeconfigLock::acquire(path)?;
    let mut doc = read(path)?;
    let result = change(&mut doc)?;
    assert_no_inline_secrets(&doc)?;
    let text = serialize(&doc)?;
    write_file(path, &text, 0o600)?;
    super::emit(MANAGED_CHANGED_EVENT);
    Ok(result)
}

/// Every context name in `doc`.
pub fn context_names(doc: &Kubeconfig) -> impl Iterator<Item = &str> {
    doc.contexts.iter().map(|c| c.name.as_str())
}

/// Removes contexts (and their `jetpilot-*` cluster and user entries when no
/// other context uses them). Returns the cluster ids of removed contexts.
pub fn remove_contexts(doc: &mut Kubeconfig, names: &[String]) -> Result<Vec<String>, AppError> {
    for name in names {
        if !doc.contexts.iter().any(|c| &c.name == name) {
            return Err(AppError::not_found(format!(
                "There is no cluster called \"{name}\"."
            )));
        }
    }
    let mut ids = Vec::new();
    let removed: Vec<NamedContext> = doc
        .contexts
        .iter()
        .filter(|c| names.contains(&c.name))
        .cloned()
        .collect();
    doc.contexts.retain(|c| !names.contains(&c.name));
    for named in &removed {
        if let Some(meta) = meta_of(named) {
            ids.push(meta.id);
        }
        let Some(ctx) = &named.context else { continue };
        let cluster_used = doc
            .contexts
            .iter()
            .any(|c| c.context.as_ref().is_some_and(|x| x.cluster == ctx.cluster));
        if ctx.cluster.starts_with(INTERNAL_PREFIX) && !cluster_used {
            doc.clusters.retain(|c| c.name != ctx.cluster);
        }
        if let Some(user) = ctx
            .user
            .as_deref()
            .filter(|u| u.starts_with(INTERNAL_PREFIX))
        {
            let user_used = doc
                .contexts
                .iter()
                .any(|c| c.context.as_ref().and_then(|x| x.user.as_deref()) == Some(user));
            if !user_used {
                doc.auth_infos.retain(|u| u.name != user);
            }
        }
    }
    if doc
        .current_context
        .as_ref()
        .is_some_and(|current| names.contains(current))
    {
        doc.current_context = doc.contexts.first().map(|c| c.name.clone());
    }
    Ok(ids)
}

/// Empty `BTreeMap` helper for struct literals.
pub fn no_other() -> BTreeMap<String, serde_json::Value> {
    BTreeMap::new()
}

#[cfg(test)]
mod tests {
    use super::*;
    use kube::config::{Cluster, NamedAuthInfo, NamedCluster};

    const FOREIGN: &str = r#"
apiVersion: v1
kind: Config
preferences:
  colors: true
  x-unknown-pref: 1
current-context: hand-made
clusters:
- name: hand-cluster
  cluster:
    server: https://hand.example:6443
    certificate-authority-data: Q0E=
    x-cluster-field: keep-me
    extensions:
    - name: client.authentication.k8s.io/exec
      extension:
        audience: hand
contexts:
- name: hand-made
  context:
    cluster: hand-cluster
    user: hand-user
    x-context-field: [1, 2]
users:
- name: hand-user
  user:
    exec:
      apiVersion: client.authentication.k8s.io/v1beta1
      command: aws
      args: [eks, get-token, --cluster-name, hand]
      env:
      - name: AWS_PROFILE
        value: dev
      x-exec-field: true
x-top-level: {nested: [a, b]}
extensions:
- name: someone.else/ext
  extension: {keep: true}
"#;

    fn managed_entry(doc: &mut Kubeconfig, id: &str, name: &str) {
        let internal = format!("jetpilot-{id}");
        doc.clusters.push(NamedCluster {
            name: internal.clone(),
            cluster: Some(Cluster {
                server: Some(format!("https://{id}.example")),
                ..Cluster::default()
            }),
            other: no_other(),
        });
        doc.auth_infos.push(NamedAuthInfo {
            name: internal.clone(),
            auth_info: Some(AuthInfo {
                exec: Some(static_exec(
                    id,
                    Path::new("/home/me/.kube/jet-pilot/bin/jetpilot-auth"),
                )),
                ..AuthInfo::default()
            }),
            other: no_other(),
        });
        let mut context = Context {
            cluster: internal.clone(),
            user: Some(internal),
            ..Context::default()
        };
        set_meta(
            &mut context,
            &ClusterMeta {
                id: id.to_string(),
                origin: "manual".into(),
                added_at: 42,
                source_path: None,
                fingerprint: Some("fp".into()),
            },
        );
        doc.contexts.push(NamedContext {
            name: name.to_string(),
            context: Some(context),
            other: no_other(),
        });
    }

    #[test]
    fn round_trip_keeps_unknown_fields_and_extensions() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("jp").join("config");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, FOREIGN).unwrap();

        update(&path, |doc| {
            managed_entry(doc, "abc", "prod");
            Ok(())
        })
        .unwrap();

        let text = std::fs::read_to_string(&path).unwrap();
        let doc = parse(&text).unwrap();
        // Foreign entries untouched, unknown fields kept at every level.
        let before = serde_json::to_value(parse(FOREIGN).unwrap()).unwrap();
        let after = serde_json::to_value(&doc).unwrap();
        for pointer in [
            "/preferences",
            "/x-top-level",
            "/extensions",
            "/clusters/0",
            "/contexts/0",
            "/users/0",
            "/current-context",
        ] {
            assert_eq!(after.pointer(pointer), before.pointer(pointer), "{pointer}");
        }
        assert!(text.contains("x-exec-field: true"));
        assert!(text.contains("x-context-field"));

        let managed = list(&doc);
        assert_eq!(
            managed,
            vec![ManagedCluster {
                context: "prod".into(),
                cluster_id: "abc".into(),
                origin: "manual".into(),
                added_at: 42,
                server: Some("https://abc.example".into()),
            }]
        );
        // kube-rs (and so kubectl-compatible YAML) reads it back.
        let exec = doc.auth_infos[1]
            .auth_info
            .as_ref()
            .unwrap()
            .exec
            .as_ref()
            .unwrap();
        assert_eq!(
            exec.args.as_ref().unwrap(),
            &["credential", "static", "--id", "abc"]
        );
        assert_eq!(exec.interactive_mode, Some(ExecInteractiveMode::Never));
        assert_eq!(exec.install_hint.as_deref(), Some(INSTALL_HINT));
        assert!(matches!(
            helper_request(exec),
            Some(jp_auth_core::request::Request::CredentialStatic { .. })
        ));

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
            let dir_mode = std::fs::metadata(path.parent().unwrap())
                .unwrap()
                .permissions()
                .mode();
            assert_eq!(dir_mode & 0o777, 0o700);
        }
        // The lock file is gone.
        assert!(!path.with_file_name("config.lock").exists());
    }

    #[test]
    fn writer_rejects_inline_secrets_and_keeps_the_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config");
        update(&path, |doc| {
            managed_entry(doc, "abc", "prod");
            Ok(())
        })
        .unwrap();
        let before = std::fs::read_to_string(&path).unwrap();

        type Mutation = Box<dyn Fn(&mut AuthInfo)>;
        let cases: Vec<(&str, Mutation)> = vec![
            (
                "a token",
                Box::new(|a| a.token = Some("t".to_string().into())),
            ),
            (
                "a client key",
                Box::new(|a| a.client_key_data = Some("k".to_string().into())),
            ),
            (
                "a password",
                Box::new(|a| a.password = Some("p".to_string().into())),
            ),
            (
                "auth provider tokens",
                Box::new(|a| {
                    a.auth_provider = Some(kube::config::AuthProviderConfig {
                        name: "oidc".into(),
                        config: [("refresh-token".to_string(), "r".to_string())].into(),
                        other: no_other(),
                    })
                }),
            ),
            (
                "secret environment variables",
                Box::new(|a| {
                    a.exec.as_mut().unwrap().env = Some(vec![[
                        ("name".to_string(), "AWS_SECRET_ACCESS_KEY".to_string()),
                        ("value".to_string(), "x".to_string()),
                    ]
                    .into()])
                }),
            ),
        ];
        for (what, mutate) in cases {
            let err = update(&path, |doc| {
                mutate(doc.auth_infos[0].auth_info.as_mut().unwrap());
                Ok(())
            })
            .unwrap_err();
            assert!(err.message.contains(what), "{what}: {}", err.message);
            assert_eq!(std::fs::read_to_string(&path).unwrap(), before);
        }
        // A failing change writes nothing either.
        let err = update(&path, |_| -> Result<(), AppError> {
            Err(AppError::conflict("nope"))
        })
        .unwrap_err();
        assert_eq!(err.message, "nope");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), before);
    }

    #[test]
    fn lock_file_follows_client_go() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config");
        let held = KubeconfigLock::acquire(&path).unwrap();
        assert!(dir.path().join("config.lock").exists());
        drop(held);
        assert!(!dir.path().join("config.lock").exists());

        // A stale lock (crashed writer) is taken over.
        std::fs::write(dir.path().join("config.lock"), "").unwrap();
        let old = SystemTime::now() - Duration::from_secs(600);
        std::fs::File::options()
            .write(true)
            .open(dir.path().join("config.lock"))
            .unwrap()
            .set_modified(old)
            .unwrap();
        KubeconfigLock::acquire(&path).unwrap();
    }

    #[test]
    fn remove_contexts_drops_internal_entries_only() {
        let mut doc = parse(FOREIGN).unwrap();
        managed_entry(&mut doc, "aaa", "one");
        managed_entry(&mut doc, "bbb", "two");
        doc.current_context = Some("one".into());
        let ids = remove_contexts(&mut doc, &["one".into()]).unwrap();
        assert_eq!(ids, vec!["aaa"]);
        assert!(!doc.clusters.iter().any(|c| c.name == "jetpilot-aaa"));
        assert!(!doc.auth_infos.iter().any(|u| u.name == "jetpilot-aaa"));
        assert!(doc.clusters.iter().any(|c| c.name == "hand-cluster"));
        assert_eq!(doc.current_context.as_deref(), Some("hand-made"));
        assert_eq!(
            remove_contexts(&mut doc, &["ghost".into()])
                .unwrap_err()
                .code,
            super::super::error::AppErrorCode::NotFound
        );
    }

    #[test]
    fn fingerprints_ignore_server_spelling_and_hash_secrets() {
        assert_eq!(
            normalize_server("https://API.example:443/"),
            "https://api.example"
        );
        let token_user = AuthInfo {
            token: Some("abc".to_string().into()),
            ..AuthInfo::default()
        };
        let identity = identity_of(Some(&token_user));
        assert_eq!(identity, token_identity("abc"));
        assert!(!identity.contains("abc"));
        assert_eq!(
            fingerprint(Some("https://a.example"), &identity),
            fingerprint(Some("https://A.example:443"), &identity)
        );
        assert_ne!(
            fingerprint(Some("https://a.example"), &identity),
            fingerprint(Some("https://b.example"), &identity)
        );
        assert_eq!(identity_of(None), "anonymous");
    }
}

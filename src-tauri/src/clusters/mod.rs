//! Clusters added in JET Pilot: the managed kubeconfig
//! (`~/.kube/jet-pilot/config`), importing kubeconfigs, entering clusters
//! by hand, cloud connections and their live catalog, exports, and
//! installing the `jetpilot-auth` credential helper that makes them work in
//! external terminals.
//!
//! Credentials never live in the managed kubeconfig or cross into the
//! webview: they go to the vault (`crate::secrets`) and kubeconfig users run
//! the helper.

pub mod catalog;
pub mod connections;
pub mod error;
pub mod export;
pub mod helper_install;
pub mod import;
pub mod managed_kubeconfig;
pub mod manual;
pub mod naming;
pub mod providers;

use std::sync::OnceLock;

use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tracing::warn;

use error::AppError;
use managed_kubeconfig as managed;

static APP: OnceLock<AppHandle> = OnceLock::new();

/// Remembers the app (for events) and installs or updates the helper in
/// the background. Called once from `setup`.
pub fn init(app: &AppHandle) {
    let _ = APP.set(app.clone());
    helper_install::spawn_startup_install();
}

/// The app (None before `init`, e.g. in tests).
pub(crate) fn app() -> Option<&'static AppHandle> {
    APP.get()
}

/// Emits a payload-less event to the webview (no-op before `init`, e.g. in
/// tests).
pub(crate) fn emit(event: &str) {
    if let Some(app) = APP.get() {
        if let Err(e) = app.emit(event, ()) {
            warn!("Could not emit {}: {}", event, e);
        }
    }
}

/// Runs blocking work (files, keychain, Argon2) off the async runtime.
pub(crate) async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, AppError> + Send + 'static,
) -> Result<T, AppError> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|e| AppError::internal(format!("The operation failed: {e}")))?
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClustersPaths {
    /// `~/.kube/jet-pilot`
    pub home: String,
    /// The managed kubeconfig.
    pub kubeconfig: String,
    pub bin: String,
    /// Where the helper is (or will be) installed.
    pub helper: String,
    pub vault: String,
}

#[tauri::command]
pub fn clusters_paths() -> ClustersPaths {
    let s = |p: std::path::PathBuf| p.to_string_lossy().into_owned();
    ClustersPaths {
        home: s(jp_auth_core::paths::jet_pilot_home()),
        kubeconfig: s(managed::managed_path()),
        bin: s(jp_auth_core::paths::bin_dir()),
        helper: s(jp_auth_core::paths::helper_path()),
        vault: s(jp_auth_core::paths::vault_dir()),
    }
}

/// Clusters added in JET Pilot.
#[tauri::command]
pub async fn managed_list() -> Result<Vec<managed::ManagedCluster>, AppError> {
    blocking(|| Ok(managed::list(&managed::read(&managed::managed_path())?))).await
}

/// What removing clusters did.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoveResult {
    /// The kubeconfig they were removed from.
    pub kube_config: String,
    /// The contexts removed (ones that were already gone are left out).
    pub removed: Vec<String>,
    /// Why their stored credentials were kept: another kubeconfig still
    /// uses them, or the vault couldn't be opened (the clusters are removed
    /// regardless).
    pub credentials_kept: Option<String>,
}

/// Removes clusters from the managed kubeconfig; `forget_secrets` also
/// deletes their stored credentials.
#[tauri::command]
pub async fn managed_remove(
    contexts: Vec<String>,
    forget_secrets: bool,
) -> Result<RemoveResult, AppError> {
    blocking(move || remove(&managed::managed_path(), &contexts, forget_secrets)).await
}

/// Removing clusters never depends on the vault working: a locked
/// passphrase vault asks to be unlocked first when there are credentials to
/// delete (nothing changes until it is), but a vault that can't be opened
/// (no keychain, a damaged file) only means the credentials stay behind.
/// The kubeconfig changes before the secrets go, so a cluster is never left
/// without its credentials, and credentials another kubeconfig still uses
/// (an export to ~/.kube/config) are kept.
pub(crate) fn remove(
    path: &std::path::Path,
    contexts: &[String],
    forget_secrets: bool,
) -> Result<RemoveResult, AppError> {
    let mut result = RemoveResult {
        kube_config: path.to_string_lossy().into_owned(),
        ..RemoveResult::default()
    };
    let mut preview = managed::read(path)?;
    if !contexts
        .iter()
        .any(|name| managed::context_names(&preview).any(|n| n == name.as_str()))
    {
        // Already gone (e.g. removed in another window).
        return Ok(result);
    }
    let mut keep = std::collections::HashSet::new();
    if forget_secrets {
        let stored = dropped_credential_ids(&mut preview, contexts);
        if !stored.is_empty() {
            keep = used_elsewhere(path, &stored);
            if stored.iter().any(|id| !keep.contains(id)) {
                crate::secrets::require_unlocked()?;
            }
        }
    }
    let stored = managed::update(path, |doc| {
        result.removed = contexts
            .iter()
            .filter(|name| managed::context_names(doc).any(|n| n == name.as_str()))
            .cloned()
            .collect();
        Ok(dropped_credential_ids(doc, contexts))
    })?;
    if !forget_secrets || stored.is_empty() {
        return Ok(result);
    }
    let forget: Vec<&String> = stored.iter().filter(|id| !keep.contains(*id)).collect();
    if forget.len() < stored.len() {
        result.credentials_kept =
            Some("another kubeconfig (an export) still uses them.".to_string());
    }
    let secret_ids: Vec<String> = forget
        .iter()
        .flat_map(|id| {
            [
                jp_auth_core::credentials::static_secret_id(id),
                jp_auth_core::credentials::env_secret_id(id),
            ]
        })
        .collect();
    if let Err(e) = crate::secrets::remove_many(&secret_ids) {
        warn!(
            "Removed {} cluster(s) but kept their credentials: {}",
            result.removed.len(),
            e.message
        );
        result.credentials_kept = Some(e.message);
    }
    Ok(result)
}

/// The vault ids (`jetpilot-auth credential static|wrap-exec --id`) of the
/// users that go away when `contexts` are removed from `doc` (which this
/// does). Ids a remaining user still reads (a context sharing the user, an
/// imported copy) keep their credentials.
fn dropped_credential_ids(doc: &mut kube::config::Kubeconfig, contexts: &[String]) -> Vec<String> {
    let before = doc.auth_infos.clone();
    managed::remove_contexts(doc, contexts);
    let still_used: std::collections::HashSet<String> = doc
        .auth_infos
        .iter()
        .filter_map(|user| vault_id(user.auth_info.as_ref()?))
        .collect();
    let mut ids: Vec<String> = before
        .iter()
        .filter(|user| !doc.auth_infos.iter().any(|u| u.name == user.name))
        .filter_map(|user| vault_id(user.auth_info.as_ref()?))
        .filter(|id| !still_used.contains(id))
        .collect();
    ids.sort();
    ids.dedup();
    ids
}

/// The vault id a user's `jetpilot-auth` exec reads.
fn vault_id(user: &kube::config::AuthInfo) -> Option<String> {
    use jp_auth_core::request::Request;
    match managed::helper_request(user.exec.as_ref()?)? {
        Request::CredentialStatic { id } | Request::CredentialWrapExec { id, .. } => Some(id),
        _ => None,
    }
}

/// Which of `ids` a kubeconfig other than the managed one still reads
/// (clusters exported "through JET Pilot").
fn used_elsewhere(
    managed_path: &std::path::Path,
    ids: &[String],
) -> std::collections::HashSet<String> {
    let managed_key = std::fs::canonicalize(managed_path).unwrap_or(managed_path.to_path_buf());
    let mut used = std::collections::HashSet::new();
    for path in other_kubeconfigs() {
        if std::fs::canonicalize(&path).unwrap_or(path.clone()) == managed_key {
            continue;
        }
        let Ok(doc) = kube::config::Kubeconfig::read_from(&path) else {
            continue;
        };
        for user in &doc.auth_infos {
            if let Some(id) = user.auth_info.as_ref().and_then(vault_id) {
                if ids.contains(&id) {
                    used.insert(id);
                }
            }
        }
    }
    used
}

/// The kubeconfig files on this machine (tests: the ones they set).
fn other_kubeconfigs() -> Vec<std::path::PathBuf> {
    #[cfg(test)]
    return crate::util::lock(&TEST_OTHER_KUBECONFIGS).clone();
    #[cfg(not(test))]
    crate::kubeconfig_discovery::known_kubeconfig_paths()
}

#[cfg(test)]
pub(crate) static TEST_OTHER_KUBECONFIGS: std::sync::Mutex<Vec<std::path::PathBuf>> =
    std::sync::Mutex::new(Vec::new());

/// Renames a cluster's context; returns the new name.
#[tauri::command]
pub async fn managed_rename(context: String, new_name: String) -> Result<String, AppError> {
    blocking(move || {
        let known = import::Known::load();
        rename(&managed::managed_path(), &context, &new_name, &known)
    })
    .await
}

pub(crate) fn rename(
    path: &std::path::Path,
    context: &str,
    new_name: &str,
    known: &import::Known,
) -> Result<String, AppError> {
    let new_name = naming::validate_context_name(new_name, "newName")?;
    if new_name == context {
        return Ok(new_name);
    }
    if known.names.contains(&new_name) {
        return Err(AppError::invalid(
            "newName",
            format!("Another context is already called \"{new_name}\"."),
        ));
    }
    managed::update(path, |doc| {
        if managed::context_names(doc).any(|n| n == new_name) {
            return Err(AppError::invalid(
                "newName",
                format!("Another context is already called \"{new_name}\"."),
            ));
        }
        let named = doc
            .contexts
            .iter_mut()
            .find(|c| c.name == context)
            .ok_or_else(|| {
                AppError::not_found(format!("There is no cluster called \"{context}\"."))
            })?;
        named.name = new_name.clone();
        if doc.current_context.as_deref() == Some(context) {
            doc.current_context = Some(new_name.clone());
        }
        Ok(new_name.clone())
    })
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use kube::config::{
        AuthInfo, Cluster, Context, Kubeconfig, NamedAuthInfo, NamedCluster, NamedContext,
    };
    use serde_json::json;

    use super::*;
    use crate::secrets::{self, test_support, use_test_env, TEST_VAULT_LOCK};
    use crate::util::lock;
    use error::AppErrorCode;
    use jp_auth_core::credentials::static_secret_id;
    use managed::{no_other, ClusterMeta};

    const HELPER: &str = "/home/me/.kube/jet-pilot/bin/jetpilot-auth";

    fn static_user(id: &str) -> NamedAuthInfo {
        NamedAuthInfo {
            name: naming::internal_name(id),
            auth_info: Some(AuthInfo {
                exec: Some(managed::static_exec(id, Path::new(HELPER))),
                ..AuthInfo::default()
            }),
            other: no_other(),
        }
    }

    /// A cluster added in JET Pilot; `stored` ones read a vault credential.
    fn add(path: &Path, id: &str, name: &str, stored: bool) {
        managed::update(path, |doc| {
            let internal = naming::internal_name(id);
            doc.clusters.push(NamedCluster {
                name: internal.clone(),
                cluster: Some(Cluster {
                    server: Some(format!("https://{id}.example")),
                    ..Cluster::default()
                }),
                other: no_other(),
            });
            doc.auth_infos.push(if stored {
                static_user(id)
            } else {
                NamedAuthInfo {
                    name: internal.clone(),
                    auth_info: Some(AuthInfo::default()),
                    other: no_other(),
                }
            });
            let mut context = Context {
                cluster: internal.clone(),
                user: Some(internal),
                ..Context::default()
            };
            managed::set_meta(
                &mut context,
                &ClusterMeta {
                    id: id.into(),
                    origin: "manual".into(),
                    added_at: 1,
                    source_path: None,
                    fingerprint: None,
                },
            );
            doc.contexts.push(NamedContext {
                name: name.into(),
                context: Some(context),
                other: no_other(),
            });
            Ok(())
        })
        .unwrap();
    }

    fn store(ids: &[&str]) {
        secrets::put_many(
            ids.iter()
                .map(|id| (static_secret_id(id), json!({ "token": id })))
                .collect(),
        )
        .unwrap();
    }

    fn stored(id: &str) -> bool {
        secrets::get(&static_secret_id(id)).unwrap().is_some()
    }

    fn names(path: &Path) -> Vec<String> {
        managed::read(path)
            .unwrap()
            .contexts
            .into_iter()
            .map(|c| c.name)
            .collect()
    }

    #[test]
    fn removing_forgets_only_credentials_nothing_else_uses() {
        let _guard = lock(&TEST_VAULT_LOCK);
        let dir = tempfile::tempdir().unwrap();
        let (env, _) = test_support::memory_env(dir.path(), true);
        use_test_env(env);
        let path = dir.path().join("config");
        add(&path, "aaa", "one", true);
        add(&path, "bbb", "two", true);
        add(&path, "ccc", "three", true);
        store(&["aaa", "bbb", "ccc"]);
        // A context of the user's own sharing two's entries.
        managed::update(&path, |doc| {
            let mut shared = doc
                .contexts
                .iter()
                .find(|c| c.name == "two")
                .unwrap()
                .clone();
            shared.name = "two-system".into();
            doc.contexts.push(shared);
            Ok(())
        })
        .unwrap();
        // Three was exported "through JET Pilot" to another kubeconfig.
        let other = dir.path().join("exported");
        let exported = Kubeconfig {
            auth_infos: vec![static_user("ccc")],
            ..managed::new_doc()
        };
        std::fs::write(&other, managed::serialize(&exported).unwrap()).unwrap();
        *lock(&TEST_OTHER_KUBECONFIGS) = vec![other];

        let result = remove(
            &path,
            &["one".into(), "two".into(), "three".into(), "ghost".into()],
            true,
        )
        .unwrap();
        *lock(&TEST_OTHER_KUBECONFIGS) = Vec::new();
        assert_eq!(result.removed, ["one", "two", "three"]);
        assert_eq!(result.kube_config, path.to_string_lossy());
        assert_eq!(names(&path), ["two-system"]);
        assert!(!stored("aaa"));
        assert!(stored("bbb"), "two-system still uses it");
        assert!(stored("ccc"), "the export still uses it");
        assert!(result.credentials_kept.is_some());

        // Already gone (another window): nothing to do, no error.
        let again = remove(&path, &["one".into()], true).unwrap();
        assert!(again.removed.is_empty());
    }

    #[tokio::test]
    #[allow(clippy::await_holding_lock)]
    async fn a_locked_vault_asks_first_and_a_broken_one_never_blocks() {
        let _guard = lock(&TEST_VAULT_LOCK);
        let dir = tempfile::tempdir().unwrap();
        let (env, _) = test_support::memory_env(dir.path(), false);
        use_test_env(env);
        secrets::vault_init_passphrase("a long passphrase".into())
            .await
            .unwrap();
        let path = dir.path().join("config");
        add(&path, "aaa", "one", true);
        add(&path, "bbb", "plain", false);
        store(&["aaa"]);
        secrets::vault_lock().await.unwrap();

        // Locked: unlock first, nothing changed.
        let err = remove(&path, &["one".into()], true).unwrap_err();
        assert_eq!(err.code, AppErrorCode::VaultLocked);
        assert_eq!(names(&path), ["one", "plain"]);
        // Clusters without stored credentials don't need the vault.
        assert_eq!(
            remove(&path, &["plain".into()], true).unwrap().removed,
            ["plain"]
        );

        // A keychain vault whose keychain went away: removed anyway.
        let dir = tempfile::tempdir().unwrap();
        let (env, chain) = test_support::memory_env(dir.path(), true);
        use_test_env(env);
        let path = dir.path().join("config");
        add(&path, "ccc", "three", true);
        store(&["ccc"]);
        chain.set_available(false);
        let result = remove(&path, &["three".into()], true).unwrap();
        assert_eq!(result.removed, ["three"]);
        assert!(result.credentials_kept.is_some());
        assert!(names(&path).is_empty());
    }
}

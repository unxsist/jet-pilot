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

/// Removes clusters from the managed kubeconfig; `forget_secrets` also
/// deletes their stored credentials.
#[tauri::command]
pub async fn managed_remove(contexts: Vec<String>, forget_secrets: bool) -> Result<(), AppError> {
    blocking(move || remove(&managed::managed_path(), &contexts, forget_secrets)).await
}

pub(crate) fn remove(
    path: &std::path::Path,
    contexts: &[String],
    forget_secrets: bool,
) -> Result<(), AppError> {
    if contexts.is_empty() {
        return Ok(());
    }
    if forget_secrets {
        // Secrets first: when the vault is locked nothing changes.
        let mut doc = managed::read(path)?;
        let ids = managed::remove_contexts(&mut doc, contexts)?;
        let secret_ids: Vec<String> = ids
            .iter()
            .flat_map(|id| {
                [
                    jp_auth_core::credentials::static_secret_id(id),
                    jp_auth_core::credentials::env_secret_id(id),
                ]
            })
            .collect();
        crate::secrets::remove_many(&secret_ids)?;
    }
    managed::update(path, |doc| {
        managed::remove_contexts(doc, contexts).map(|_| ())
    })
}

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

//! The live cloud catalog: clusters discovered through the connections,
//! kept in `<app data dir>/catalog.json`.
//!
//! - Discovered clusters are `available` (one-click / bulk add) or
//!   `ignored`; `added` is derived from the managed kubeconfig (contexts
//!   whose `jet-pilot.app/cloud` extension names the catalog key).
//! - A cluster missing from a *complete* listing of its scope (account /
//!   project / subscription, or the whole connection) and region becomes
//!   `removed` and stays until the user acts (an ignored one is dropped).
//!   Failed listings change nothing.
//! - `catalog_refresh` never signs in: connections that need a person are
//!   skipped with a message. `catalog://changed` follows every write.
//! - Keys are `<provider>:<connectionId>:<scope or ->:<region>:<handle>`,
//!   the handle being the cluster name (AWS, GCP), `<resourceGroup>/<name>`
//!   (Azure) or the provider's cluster id (the API providers and doctl:
//!   their names need not be unique).

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use futures::stream::{self, StreamExt};
use jp_auth_core::connections::{CloudConnection, ConnectionKind};
use jp_auth_core::request::AwsEksArgs;
use kube::config::{
    AuthInfo, Cluster, Context, Kubeconfig, NamedAuthInfo, NamedCluster, NamedContext,
};
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::ipc::Channel;
use tracing::{info, warn};

use super::error::AppError;
use super::managed_kubeconfig::{self as managed, CloudMeta, ClusterMeta};
use super::naming;
use super::providers::{self, api, azure, cli, doctl, gcp, Listing, Prepared};
use crate::probe::ContextRef;
use crate::util::lock;

pub const FILE_NAME: &str = "catalog.json";
pub const CHANGED_EVENT: &str = "catalog://changed";
/// Clusters prepared at once when adding (CLI runs, API calls).
const ADD_CONCURRENCY: usize = 4;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CatalogState {
    Available,
    Added,
    Ignored,
    Removed,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogCluster {
    /// `<provider>:<connectionId>:<scope or ->:<region>:<handle>`
    pub key: String,
    pub provider: String,
    pub connection_id: String,
    /// AWS account, GCP project, Azure subscription; empty otherwise.
    pub account_id: String,
    #[serde(default)]
    pub account_name: Option<String>,
    #[serde(default)]
    pub role_name: Option<String>,
    /// Region / location / zone.
    pub region: String,
    pub name: String,
    #[serde(default)]
    pub version: Option<String>,
    /// As the provider says: `ACTIVE`, `running`, `RUNNING`, `Running`, ...
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default)]
    pub endpoint: Option<String>,
    /// Unix ms.
    #[serde(default)]
    pub created_at: Option<i64>,
    pub state: CatalogState,
    #[serde(default)]
    pub added_context: Option<ContextRef>,
}

/// A catalog entry as stored (with what adding it needs).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredCluster {
    #[serde(flatten)]
    cluster: CatalogCluster,
    /// base64 PEM of the cluster CA (EKS, GKE).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    certificate_authority: Option<String>,
    /// The provider's id: EKS ARN, GKE self link, AKS resource id, the
    /// cluster id of the API providers.
    #[serde(default, alias = "arn", skip_serializing_if = "Option::is_none")]
    native_id: Option<String>,
    /// AKS.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    resource_group: Option<String>,
    /// The profile it was listed with (profile connections).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    profile: Option<String>,
    /// Unix ms of the last listing that had it.
    #[serde(default)]
    seen_at: i64,
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CatalogFile {
    #[serde(default)]
    version: u32,
    #[serde(default)]
    refreshed_at: Option<i64>,
    #[serde(default)]
    clusters: Vec<StoredCluster>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogSnapshot {
    pub clusters: Vec<CatalogCluster>,
    pub refreshed_at: Option<i64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ProgressState {
    Running,
    Done,
    Error,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum CatalogEvent {
    Progress {
        connection_id: String,
        /// `acme-prod (123456789012) · eu-west-1`, `... · regions`.
        scope: String,
        state: ProgressState,
        message: Option<String>,
        account_id: Option<String>,
        account_name: Option<String>,
        region: Option<String>,
    },
    /// Every catalog cluster of the connection after its refresh.
    Clusters {
        connection_id: String,
        clusters: Vec<CatalogCluster>,
    },
    Done {
        refreshed_at: i64,
    },
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddOptions {
    /// Frontend metadata (the hub's folder); not used here.
    #[serde(default)]
    #[allow(dead_code)]
    pub folder: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AddFailure {
    pub key: String,
    pub message: String,
}

/// Something to know about a cluster that was added (a credential plugin
/// that isn't installed, ...).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AddWarning {
    pub key: String,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AddResult {
    pub added: Vec<ContextRef>,
    pub failed: Vec<AddFailure>,
    pub warnings: Vec<AddWarning>,
}

/* ------------------------------------------------------------ the file */

static FILE_LOCK: Mutex<()> = Mutex::new(());
/// Test overrides: (catalog file, managed kubeconfig).
#[cfg(test)]
static TEST_PATHS: Mutex<Option<(PathBuf, PathBuf)>> = Mutex::new(None);

#[cfg(test)]
pub(crate) fn use_test_paths(paths: Option<(PathBuf, PathBuf)>) {
    *lock(&TEST_PATHS) = paths;
}

/// The managed kubeconfig (a test override in tests).
pub(crate) fn managed_file() -> PathBuf {
    #[cfg(test)]
    if let Some((_, managed)) = lock(&TEST_PATHS).clone() {
        return managed;
    }
    managed::managed_path()
}

fn catalog_path() -> Result<PathBuf, AppError> {
    #[cfg(test)]
    if let Some((path, _)) = lock(&TEST_PATHS).clone() {
        return Ok(path);
    }
    use tauri::Manager;
    let app = super::app().ok_or_else(|| AppError::internal("The app is not ready yet."))?;
    Ok(app.path().app_data_dir()?.join(FILE_NAME))
}

fn read_file(path: &Path) -> CatalogFile {
    match std::fs::read_to_string(path) {
        Ok(text) => serde_json::from_str(&text).unwrap_or_else(|e| {
            warn!("The cloud catalog can't be read ({}); starting over", e);
            CatalogFile::default()
        }),
        Err(_) => CatalogFile::default(),
    }
}

/// Read-modify-write of the catalog (then `catalog://changed`).
fn update<T>(change: impl FnOnce(&mut CatalogFile) -> T) -> Result<T, AppError> {
    let path = catalog_path()?;
    let _guard = lock(&FILE_LOCK);
    let mut file = read_file(&path);
    let result = change(&mut file);
    file.version = 1;
    for stored in &mut file.clusters {
        stored.cluster.added_context = None;
        if stored.cluster.state == CatalogState::Added {
            stored.cluster.state = CatalogState::Available;
        }
    }
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)
            .map_err(|e| AppError::io(format!("{} can't be created", dir.display()), e))?;
    }
    let text =
        serde_json::to_string_pretty(&file).map_err(|e| AppError::internal(e.to_string()))?;
    managed::write_file(&path, &text, 0o600)?;
    super::emit(CHANGED_EVENT);
    Ok(result)
}

/// Context names of every loaded kubeconfig, which new names must not
/// collide with (tests: only the managed one counts).
fn known_names() -> HashSet<String> {
    #[cfg(test)]
    if lock(&TEST_PATHS).is_some() {
        return HashSet::new();
    }
    super::import::Known::load().names
}

fn read() -> Result<CatalogFile, AppError> {
    let path = catalog_path()?;
    let _guard = lock(&FILE_LOCK);
    Ok(read_file(&path))
}

/* ------------------------------------------------------------ the logic */

/// `<provider>:<connectionId>:<scope or ->:<region>:<handle>`.
pub fn catalog_key(
    provider: &str,
    connection_id: &str,
    scope: &str,
    region: &str,
    handle: &str,
) -> String {
    let scope = if scope.is_empty() { "-" } else { scope };
    format!("{provider}:{connection_id}:{scope}:{region}:{handle}")
}

/// The last key segment of a found cluster (see the module docs).
fn key_handle(provider: &str, found: &providers::Found) -> String {
    match provider {
        providers::AWS | providers::GCP => found.name.clone(),
        providers::AZURE => match &found.resource_group {
            Some(group) => format!("{}/{}", group.to_ascii_lowercase(), found.name),
            None => found.name.clone(),
        },
        _ => found
            .native_id
            .clone()
            .unwrap_or_else(|| found.name.clone()),
    }
}

/// Whether a listing covers a stored entry (for marking it removed).
fn covers(listing: &Listing, connection_id: &str, entry: &StoredCluster) -> bool {
    entry.cluster.connection_id == connection_id
        && entry.cluster.account_id == listing.account_id
        && listing.regions.as_ref().is_none_or(|regions| {
            regions
                .iter()
                .any(|r| providers::region_matches(r, &entry.cluster.region))
        })
}

/// Applies one listing of a connection (pure). Only complete listings
/// teach anything about clusters that are gone.
fn merge(
    stored: &mut Vec<StoredCluster>,
    provider: &str,
    connection_id: &str,
    listing: &Listing,
    now: i64,
) {
    if !listing.complete {
        return;
    }
    let mut seen = HashSet::new();
    for found in &listing.clusters {
        let key = catalog_key(
            provider,
            connection_id,
            &listing.account_id,
            &found.region,
            &key_handle(provider, found),
        );
        seen.insert(key.clone());
        let existing = stored.iter_mut().find(|c| c.cluster.key == key);
        let entry = match existing {
            Some(entry) => {
                if entry.cluster.state == CatalogState::Removed {
                    entry.cluster.state = CatalogState::Available;
                }
                entry
            }
            None => {
                stored.push(StoredCluster {
                    cluster: CatalogCluster {
                        key: key.clone(),
                        provider: provider.to_string(),
                        connection_id: connection_id.to_string(),
                        account_id: listing.account_id.clone(),
                        account_name: None,
                        role_name: None,
                        region: found.region.clone(),
                        name: found.name.clone(),
                        version: None,
                        status: None,
                        endpoint: None,
                        created_at: None,
                        state: CatalogState::Available,
                        added_context: None,
                    },
                    certificate_authority: None,
                    native_id: None,
                    resource_group: None,
                    profile: None,
                    seen_at: now,
                });
                stored.last_mut().expect("just pushed")
            }
        };
        entry.seen_at = now;
        if listing.account_name.is_some() {
            entry.cluster.account_name = listing.account_name.clone();
        }
        entry.cluster.role_name = listing.role_name.clone();
        entry.profile = listing.profile.clone();
        if found.described {
            entry.cluster.name = found.name.clone();
            entry.cluster.version = found.version.clone();
            entry.cluster.status = found.status.clone();
            entry.cluster.endpoint = found.endpoint.clone();
            entry.cluster.created_at = found.created_at;
            entry.certificate_authority = found.certificate_authority.clone();
            entry.native_id = found.native_id.clone();
            entry.resource_group = found.resource_group.clone();
        }
    }
    stored.retain_mut(|entry| {
        if !covers(listing, connection_id, entry) || seen.contains(&entry.cluster.key) {
            return true;
        }
        match entry.cluster.state {
            // Gone and not wanted anyway.
            CatalogState::Ignored => false,
            _ => {
                entry.cluster.state = CatalogState::Removed;
                true
            }
        }
    });
}

/// Catalog keys of clusters in the managed kubeconfig, with their context.
fn added_contexts(doc: &Kubeconfig) -> HashMap<String, String> {
    doc.contexts
        .iter()
        .filter_map(|c| Some((managed::cloud_meta_of(c)?.catalog_key, c.name.clone())))
        .collect()
}

/// The clusters for the UI: `added` (and `addedContext`) from the managed
/// kubeconfig.
fn derive(stored: &[StoredCluster], doc: &Kubeconfig, managed_path: &Path) -> Vec<CatalogCluster> {
    let added = added_contexts(doc);
    let path = managed_path.to_string_lossy().into_owned();
    let mut clusters: Vec<CatalogCluster> = stored
        .iter()
        .map(|entry| {
            let mut cluster = entry.cluster.clone();
            cluster.added_context = added.get(&cluster.key).map(|context| ContextRef {
                kube_config: path.clone(),
                context: context.clone(),
            });
            if cluster.added_context.is_some() && cluster.state != CatalogState::Removed {
                cluster.state = CatalogState::Added;
            }
            cluster
        })
        .collect();
    clusters.sort_by(|a, b| {
        (
            &a.connection_id,
            a.account_name.as_deref().unwrap_or(&a.account_id),
            &a.region,
            &a.name,
        )
            .cmp(&(
                &b.connection_id,
                b.account_name.as_deref().unwrap_or(&b.account_id),
                &b.region,
                &b.name,
            ))
    });
    clusters
}

fn snapshot(file: &CatalogFile) -> Result<CatalogSnapshot, AppError> {
    let path = managed_file();
    let doc = managed::read(&path)?;
    Ok(CatalogSnapshot {
        clusters: derive(&file.clusters, &doc, &path),
        refreshed_at: file.refreshed_at,
    })
}

/// Whether the connection scans chosen accounts / projects /
/// subscriptions only (its `targets`).
fn scoped_by_targets(connection: &CloudConnection) -> bool {
    match connection.kind {
        ConnectionKind::Sso => true,
        ConnectionKind::Cli => {
            !connection.targets.is_empty()
                && matches!(
                    connection.provider.as_str(),
                    providers::GCP | providers::AZURE
                )
        }
        _ => false,
    }
}

/// Drops catalog entries a connection no longer scans (accounts removed
/// from its targets, regions removed from its list).
pub(crate) fn prune_connection_scope(connection: &CloudConnection) -> Result<(), AppError> {
    let file = read()?;
    let scoped = scoped_by_targets(connection);
    let keep = |entry: &StoredCluster| {
        if entry.cluster.connection_id != connection.id {
            return true;
        }
        let account_ok = !scoped
            || connection
                .targets
                .iter()
                .any(|t| t.account_id == entry.cluster.account_id);
        let region_ok = connection.regions.is_empty()
            || connection
                .regions
                .iter()
                .any(|r| providers::region_matches(r, &entry.cluster.region));
        account_ok && region_ok
    };
    if file.clusters.iter().all(keep) {
        return Ok(());
    }
    update(|file| file.clusters.retain(keep))
}

/// Forgets the catalog entries of a removed connection.
pub(crate) fn forget_connection(connection_id: &str) -> Result<(), AppError> {
    if !read()?
        .clusters
        .iter()
        .any(|c| c.cluster.connection_id == connection_id)
    {
        return Ok(());
    }
    update(|file| {
        file.clusters
            .retain(|c| c.cluster.connection_id != connection_id)
    })
}

/// The deterministic cluster id of a catalog cluster: `<prefix>-` + 16
/// hex (`eks-…`, `gke-…`, `do-…`).
fn cloud_cluster_id(provider: &str, key: &str) -> String {
    let digest = Sha256::digest(key.as_bytes());
    let hex: String = digest[..8].iter().map(|b| format!("{b:02x}")).collect();
    format!("{}-{hex}", providers::context_prefix(provider))
}

/// `<prefix>-<region>-<name>`: `gke-europe-west1-prod`, `do-ams3-web`.
fn context_name(provider: &str, region: &str, name: &str) -> String {
    let name: String = name.split_whitespace().collect::<Vec<_>>().join("-");
    format!(
        "{}-{}-{name}",
        providers::context_prefix(provider),
        region.to_ascii_lowercase()
    )
}

/// A catalog cluster ready to be written.
struct Planned {
    id: String,
    desired_name: String,
    cluster: Cluster,
    user: AuthInfo,
    secrets: Vec<(String, serde_json::Value)>,
    meta: CloudMeta,
    fingerprint: String,
    warnings: Vec<String>,
}

/// What preparing one requested key ended in.
enum Outcome {
    Planned(Box<Planned>),
    /// Already in the managed kubeconfig (its context).
    Added(String),
    Failed(String),
}

/// The helper entry of an EKS cluster (no network: the listing has the
/// server and CA).
fn prepare_aws(
    entry: &StoredCluster,
    connection: &CloudConnection,
    helper: &Path,
) -> Result<Prepared, String> {
    let cluster = &entry.cluster;
    let (endpoint, ca) = providers::server_and_ca(
        &cluster.name,
        cluster.status.as_deref(),
        &["ACTIVE"],
        cluster.endpoint.as_deref(),
        entry.certificate_authority.as_deref(),
    )
    .map_err(|e| e.replace("The provider returned", "EKS returned"))?;
    let args = match connection.kind {
        ConnectionKind::Sso => {
            let role = cluster
                .role_name
                .clone()
                .ok_or_else(|| format!("No role is known for account {}.", cluster.account_id))?;
            AwsEksArgs {
                connection: connection.id.clone(),
                account: Some(cluster.account_id.clone()),
                role: Some(role),
                profile: None,
                region: cluster.region.clone(),
                cluster: cluster.name.clone(),
            }
        }
        ConnectionKind::Profile => AwsEksArgs {
            connection: connection.id.clone(),
            account: None,
            role: None,
            profile: entry.profile.clone().or_else(|| connection.profile.clone()),
            region: cluster.region.clone(),
            cluster: cluster.name.clone(),
        },
        ConnectionKind::Keys => AwsEksArgs {
            connection: connection.id.clone(),
            account: None,
            role: None,
            profile: None,
            region: cluster.region.clone(),
            cluster: cluster.name.clone(),
        },
        ConnectionKind::Cli | ConnectionKind::Token | ConnectionKind::ApiKey => {
            return Err("This is not an AWS connection.".to_string())
        }
    };
    // Validated like the helper will parse it.
    jp_auth_core::request::parse(jp_auth_core::request::aws_eks_args(&args)).map_err(|e| e.0)?;
    Ok(Prepared {
        identity: format!(
            "aws-eks:{}:{}:{}",
            connection.id,
            cluster.account_id,
            args.role
                .as_deref()
                .or(args.profile.as_deref())
                .unwrap_or("keys")
        ),
        cluster: Cluster {
            server: Some(endpoint),
            certificate_authority_data: Some(ca),
            ..Cluster::default()
        },
        user: AuthInfo {
            exec: Some(managed::aws_eks_exec(&args, helper)),
            ..AuthInfo::default()
        },
        secrets: Vec::new(),
        native_id: entry.native_id.clone(),
        warnings: Vec::new(),
    })
}

/// Prepares a catalog cluster of any provider (CLI runs and API calls for
/// some).
async fn prepare(
    entry: &StoredCluster,
    connection: &CloudConnection,
    cluster_id: &str,
    helper: &Path,
) -> Result<Prepared, String> {
    let cluster = &entry.cluster;
    let provider = cluster.provider.as_str();
    if connection.provider != provider {
        return Err("Its connection is for another provider.".to_string());
    }
    match provider {
        providers::AWS => prepare_aws(entry, connection, helper),
        providers::GCP => gcp::prepare(
            connection,
            &cluster.name,
            cluster.status.as_deref(),
            cluster.endpoint.as_deref(),
            entry.certificate_authority.as_deref(),
            cli::gke_plugin_path().as_deref(),
        ),
        providers::AZURE => {
            let group = entry
                .resource_group
                .as_deref()
                .ok_or("The resource group of this cluster is not known. Refresh the catalog.")?;
            azure::prepare(
                &cluster.account_id,
                group,
                &cluster.name,
                cluster_id,
                helper,
            )
            .await
        }
        providers::DIGITALOCEAN if connection.kind == ConnectionKind::Cli => {
            let native = entry
                .native_id
                .as_deref()
                .ok_or("Refresh the catalog first.")?;
            doctl::prepare(connection, native, &cluster.name, cluster.status.as_deref()).await
        }
        other => {
            let provider = jp_auth_core::cloud::Provider::from_id(other)
                .ok_or_else(|| format!("JET Pilot can't add clusters of \"{other}\"."))?;
            let native = entry
                .native_id
                .clone()
                .ok_or("Refresh the catalog first.")?;
            let target = api::AddTarget {
                cluster_id: cluster_id.to_string(),
                native_id: native,
                name: cluster.name.clone(),
                region: cluster.region.clone(),
                status: cluster.status.clone(),
                endpoint: cluster.endpoint.clone(),
            };
            api::prepare(&providers::context(), provider, connection, &target, helper).await
        }
    }
}

fn planned(
    entry: &StoredCluster,
    connection: &CloudConnection,
    cluster_id: String,
    prepared: Prepared,
) -> Planned {
    let cluster = &entry.cluster;
    Planned {
        desired_name: context_name(&cluster.provider, &cluster.region, &cluster.name),
        fingerprint: managed::fingerprint(prepared.cluster.server.as_deref(), &prepared.identity),
        meta: CloudMeta {
            provider: cluster.provider.clone(),
            connection_id: connection.id.clone(),
            account_id: Some(cluster.account_id.clone()).filter(|a| !a.is_empty()),
            role_name: cluster.role_name.clone().filter(|r| !r.is_empty()),
            profile: entry.profile.clone(),
            region: cluster.region.clone(),
            name: cluster.name.clone(),
            native_id: prepared.native_id.or_else(|| entry.native_id.clone()),
            catalog_key: cluster.key.clone(),
        },
        id: cluster_id,
        cluster: prepared.cluster,
        user: prepared.user,
        secrets: prepared.secrets,
        warnings: prepared.warnings,
    }
}

/// Writes the prepared clusters: secrets into the vault first, then the
/// managed kubeconfig at `path` (removing the secrets again when that
/// fails). Clusters added meanwhile are returned as added.
fn write(
    path: &Path,
    outcomes: Vec<(String, Outcome)>,
    known_names: &HashSet<String>,
    store: &jp_auth_core::vault::Store,
) -> Result<AddResult, AppError> {
    let secrets: Vec<(String, serde_json::Value)> = outcomes
        .iter()
        .filter_map(|(_, o)| match o {
            Outcome::Planned(p) => Some(p.secrets.clone()),
            _ => None,
        })
        .flatten()
        .collect();
    let secret_ids: Vec<String> = secrets.iter().map(|(id, _)| id.clone()).collect();
    let vault_error =
        |e: jp_auth_core::vault::VaultError| AppError::from(jp_auth_core::aws::AwsError::Vault(e));
    store.put_and_remove(secrets, &[]).map_err(vault_error)?;
    let path_text = path.to_string_lossy().into_owned();
    let result = managed::update(path, |doc| {
        let mut taken: HashSet<String> = known_names.clone();
        taken.extend(managed::context_names(doc).map(str::to_string));
        let existing = added_contexts(doc);
        let mut result = AddResult {
            added: Vec::new(),
            failed: Vec::new(),
            warnings: Vec::new(),
        };
        for (key, outcome) in outcomes {
            let reference = |context: &str| ContextRef {
                kube_config: path_text.clone(),
                context: context.to_string(),
            };
            match outcome {
                Outcome::Added(context) => result.added.push(reference(&context)),
                Outcome::Failed(message) => result.failed.push(AddFailure { key, message }),
                Outcome::Planned(_) if existing.contains_key(&key) => {
                    result.added.push(reference(&existing[&key]));
                }
                Outcome::Planned(planned) => {
                    let planned = *planned;
                    let name = naming::unique_name(&planned.desired_name, &taken);
                    taken.insert(name.clone());
                    let internal = naming::internal_name(&planned.id);
                    let mut context = Context {
                        cluster: internal.clone(),
                        user: Some(internal.clone()),
                        ..Context::default()
                    };
                    managed::set_meta(
                        &mut context,
                        &ClusterMeta {
                            id: planned.id.clone(),
                            origin: "cloud".to_string(),
                            added_at: managed::now_ms(),
                            source_path: None,
                            fingerprint: Some(planned.fingerprint.clone()),
                        },
                    );
                    managed::set_cloud_meta(&mut context, &planned.meta);
                    doc.clusters.retain(|c| c.name != internal);
                    doc.auth_infos.retain(|u| u.name != internal);
                    doc.clusters.push(NamedCluster {
                        name: internal.clone(),
                        cluster: Some(planned.cluster),
                        other: managed::no_other(),
                    });
                    doc.auth_infos.push(NamedAuthInfo {
                        name: internal,
                        auth_info: Some(planned.user),
                        other: managed::no_other(),
                    });
                    doc.contexts.push(NamedContext {
                        name: name.clone(),
                        context: Some(context),
                        other: managed::no_other(),
                    });
                    result.added.push(reference(&name));
                    result
                        .warnings
                        .extend(planned.warnings.into_iter().map(|message| AddWarning {
                            key: key.clone(),
                            message,
                        }));
                }
            }
        }
        if doc.current_context.as_deref().is_none_or(str::is_empty) {
            doc.current_context = result.added.first().map(|r| r.context.clone());
        }
        Ok(result)
    });
    if result.is_err() && !secret_ids.is_empty() {
        let _ = store.put_and_remove(Vec::new(), &secret_ids);
    }
    result
}

/// Prepares the requested catalog keys (in order, a few at a time).
async fn prepare_all(
    keys: Vec<String>,
    file: &CatalogFile,
    connections: &[CloudConnection],
    existing: &HashMap<String, String>,
    helper: &Path,
) -> Vec<(String, Outcome)> {
    let mut seen = HashSet::new();
    let jobs: Vec<(String, Option<StoredCluster>)> = keys
        .into_iter()
        .filter(|k| seen.insert(k.clone()))
        .map(|key| {
            let entry = file.clusters.iter().find(|c| c.cluster.key == key).cloned();
            (key, entry)
        })
        .collect();
    stream::iter(jobs.into_iter().map(|(key, entry)| async move {
        let Some(entry) = entry else {
            return (
                key,
                Outcome::Failed(
                    "This cluster is not in the catalog. Refresh it and try again.".to_string(),
                ),
            );
        };
        if let Some(context) = existing.get(&key) {
            return (key, Outcome::Added(context.clone()));
        }
        if entry.cluster.state == CatalogState::Removed {
            let message = format!("{} no longer exists.", entry.cluster.name);
            return (key, Outcome::Failed(message));
        }
        let Some(connection) = connections
            .iter()
            .find(|c| c.id == entry.cluster.connection_id)
        else {
            return (
                key,
                Outcome::Failed("Its connection was removed.".to_string()),
            );
        };
        let id = cloud_cluster_id(&entry.cluster.provider, &key);
        let outcome = match prepare(&entry, connection, &id, helper).await {
            Ok(prepared) => Outcome::Planned(Box::new(planned(&entry, connection, id, prepared))),
            Err(message) => Outcome::Failed(message),
        };
        (key, outcome)
    }))
    .buffered(ADD_CONCURRENCY)
    .collect()
    .await
}

/* ------------------------------------------------------------ commands */

/// The catalog as last refreshed (instant: no network).
#[tauri::command]
pub async fn catalog_get() -> Result<CatalogSnapshot, AppError> {
    super::blocking(|| snapshot(&read()?)).await
}

/// One refresh at a time.
static REFRESH: Lazy<tokio::sync::Mutex<()>> = Lazy::new(|| tokio::sync::Mutex::new(()));

/// Discovers the clusters of the given connections (all when None),
/// streaming progress per scope + region on `on_event`. Connections that
/// need a sign-in are skipped with an error progress event. Resolves after
/// the `done` event.
#[tauri::command]
pub async fn catalog_refresh(
    connection_ids: Option<Vec<String>>,
    on_event: Channel<CatalogEvent>,
) -> Result<(), AppError> {
    let sink: Arc<dyn Fn(CatalogEvent) + Send + Sync> = Arc::new(move |event| {
        let _ = on_event.send(event);
    });
    refresh(connection_ids, sink).await
}

pub(crate) async fn refresh(
    connection_ids: Option<Vec<String>>,
    sink: Arc<dyn Fn(CatalogEvent) + Send + Sync>,
) -> Result<(), AppError> {
    let _running = REFRESH.lock().await;
    let connections_file = providers::aws::context().connections_file;
    let connections = super::blocking(move || {
        jp_auth_core::connections::load(&connections_file)
            .map_err(|e| AppError::io("The connections can't be read", e))
    })
    .await?;
    let selected: Vec<CloudConnection> = connections
        .into_iter()
        .filter(|c| {
            connection_ids
                .as_ref()
                .is_none_or(|ids| ids.contains(&c.id))
        })
        .collect();

    for connection in selected {
        let id = connection.id.clone();
        let progress_sink = sink.clone();
        let progress_id = id.clone();
        let progress: Arc<providers::ProgressFn> = Arc::new(move |p: providers::Progress| {
            progress_sink(CatalogEvent::Progress {
                connection_id: progress_id.clone(),
                scope: p.scope,
                state: match p.state {
                    providers::ProgressState::Running => ProgressState::Running,
                    providers::ProgressState::Done => ProgressState::Done,
                    providers::ProgressState::Error => ProgressState::Error,
                },
                message: p.message,
                account_id: p.account_id,
                account_name: p.account_name,
                region: p.region,
            });
        });
        let found = providers::discover(&connection, progress).await;
        let listed = found.listings.iter().filter(|l| l.complete).count();
        info!(
            "Catalog: {} listed {} of {} scopes",
            connection.display_name(),
            listed,
            found.listings.len()
        );

        let (clusters, outcome) = {
            let id = id.clone();
            let provider = connection.provider.clone();
            let found = found.clone();
            super::blocking(move || {
                let now = managed::now_ms();
                let file = update(|file| {
                    for listing in &found.listings {
                        merge(&mut file.clusters, &provider, &id, listing, now);
                    }
                    file.refreshed_at = Some(now);
                    CatalogFile {
                        version: 1,
                        refreshed_at: file.refreshed_at,
                        clusters: file.clusters.clone(),
                    }
                })?;
                let snapshot = snapshot(&file)?;
                let clusters: Vec<CatalogCluster> = snapshot
                    .clusters
                    .into_iter()
                    .filter(|c| c.connection_id == id)
                    .collect();
                let outcome = if found.needs_sign_in {
                    None
                } else if listed == 0 && found.error.is_some() {
                    Some(Err(found.error.clone().unwrap_or_default()))
                } else if listed == 0 && !found.listings.is_empty() {
                    Some(Err("No region could be listed".to_string()))
                } else {
                    Some(Ok(found.identity.clone()))
                };
                Ok((clusters, outcome))
            })
            .await?
        };
        if let Some(outcome) = outcome {
            let id = id.clone();
            if let Err(e) =
                super::blocking(move || super::connections::record_status(&id, outcome)).await
            {
                warn!("Could not record the connection status: {}", e);
            }
        }
        sink(CatalogEvent::Clusters {
            connection_id: id,
            clusters,
        });
    }
    let refreshed_at = managed::now_ms();
    sink(CatalogEvent::Done { refreshed_at });
    Ok(())
}

/// Ignores clusters (or makes them available again). Dismissing a removed
/// cluster (`ignored`) deletes it from the catalog.
#[tauri::command]
pub async fn catalog_set_state(keys: Vec<String>, state: CatalogState) -> Result<(), AppError> {
    if !matches!(state, CatalogState::Available | CatalogState::Ignored) {
        return Err(AppError::invalid(
            "state",
            "A cluster can only be made available or ignored.",
        ));
    }
    super::blocking(move || {
        update(|file| {
            file.clusters.retain_mut(|entry| {
                if !keys.contains(&entry.cluster.key) {
                    return true;
                }
                match (entry.cluster.state, state) {
                    (CatalogState::Removed, CatalogState::Ignored) => false,
                    (CatalogState::Removed, _) => true,
                    _ => {
                        entry.cluster.state = state;
                        true
                    }
                }
            })
        })
    })
    .await
}

/// Adds catalog clusters to the managed kubeconfig (context names
/// `<eks|gke|aks|do|lke|civo|scw|vke|sks>-<region>-<name>`, made unique).
/// EKS, DigitalOcean (token) and Exoscale clusters run the `jetpilot-auth`
/// helper; GKE `gke-gcloud-auth-plugin`; AKS `kubelogin` (Azure CLI login)
/// or, with local accounts, the stored credential; doctl connections
/// doctl; Akamai, Civo, Scaleway and Vultr clusters their static
/// credential from the vault. `warnings` tell about missing plugins.
#[tauri::command]
pub async fn catalog_add(
    keys: Vec<String>,
    options: Option<AddOptions>,
) -> Result<AddResult, AppError> {
    let _ = options;
    if keys.is_empty() {
        return Err(AppError::invalid(
            "keys",
            "Choose at least one cluster to add.",
        ));
    }
    let path = managed_file();
    let (file, connections, known, existing) = {
        let path = path.clone();
        super::blocking(move || {
            let file = read()?;
            let ctx = providers::aws::context();
            let connections = jp_auth_core::connections::load(&ctx.connections_file)
                .map_err(|e| AppError::io("The connections can't be read", e))?;
            let known = known_names();
            let existing = added_contexts(&managed::read(&path)?);
            Ok((file, connections, known, existing))
        })
        .await?
    };
    let helper = jp_auth_core::paths::helper_path();
    let outcomes = prepare_all(keys, &file, &connections, &existing, &helper).await;
    let store = providers::context().store;
    let result = super::blocking(move || write(&path, outcomes, &known, &store)).await?;
    super::emit(CHANGED_EVENT);
    info!(
        "Added {} clusters from the catalog ({} failed, {} warnings)",
        result.added.len(),
        result.failed.len(),
        result.warnings.len()
    );
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use providers::Found;

    fn found(name: &str) -> Found {
        Found {
            name: name.to_string(),
            region: "eu-west-1".into(),
            native_id: Some(format!("arn:aws:eks:eu-west-1:123456789012:cluster/{name}")),
            version: Some("1.31".into()),
            status: Some("ACTIVE".into()),
            endpoint: Some(format!("https://{name}.gr7.eu-west-1.eks.amazonaws.com")),
            created_at: Some(1_700_000_000_000),
            certificate_authority: Some("Q0VSVA==".into()),
            resource_group: None,
            described: true,
        }
    }

    fn listing(region: &str, complete: bool, clusters: Vec<Found>) -> Listing {
        Listing {
            account_id: "123456789012".into(),
            account_name: Some("acme-prod".into()),
            role_name: Some("ReadOnly".into()),
            profile: None,
            regions: Some(vec![region.into()]),
            complete,
            clusters: clusters
                .into_iter()
                .map(|mut c| {
                    c.region = region.to_string();
                    c
                })
                .collect(),
        }
    }

    fn state_of(stored: &[StoredCluster], name: &str) -> Option<CatalogState> {
        stored
            .iter()
            .find(|c| c.cluster.name == name)
            .map(|c| c.cluster.state)
    }

    fn memory_store(dir: &Path) -> jp_auth_core::vault::Store {
        use jp_auth_core::vault::{KdfParams, MemoryKeychain, MemoryUnlockCache, Store, VaultEnv};
        Store::new(
            VaultEnv {
                dir: dir.join("vault"),
                keychain: Arc::new(MemoryKeychain::new()),
                unlock_cache: Arc::new(MemoryUnlockCache::default()),
                kdf: KdfParams::INSECURE_FOR_TESTS,
            },
            None,
        )
    }

    /// `catalog_add` without the app: prepare (AWS needs no network) and
    /// write.
    fn add_to(
        path: &Path,
        stored: &[StoredCluster],
        keys: Vec<String>,
        connections: &[CloudConnection],
        known: &HashSet<String>,
        helper: &Path,
    ) -> AddResult {
        let file = CatalogFile {
            version: 1,
            refreshed_at: None,
            clusters: stored.to_vec(),
        };
        let existing = added_contexts(&managed::read(path).unwrap());
        let outcomes = tauri::async_runtime::block_on(prepare_all(
            keys,
            &file,
            connections,
            &existing,
            helper,
        ));
        let store = memory_store(path.parent().unwrap());
        write(path, outcomes, known, &store).unwrap()
    }

    #[test]
    fn merging_marks_removed_only_on_complete_listings() {
        let mut stored = Vec::new();
        merge(
            &mut stored,
            "aws",
            "c1",
            &listing(
                "eu-west-1",
                true,
                vec![found("prod"), found("dev"), found("old")],
            ),
            1,
        );
        merge(
            &mut stored,
            "aws",
            "c1",
            &listing("us-east-1", true, vec![found("us")]),
            1,
        );
        assert_eq!(stored.len(), 4);
        assert_eq!(stored[0].cluster.key, "aws:c1:123456789012:eu-west-1:prod");
        assert_eq!(stored[0].cluster.account_name.as_deref(), Some("acme-prod"));
        assert_eq!(stored[0].cluster.role_name.as_deref(), Some("ReadOnly"));
        assert!(stored
            .iter()
            .all(|c| c.cluster.state == CatalogState::Available));
        stored
            .iter_mut()
            .find(|c| c.cluster.name == "dev")
            .unwrap()
            .cluster
            .state = CatalogState::Ignored;

        // A failed listing changes nothing.
        merge(
            &mut stored,
            "aws",
            "c1",
            &listing("eu-west-1", false, vec![]),
            2,
        );
        assert_eq!(stored.len(), 4);
        assert!(stored
            .iter()
            .all(|c| c.cluster.state != CatalogState::Removed));

        // A complete one: "old" is removed, ignored "dev" is dropped, the
        // other region is untouched; a newcomer appears.
        let mut prod = found("prod");
        prod.version = Some("1.32".into());
        merge(
            &mut stored,
            "aws",
            "c1",
            &listing("eu-west-1", true, vec![prod, found("new")]),
            3,
        );
        assert_eq!(state_of(&stored, "old"), Some(CatalogState::Removed));
        assert_eq!(state_of(&stored, "dev"), None);
        assert_eq!(state_of(&stored, "us"), Some(CatalogState::Available));
        assert_eq!(state_of(&stored, "new"), Some(CatalogState::Available));
        let prod = stored.iter().find(|c| c.cluster.name == "prod").unwrap();
        assert_eq!(prod.cluster.version.as_deref(), Some("1.32"));
        assert_eq!(prod.seen_at, 3);

        // A cluster that comes back is available again; a describe failure
        // keeps the known details.
        let mut back = found("old");
        back.described = false;
        back.version = None;
        merge(
            &mut stored,
            "aws",
            "c1",
            &listing("eu-west-1", true, vec![found("prod"), found("new"), back]),
            4,
        );
        assert_eq!(state_of(&stored, "old"), Some(CatalogState::Available));
        assert_eq!(
            stored
                .iter()
                .find(|c| c.cluster.name == "old")
                .unwrap()
                .cluster
                .version
                .as_deref(),
            Some("1.31")
        );

        // Another connection's listing never touches these.
        merge(
            &mut stored,
            "aws",
            "c2",
            &listing("eu-west-1", true, vec![]),
            5,
        );
        assert_eq!(state_of(&stored, "prod"), Some(CatalogState::Available));
    }

    #[test]
    fn account_wide_listings_cover_their_regions_and_keys_use_stable_handles() {
        let cluster = |id: &str, name: &str, region: &str| Found {
            name: name.into(),
            region: region.into(),
            native_id: Some(id.into()),
            status: Some("running".into()),
            described: true,
            ..Found::default()
        };
        let whole = |clusters: Vec<Found>, regions: Option<Vec<String>>| Listing {
            account_id: String::new(),
            account_name: None,
            role_name: None,
            profile: None,
            regions,
            complete: true,
            clusters,
        };
        let mut stored = Vec::new();
        // Vultr labels need not be unique: the id is the handle.
        merge(
            &mut stored,
            "vultr",
            "v1",
            &whole(
                vec![cluster("id-1", "web", "ams"), cluster("id-2", "web", "ewr")],
                None,
            ),
            1,
        );
        assert_eq!(stored[0].cluster.key, "vultr:v1:-:ams:id-1");
        assert_eq!(stored[0].native_id.as_deref(), Some("id-1"));
        assert_eq!(stored[0].cluster.account_id, "");

        // Filtered to ams: ewr isn't covered, so it stays.
        merge(
            &mut stored,
            "vultr",
            "v1",
            &whole(vec![], Some(vec!["ams".into()])),
            2,
        );
        assert_eq!(stored[0].cluster.state, CatalogState::Removed);
        assert_eq!(stored[1].cluster.state, CatalogState::Available);
        // Every region: ewr is gone too.
        merge(&mut stored, "vultr", "v1", &whole(vec![], None), 3);
        assert_eq!(stored[1].cluster.state, CatalogState::Removed);

        // AKS: resource group + name; GKE zonal clusters are in their region.
        let mut aks = cluster(
            "/subscriptions/s/resourceGroups/RG-A/x",
            "prod",
            "westeurope",
        );
        aks.resource_group = Some("RG-A".into());
        assert_eq!(key_handle("azure", &aks), "rg-a/prod");
        assert_eq!(key_handle("gcp", &aks), "prod");
        assert_eq!(
            key_handle("digitalocean", &aks),
            aks.native_id.clone().unwrap()
        );
        assert!(providers::region_matches("europe-west1", "europe-west1-b"));
        assert!(providers::region_matches("LON1", "lon1"));
        assert!(!providers::region_matches("europe-west1", "europe-west12"));
        assert!(!providers::region_matches("us-east", "us-east-1"));

        assert_eq!(
            context_name("digitalocean", "AMS3", "my web"),
            "do-ams3-my-web"
        );
        assert_eq!(context_name("civo", "LON1", "k3s"), "civo-lon1-k3s");
        assert!(cloud_cluster_id("exoscale", "k").starts_with("sks-"));
        assert!(jp_auth_core::request::valid_cluster_id(&cloud_cluster_id(
            "scaleway", "k"
        )));
    }

    #[test]
    fn stored_entries_of_1_43_still_load() {
        let text = r#"{"version":1,"clusters":[{"key":"aws:c1:1:eu-west-1:p","provider":"aws","connectionId":"c1",
            "accountId":"1","region":"eu-west-1","name":"p","state":"available","arn":"arn:aws:eks:x","seenAt":1}]}"#;
        let file: CatalogFile = serde_json::from_str(text).unwrap();
        assert_eq!(file.clusters[0].native_id.as_deref(), Some("arn:aws:eks:x"));
        let json = serde_json::to_value(&file.clusters[0]).unwrap();
        assert_eq!(json["nativeId"], "arn:aws:eks:x");
    }

    fn sso_connection() -> CloudConnection {
        CloudConnection {
            id: "c1".into(),
            provider: "aws".into(),
            kind: ConnectionKind::Sso,
            label: "Acme".into(),
            identity: None,
            sso: Some(jp_auth_core::connections::SsoSettings {
                start_url: "https://acme.awsapps.com/start".into(),
                region: "eu-west-1".into(),
            }),
            profile: None,
            region: None,
            regions: vec![],
            targets: vec![],
            cli_account: None,
            project_id: None,
            exoscale: None,
            status: jp_auth_core::connections::ConnectionStatus::SignedIn,
            expires_at: None,
            message: None,
            created_at: 0,
        }
    }

    #[test]
    fn adding_writes_helper_entries_and_derives_added() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("jp").join("config");
        let helper = Path::new("/home/me/.kube/jet-pilot/bin/jetpilot-auth");
        let mut stored = Vec::new();
        merge(
            &mut stored,
            "aws",
            "c1",
            &listing("eu-west-1", true, vec![found("prod"), found("dev")]),
            1,
        );
        let mut creating = found("fresh");
        creating.status = Some("CREATING".into());
        creating.endpoint = None;
        creating.certificate_authority = None;
        merge(
            &mut stored,
            "aws",
            "c1",
            &listing(
                "eu-west-1",
                true,
                vec![found("prod"), found("dev"), creating],
            ),
            1,
        );
        let key = |name: &str| {
            stored
                .iter()
                .find(|c| c.cluster.name == name)
                .map(|e| e.cluster.key.clone())
                .unwrap()
        };
        let known: HashSet<String> = ["eks-eu-west-1-prod".to_string()].into();
        let result = add_to(
            &path,
            &stored,
            vec![key("prod"), key("fresh"), "aws:c1:nope".to_string()],
            &[sso_connection()],
            &known,
            helper,
        );
        assert_eq!(result.added.len(), 1);
        // The name was taken in another kubeconfig: a suffix.
        assert_eq!(result.added[0].context, "eks-eu-west-1-prod-2");
        assert_eq!(result.failed.len(), 2);
        assert_eq!(
            result.failed[0].message,
            "fresh is not ready yet (CREATING)."
        );
        assert!(result.warnings.is_empty());

        let doc = managed::read(&path).unwrap();
        let context = doc
            .contexts
            .iter()
            .find(|c| c.name == "eks-eu-west-1-prod-2")
            .unwrap();
        let meta = managed::meta_of(context).unwrap();
        assert_eq!(meta.origin, "cloud");
        assert!(meta.id.starts_with("eks-") && jp_auth_core::request::valid_cluster_id(&meta.id));
        let cloud = managed::cloud_meta_of(context).unwrap();
        assert_eq!(cloud.catalog_key, "aws:c1:123456789012:eu-west-1:prod");
        assert_eq!(
            cloud.native_id.as_deref(),
            Some("arn:aws:eks:eu-west-1:123456789012:cluster/prod")
        );
        assert_eq!(cloud.account_id.as_deref(), Some("123456789012"));
        assert_eq!(cloud.region, "eu-west-1");

        let internal = naming::internal_name(&meta.id);
        let cluster = doc
            .clusters
            .iter()
            .find(|c| c.name == internal)
            .unwrap()
            .cluster
            .clone()
            .unwrap();
        assert_eq!(
            cluster.server.as_deref(),
            Some("https://prod.gr7.eu-west-1.eks.amazonaws.com")
        );
        assert_eq!(
            cluster.certificate_authority_data.as_deref(),
            Some("Q0VSVA==")
        );
        let exec = doc
            .auth_infos
            .iter()
            .find(|u| u.name == internal)
            .unwrap()
            .auth_info
            .as_ref()
            .unwrap()
            .exec
            .clone()
            .unwrap();
        assert_eq!(
            exec.command.as_deref(),
            Some("/home/me/.kube/jet-pilot/bin/jetpilot-auth")
        );
        assert_eq!(
            exec.args.clone().unwrap().join(" "),
            "credential aws-eks --connection c1 --account 123456789012 --role ReadOnly --region eu-west-1 --cluster prod"
        );
        assert_eq!(
            exec.interactive_mode,
            Some(kube::config::ExecInteractiveMode::Never)
        );
        assert!(matches!(
            managed::helper_request(&exec),
            Some(jp_auth_core::request::Request::CredentialAwsEks(_))
        ));
        // The kubeconfig has no secrets and lists the cloud origin.
        let listed = managed::list(&doc);
        assert_eq!(listed[0].cloud.as_ref().unwrap().connection_id, "c1");

        // Adding again is idempotent; the catalog shows it as added.
        let again = add_to(
            &path,
            &stored,
            vec![key("prod")],
            &[sso_connection()],
            &known,
            helper,
        );
        assert_eq!(again.added, result.added);
        assert_eq!(managed::read(&path).unwrap().contexts.len(), 1);
        let clusters = derive(&stored, &managed::read(&path).unwrap(), &path);
        let prod = clusters.iter().find(|c| c.name == "prod").unwrap();
        assert_eq!(prod.state, CatalogState::Added);
        assert_eq!(
            prod.added_context.as_ref().unwrap().context,
            "eks-eu-west-1-prod-2"
        );
        assert_eq!(
            clusters.iter().find(|c| c.name == "dev").unwrap().state,
            CatalogState::Available
        );
        let json = serde_json::to_value(prod).unwrap();
        assert_eq!(json["connectionId"], "c1");
        assert_eq!(
            json["addedContext"]["kubeConfig"],
            path.to_string_lossy().as_ref()
        );
        assert!(json.get("certificateAuthority").is_none());
        assert!(json.get("nativeId").is_none());

        // Removed upstream but still added: flagged removed, context kept.
        merge(
            &mut stored,
            "aws",
            "c1",
            &listing("eu-west-1", true, vec![found("dev")]),
            2,
        );
        let clusters = derive(&stored, &managed::read(&path).unwrap(), &path);
        let prod = clusters.iter().find(|c| c.name == "prod").unwrap();
        assert_eq!(prod.state, CatalogState::Removed);
        assert!(prod.added_context.is_some());
    }

    #[test]
    fn profile_and_key_connections_get_their_helper_arguments() {
        let mut stored = Vec::new();
        let mut l = listing("eu-west-1", true, vec![found("prod")]);
        l.role_name = None;
        l.profile = Some("dev-admin".into());
        merge(&mut stored, "aws", "c2", &l, 1);
        let mut profile = sso_connection();
        profile.id = "c2".into();
        profile.kind = ConnectionKind::Profile;
        profile.profile = Some("dev-admin".into());
        let prepared = prepare_aws(&stored[0], &profile, Path::new("/bin/jetpilot-auth")).unwrap();
        let args = prepared.user.exec.unwrap().args.unwrap().join(" ");
        assert_eq!(args, "credential aws-eks --connection c2 --profile dev-admin --region eu-west-1 --cluster prod");

        let mut keys = profile.clone();
        keys.kind = ConnectionKind::Keys;
        let prepared = prepare_aws(&stored[0], &keys, Path::new("/bin/jetpilot-auth")).unwrap();
        let args = prepared.user.exec.unwrap().args.unwrap().join(" ");
        assert_eq!(
            args,
            "credential aws-eks --connection c2 --region eu-west-1 --cluster prod"
        );
        assert_eq!(
            context_name("aws", &stored[0].cluster.region, &stored[0].cluster.name),
            "eks-eu-west-1-prod"
        );
    }
}

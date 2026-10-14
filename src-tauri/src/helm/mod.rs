//! Helm, natively where it can be.
//!
//! Reads (releases, history, a revision's values / manifest / notes) come
//! straight from helm's storage objects through the cached kube client: no
//! helm binary, no exec credential plugin per call, and lists stay fast on
//! clusters with hundreds of releases (see `storage`). Changes (install,
//! upgrade, rollback, uninstall) still run the helm CLI (`workloads.rs` and
//! the front end), which owns the release logic.
//!
//! - `artifacthub`: chart search on artifacthub.io, only on user searches;
//! - `chart`: a chart's Chart.yaml, values, schema and README, pulled with
//!   helm into a temporary directory.

pub mod artifacthub;
pub mod chart;
pub mod storage;

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;

use futures::{StreamExt, TryStreamExt};
use k8s_openapi::api::core::v1::{ConfigMap, Secret};
use kube::api::{Api, ListParams};
use kube::Client;
use once_cell::sync::Lazy;
use tracing::{debug, warn};

use crate::kubernetes::client::{api_error, client_with_context, SerializableKubeError};
use crate::util::lock;
use storage::{
    decode_release, latest_revisions, HelmRelease, HelmReleaseDetail, HelmRevision, RawRelease,
    RawReleaseSummary, RawRevision, StoredRevision,
};

/// A whole list (every namespace, both drivers) may take this long.
const LIST_TIMEOUT: Duration = Duration::from_secs(45);
/// Release objects decoded at the same time.
const DECODE_CONCURRENCY: usize = 8;
const HELM_SELECTOR: &str = "owner=helm";
const RELEASE_KEY: &str = "release";

fn timeout_error(what: &str) -> SerializableKubeError {
    SerializableKubeError {
        message: format!("Reading {what} took longer than {} seconds", LIST_TIMEOUT.as_secs()),
        code: Some(504),
        reason: Some("Timeout".into()),
        details: None,
        auth: None,
    }
}

fn decode_error(message: String) -> SerializableKubeError {
    SerializableKubeError { message, code: None, reason: Some("Undecodable".into()), details: None, auth: None }
}

/// Decoded release summaries by storage object uid + resourceVersion, per
/// cluster: a refresh only decodes what changed since the last list.
type SummaryCache = HashMap<(String, String), HashMap<String, (String, HelmRelease)>>;
static SUMMARIES: Lazy<Mutex<SummaryCache>> = Lazy::new(Default::default);

fn all_namespaces(namespaces: &[String]) -> bool {
    namespaces.is_empty() || namespaces.iter().any(|n| n == "all")
}

/// Metadata of helm's storage objects (both drivers) in `namespaces`.
async fn list_stored(
    client: &Client,
    namespaces: &[String],
    label_selector: &str,
) -> Result<Vec<StoredRevision>, kube::Error> {
    let scopes: Vec<Option<&str>> =
        if all_namespaces(namespaces) { vec![None] } else { namespaces.iter().map(|n| Some(n.as_str())).collect() };
    let params = ListParams::default().labels(label_selector);

    let secrets = futures::future::try_join_all(scopes.iter().map(|scope| {
        let api: Api<Secret> = match scope {
            Some(ns) => Api::namespaced(client.clone(), ns),
            None => Api::all(client.clone()),
        };
        let params = params.clone();
        async move { api.list_metadata(&params).await }
    }));
    let configmaps = futures::future::join_all(scopes.iter().map(|scope| {
        let api: Api<ConfigMap> = match scope {
            Some(ns) => Api::namespaced(client.clone(), ns),
            None => Api::all(client.clone()),
        };
        let params = params.clone();
        async move { api.list_metadata(&params).await }
    }));
    let (secrets, configmaps) = futures::join!(secrets, configmaps);

    let mut stored: Vec<StoredRevision> = secrets?
        .into_iter()
        .flat_map(|list| list.items)
        .filter_map(|item| StoredRevision::from_meta(&item.metadata, "secret"))
        .collect();
    // The ConfigMap driver is rare: a cluster that doesn't let us list
    // ConfigMaps still lists its Secret releases.
    for list in configmaps {
        match list {
            Ok(list) => stored.extend(
                list.items.into_iter().filter_map(|item| StoredRevision::from_meta(&item.metadata, "configmap")),
            ),
            Err(e) => debug!("Not listing helm ConfigMap releases: {}", e),
        }
    }
    Ok(stored)
}

/// The encoded release of a storage object.
async fn read_encoded(client: &Client, stored: &StoredRevision) -> Result<Vec<u8>, kube::Error> {
    let missing = || -> Vec<u8> { Vec::new() };
    if stored.storage == "configmap" {
        let api: Api<ConfigMap> = Api::namespaced(client.clone(), &stored.namespace);
        let object = api.get(&stored.object).await?;
        Ok(object.data.and_then(|mut d| d.remove(RELEASE_KEY)).map(String::into_bytes).unwrap_or_else(missing))
    } else {
        let api: Api<Secret> = Api::namespaced(client.clone(), &stored.namespace);
        let object = api.get(&stored.object).await?;
        Ok(object.data.and_then(|mut d| d.remove(RELEASE_KEY)).map(|b| b.0).unwrap_or_else(missing))
    }
}

/// A list row from the labels alone, for objects that can't be decoded.
fn label_row(stored: &StoredRevision) -> HelmRelease {
    HelmRelease {
        name: stored.release.clone(),
        namespace: stored.namespace.clone(),
        revision: stored.revision,
        status: if stored.status.is_empty() { "unknown".into() } else { stored.status.clone() },
        chart: String::new(),
        chart_version: String::new(),
        app_version: String::new(),
        updated: None,
        description: String::new(),
        icon: None,
        storage: stored.storage.to_string(),
    }
}

async fn summarize(client: &Client, stored: &StoredRevision) -> HelmRelease {
    let decoded = match read_encoded(client, stored).await {
        Ok(encoded) => decode_release::<RawReleaseSummary>(&encoded),
        Err(e) => Err(e.to_string()),
    };
    match decoded {
        Ok(summary) => summary.into_release(stored.storage, &stored.status),
        Err(e) => {
            warn!("Unable to read helm release {}/{}: {}", stored.namespace, stored.object, e);
            label_row(stored)
        }
    }
}

/// The latest revision of every Helm release in `namespaces` (`["all"]` or
/// empty: every namespace), from Secrets and ConfigMaps. Uninstalled
/// releases kept with `--keep-history` are left out, like `helm list`.
#[tauri::command]
pub async fn helm_releases(
    context: &str,
    kube_config: Option<String>,
    namespaces: Vec<String>,
) -> Result<Vec<HelmRelease>, SerializableKubeError> {
    if let Some(bad) = namespaces.iter().find(|n| *n != "all" && !valid_namespace(n)) {
        return Err(bad_request(format!("'{bad}' is not a namespace")));
    }
    let client = client_with_context(context, kube_config.as_deref()).await?;
    let cache_key = (kube_config.clone().unwrap_or_default(), context.to_string());

    let work = async {
        let stored = list_stored(&client, &namespaces, HELM_SELECTOR)
            .await
            .map_err(|e| api_error(e, kube_config.as_deref(), context))?;
        let latest = latest_revisions(stored);

        let cached: HashMap<String, (String, HelmRelease)> =
            lock(&SUMMARIES).get(&cache_key).cloned().unwrap_or_default();
        let rows: Vec<(String, String, HelmRelease)> = futures::stream::iter(latest)
            .map(|stored| {
                let hit = cached
                    .get(&stored.uid)
                    .filter(|(version, _)| !stored.uid.is_empty() && *version == stored.resource_version)
                    .map(|(_, row)| row.clone());
                let client = &client;
                async move {
                    let row = match hit {
                        Some(row) => row,
                        None => summarize(client, &stored).await,
                    };
                    (stored.uid, stored.resource_version, row)
                }
            })
            .buffer_unordered(DECODE_CONCURRENCY)
            .collect()
            .await;

        let mut cache = lock(&SUMMARIES);
        let entry = cache.entry(cache_key.clone()).or_default();
        // Everything listed: what's gone can go. Some namespaces: keep the rest.
        if all_namespaces(&namespaces) {
            entry.clear();
        }
        for (uid, version, row) in &rows {
            if !uid.is_empty() {
                entry.insert(uid.clone(), (version.clone(), row.clone()));
            }
        }
        drop(cache);

        let mut releases: Vec<HelmRelease> = rows.into_iter().map(|(_, _, row)| row).collect();
        releases.sort_by(|a, b| a.namespace.cmp(&b.namespace).then_with(|| a.name.cmp(&b.name)));
        Ok(releases)
    };
    tokio::time::timeout(LIST_TIMEOUT, work).await.map_err(|_| timeout_error("the Helm releases"))?
}

/// Storage objects of one release, newest first.
async fn release_objects(
    client: &Client,
    namespace: &str,
    name: &str,
) -> Result<Vec<StoredRevision>, kube::Error> {
    let selector = format!("{HELM_SELECTOR},name={name}");
    let mut stored = list_stored(client, &[namespace.to_string()], &selector).await?;
    stored.sort_by_key(|s| std::cmp::Reverse(s.revision));
    Ok(stored)
}

fn valid_release_name(name: &str) -> bool {
    !name.is_empty() && name.len() <= 53 && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '.')
}

/// A namespace name (it becomes part of the request path).
fn valid_namespace(namespace: &str) -> bool {
    !namespace.is_empty()
        && namespace.len() <= 63
        && namespace.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

fn bad_request(message: String) -> SerializableKubeError {
    SerializableKubeError {
        message,
        code: Some(400),
        reason: Some("BadRequest".into()),
        details: None,
        auth: None,
    }
}

/// Every stored revision of a release, newest first.
#[tauri::command]
pub async fn helm_history(
    context: &str,
    kube_config: Option<String>,
    namespace: &str,
    name: &str,
) -> Result<Vec<HelmRevision>, SerializableKubeError> {
    if !valid_release_name(name) || !valid_namespace(namespace) {
        return Err(bad_request(format!("'{name}' in '{namespace}' is not a Helm release")));
    }
    let client = client_with_context(context, kube_config.as_deref()).await?;
    let work = async {
        let stored = release_objects(&client, namespace, name)
            .await
            .map_err(|e| api_error(e, kube_config.as_deref(), context))?;
        let revisions: Vec<HelmRevision> = futures::stream::iter(stored)
            .map(|stored| {
                let client = &client;
                async move {
                    let encoded = read_encoded(client, &stored).await?;
                    Ok::<_, kube::Error>(match decode_release::<RawRevision>(&encoded) {
                        Ok(raw) => raw.into_revision(),
                        Err(e) => {
                            warn!("Unable to read helm revision {}/{}: {}", stored.namespace, stored.object, e);
                            let row = label_row(&stored);
                            HelmRevision {
                                revision: row.revision,
                                status: row.status,
                                chart: String::new(),
                                chart_version: String::new(),
                                app_version: String::new(),
                                updated: None,
                                description: e,
                                values: serde_json::Value::Object(Default::default()),
                            }
                        }
                    })
                }
            })
            .buffered(DECODE_CONCURRENCY)
            .try_collect()
            .await
            .map_err(|e| api_error(e, kube_config.as_deref(), context))?;
        Ok(revisions)
    };
    tokio::time::timeout(LIST_TIMEOUT, work).await.map_err(|_| timeout_error("the release history"))?
}

/// One revision of a release (the latest when `revision` is None): chart
/// metadata, user-supplied and computed values, manifest, notes and hooks.
#[tauri::command]
pub async fn helm_release_detail(
    context: &str,
    kube_config: Option<String>,
    namespace: &str,
    name: &str,
    revision: Option<u32>,
) -> Result<HelmReleaseDetail, SerializableKubeError> {
    if !valid_release_name(name) || !valid_namespace(namespace) {
        return Err(bad_request(format!("'{name}' in '{namespace}' is not a Helm release")));
    }
    let client = client_with_context(context, kube_config.as_deref()).await?;
    let work = async {
        let stored = release_objects(&client, namespace, name)
            .await
            .map_err(|e| api_error(e, kube_config.as_deref(), context))?;
        let object = match revision {
            Some(revision) => stored.into_iter().find(|s| s.revision == revision),
            None => stored.into_iter().next(),
        }
        .ok_or_else(|| SerializableKubeError {
            message: match revision {
                Some(revision) => format!("Revision {revision} of {name} was not found"),
                None => format!("Release {name} was not found in {namespace}"),
            },
            code: Some(404),
            reason: Some("NotFound".into()),
            details: None,
            auth: None,
        })?;
        let encoded = read_encoded(&client, &object)
            .await
            .map_err(|e| api_error(e, kube_config.as_deref(), context))?;
        let raw: RawRelease = tauri::async_runtime::spawn_blocking(move || decode_release(&encoded))
            .await
            .map_err(|e| decode_error(e.to_string()))?
            .map_err(decode_error)?;
        Ok(raw.into_detail())
    };
    tokio::time::timeout(LIST_TIMEOUT, work).await.map_err(|_| timeout_error("the release"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn release_names_are_validated() {
        assert!(valid_release_name("kube-prometheus-stack"));
        assert!(valid_release_name("a.b"));
        assert!(!valid_release_name(""));
        assert!(!valid_release_name("a,b"));
        assert!(!valid_release_name("x=y"));
        assert!(!valid_release_name(&"a".repeat(54)));
    }

    #[test]
    fn namespaces_are_validated() {
        assert!(valid_namespace("kube-system"));
        assert!(!valid_namespace(""));
        assert!(!valid_namespace("../secrets"));
        assert!(!valid_namespace("Payments"));
    }

    #[test]
    fn all_namespaces_scope() {
        assert!(all_namespaces(&[]));
        assert!(all_namespaces(&["all".into()]));
        assert!(!all_namespaces(&["default".into()]));
    }
}

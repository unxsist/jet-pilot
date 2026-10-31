//! The API versions each Helm release renders, for the Upgrades check.
//!
//! Helm compares an upgrade against the manifest it stored with the last
//! revision: when that manifest names an API the cluster no longer serves,
//! `helm upgrade` fails until the stored manifest is fixed. Only the kind,
//! apiVersion and name of every rendered object cross IPC, never the
//! manifest itself.

use futures::StreamExt;
use serde::{Deserialize, Serialize};
use tracing::warn;

use super::storage::{decode_release, latest_revisions};
use super::{
    bad_request, list_stored, read_encoded, timeout_error, valid_namespace, DECODE_CONCURRENCY, HELM_SELECTOR,
    LIST_TIMEOUT,
};
use crate::kubernetes::client::{api_error, client_with_context, SerializableKubeError};

/// One object of a manifest.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ManifestObject {
    pub api_version: String,
    pub kind: String,
    pub name: String,
}

/// The latest revision of a release and the objects it renders (hooks too).
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseApis {
    pub name: String,
    pub namespace: String,
    pub revision: u32,
    pub chart: String,
    pub chart_version: String,
    pub app_version: String,
    pub objects: Vec<ManifestObject>,
    /// Why the release couldn't be read.
    pub error: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
struct RawChartMeta {
    #[serde(default)]
    name: String,
    #[serde(default)]
    version: String,
    #[serde(default, rename = "appVersion")]
    app_version: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
struct RawChart {
    #[serde(default)]
    metadata: Option<RawChartMeta>,
}

#[derive(Debug, Default, Deserialize)]
struct RawHook {
    #[serde(default)]
    manifest: String,
}

/// What this check needs of a release: chart metadata and the rendered YAML.
#[derive(Debug, Default, Deserialize)]
struct RawManifest {
    #[serde(default)]
    chart: Option<RawChart>,
    #[serde(default)]
    manifest: Option<String>,
    #[serde(default)]
    hooks: Vec<RawHook>,
}

fn unquote(value: &str) -> String {
    let value = value.trim();
    let value = value.split(" #").next().unwrap_or(value).trim();
    value.trim_matches(|c| c == '"' || c == '\'').to_string()
}

/// The objects of a rendered manifest: the top-level `apiVersion` and `kind`
/// of every document and its `metadata.name`. Helm renders block YAML with
/// top-level keys at column 0, so a line scan is enough (and much cheaper
/// than parsing megabytes of CRDs and dashboards).
pub fn manifest_objects(manifest: &str) -> Vec<ManifestObject> {
    let mut objects = Vec::new();
    let mut flush = |api_version: &mut Option<String>, kind: &mut Option<String>, name: &mut Option<String>| {
        if let (Some(api_version), Some(kind)) = (api_version.take(), kind.take()) {
            objects.push(ManifestObject { api_version, kind, name: name.take().unwrap_or_default() });
        }
        *name = None;
    };
    let (mut api_version, mut kind, mut name) = (None, None, None);
    let mut in_metadata = false;
    let mut child_indent: Option<usize> = None;
    for line in manifest.lines() {
        if line.starts_with("---") {
            flush(&mut api_version, &mut kind, &mut name);
            in_metadata = false;
            continue;
        }
        if line.trim().is_empty() || line.trim_start().starts_with('#') {
            continue;
        }
        let indent = line.len() - line.trim_start().len();
        if indent == 0 {
            in_metadata = false;
            if let Some(value) = line.strip_prefix("apiVersion:") {
                api_version = Some(unquote(value));
            } else if let Some(value) = line.strip_prefix("kind:") {
                kind = Some(unquote(value));
            } else if line.trim_end() == "metadata:" {
                in_metadata = true;
                child_indent = None;
            }
            continue;
        }
        if in_metadata && name.is_none() {
            let indent_of_children = *child_indent.get_or_insert(indent);
            if indent == indent_of_children {
                if let Some(value) = line.trim_start().strip_prefix("name:") {
                    name = Some(unquote(value));
                }
            }
        }
    }
    flush(&mut api_version, &mut kind, &mut name);
    objects
}

fn objects_of(raw: &RawManifest) -> Vec<ManifestObject> {
    let mut objects = manifest_objects(raw.manifest.as_deref().unwrap_or_default());
    for hook in &raw.hooks {
        objects.extend(manifest_objects(&hook.manifest));
    }
    objects.sort_by(|a, b| (&a.kind, &a.name, &a.api_version).cmp(&(&b.kind, &b.name, &b.api_version)));
    objects.dedup();
    objects
}

/// The objects every release in `namespaces` (`["all"]` or empty: every
/// namespace) renders in its latest revision.
#[tauri::command]
pub async fn helm_manifest_apis(
    context: &str,
    kube_config: Option<String>,
    namespaces: Vec<String>,
) -> Result<Vec<ReleaseApis>, SerializableKubeError> {
    if let Some(bad) = namespaces.iter().find(|n| *n != "all" && !valid_namespace(n)) {
        return Err(bad_request(format!("'{bad}' is not a namespace")));
    }
    let client = client_with_context(context, kube_config.as_deref()).await?;
    let work = async {
        let stored = list_stored(&client, &namespaces, HELM_SELECTOR)
            .await
            .map_err(|e| api_error(e, kube_config.as_deref(), context))?;
        let mut releases: Vec<ReleaseApis> = futures::stream::iter(latest_revisions(stored))
            .map(|stored| {
                let client = &client;
                async move {
                    let mut release = ReleaseApis {
                        name: stored.release.clone(),
                        namespace: stored.namespace.clone(),
                        revision: stored.revision,
                        chart: String::new(),
                        chart_version: String::new(),
                        app_version: String::new(),
                        objects: Vec::new(),
                        error: None,
                    };
                    let decoded = match read_encoded(client, &stored).await {
                        Ok(encoded) => tauri::async_runtime::spawn_blocking(move || {
                            decode_release::<RawManifest>(&encoded).map(|raw| (objects_of(&raw), raw.chart))
                        })
                        .await
                        .map_err(|e| e.to_string())
                        .and_then(|result| result),
                        Err(e) => Err(e.to_string()),
                    };
                    match decoded {
                        Ok((objects, chart)) => {
                            let meta = chart.and_then(|c| c.metadata).unwrap_or_default();
                            release.chart = meta.name;
                            release.chart_version = meta.version;
                            release.app_version = meta.app_version.unwrap_or_default();
                            release.objects = objects;
                        }
                        Err(e) => {
                            warn!("Unable to read helm release {}/{}: {}", stored.namespace, stored.object, e);
                            release.error = Some(e);
                        }
                    }
                    release
                }
            })
            .buffer_unordered(DECODE_CONCURRENCY)
            .collect()
            .await;
        releases.sort_by(|a, b| a.namespace.cmp(&b.namespace).then_with(|| a.name.cmp(&b.name)));
        Ok(releases)
    };
    tokio::time::timeout(LIST_TIMEOUT, work).await.map_err(|_| timeout_error("the Helm releases"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::helm::storage::tests::{helm_encode, FIXTURE};

    fn object(api_version: &str, kind: &str, name: &str) -> ManifestObject {
        ManifestObject { api_version: api_version.into(), kind: kind.into(), name: name.into() }
    }

    #[test]
    fn scans_documents_of_a_manifest() {
        let manifest = "---\n# Source: x/templates/pdb.yaml\napiVersion: policy/v1beta1\nkind: PodDisruptionBudget\nmetadata:\n  labels:\n    name: not-this\n  name: \"web\"\n  namespace: shop\nspec:\n  maxUnavailable: 1\n---\n# Source: x/templates/empty.yaml\n---\napiVersion: 'flowcontrol.apiserver.k8s.io/v1beta3' # old\nkind: FlowSchema\nmetadata:\n    name: karpenter-leader-election\nspec:\n  matchingPrecedence: 200\n";
        assert_eq!(
            manifest_objects(manifest),
            vec![
                object("policy/v1beta1", "PodDisruptionBudget", "web"),
                object("flowcontrol.apiserver.k8s.io/v1beta3", "FlowSchema", "karpenter-leader-election"),
            ]
        );
    }

    #[test]
    fn nested_api_versions_are_not_objects() {
        let manifest = "apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: api\nspec:\n  template:\n    metadata:\n      name: inner\n    spec:\n      containers:\n        - name: api\n          env:\n            - name: apiVersion\n              value: \"v9\"\n";
        assert_eq!(manifest_objects(manifest), vec![object("apps/v1", "Deployment", "api")]);
    }

    #[test]
    fn a_stored_release_lists_its_manifest_and_hooks() {
        let raw: RawManifest = decode_release(&helm_encode(FIXTURE)).unwrap();
        let objects = objects_of(&raw);
        assert!(objects.contains(&object("apps/v1", "Deployment", "payments-api")));
        assert!(objects.contains(&object("v1", "Pod", "payments-api-test-connection")));
        let meta = raw.chart.and_then(|c| c.metadata).unwrap();
        assert_eq!(meta.name, "payments-api");
        assert_eq!(meta.app_version.as_deref(), Some("2.14.3"));
    }
}

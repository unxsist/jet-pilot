//! Helm's release storage, read natively.
//!
//! Helm 3 keeps every revision of a release in one object of its storage
//! driver: a Secret of type `helm.sh/release.v1` (the default) or a
//! ConfigMap, labelled `owner=helm`, `name=<release>`, `version=<revision>`
//! and `status=<status>`. The `release` key holds the release JSON, gzipped
//! and base64-encoded by helm (Secrets base64-encode that once more, which
//! the API client already decodes).
//!
//! The labels are enough to find the latest revision of every release, so
//! lists read metadata only and decode one object per release. Decoding
//! streams through gzip into structs that only name the fields needed:
//! templates and chart files are skipped, never held as values.

use std::io::Read;

use base64::Engine;
use chrono::{DateTime, SecondsFormat};
use flate2::read::GzDecoder;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Gzip magic of helm's compressed releases.
const GZIP_MAGIC: [u8; 3] = [0x1f, 0x8b, 0x08];
/// Bound for one decompressed release (a release object is at most 1 MiB
/// compressed; manifests compress well, but not 64 times).
const MAX_RELEASE_BYTES: u64 = 64 * 1024 * 1024;

pub const OWNER_LABEL: &str = "owner";
pub const NAME_LABEL: &str = "name";
pub const VERSION_LABEL: &str = "version";
pub const STATUS_LABEL: &str = "status";

/// Decodes helm's encoding of a release (base64, then gzip when compressed)
/// into `T`.
pub fn decode_release<T: DeserializeOwned>(encoded: &[u8]) -> Result<T, String> {
    let trimmed: Vec<u8> = encoded.iter().copied().filter(|b| !b.is_ascii_whitespace()).collect();
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(&trimmed)
        .map_err(|e| format!("The release is not base64-encoded: {e}"))?;
    let result = if bytes.starts_with(&GZIP_MAGIC) {
        serde_json::from_reader(GzDecoder::new(bytes.as_slice()).take(MAX_RELEASE_BYTES))
    } else {
        serde_json::from_slice(&bytes)
    };
    result.map_err(|e| format!("Unable to read the release: {e}"))
}

/* ------------------------------------------------------------ raw shape -- */

#[derive(Debug, Default, Deserialize)]
pub struct RawInfo {
    #[serde(default)]
    pub first_deployed: Option<String>,
    #[serde(default)]
    pub last_deployed: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default)]
    pub notes: Option<String>,
}

#[derive(Debug, Default, Deserialize, Serialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Maintainer {
    #[serde(default)]
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
}

/// Chart.yaml as stored in a release.
#[derive(Debug, Default, Deserialize, Serialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ChartMetadata {
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub version: String,
    #[serde(default)]
    pub app_version: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub home: Option<String>,
    #[serde(default)]
    pub sources: Vec<String>,
    #[serde(default)]
    pub icon: Option<String>,
    #[serde(default)]
    pub keywords: Vec<String>,
    #[serde(default)]
    pub maintainers: Vec<Maintainer>,
    #[serde(default)]
    pub kube_version: Option<String>,
    #[serde(default)]
    pub deprecated: bool,
    #[serde(default, rename = "type")]
    pub chart_type: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
struct RawChartSummary {
    #[serde(default)]
    metadata: Option<ChartMetadata>,
}

#[derive(Debug, Default, Deserialize)]
struct RawChart {
    #[serde(default)]
    metadata: Option<ChartMetadata>,
    #[serde(default)]
    values: Option<Value>,
    /// values.schema.json, base64 (Go []byte).
    #[serde(default)]
    schema: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
struct RawLastRun {
    #[serde(default)]
    started_at: Option<String>,
    #[serde(default)]
    completed_at: Option<String>,
    #[serde(default)]
    phase: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
struct RawHook {
    #[serde(default)]
    name: String,
    #[serde(default)]
    kind: String,
    #[serde(default)]
    path: String,
    #[serde(default)]
    manifest: String,
    #[serde(default)]
    events: Vec<String>,
    #[serde(default)]
    last_run: Option<RawLastRun>,
    #[serde(default)]
    weight: i64,
}

/// What a list needs of a release.
#[derive(Debug, Default, Deserialize)]
pub struct RawReleaseSummary {
    #[serde(default)]
    name: String,
    #[serde(default)]
    namespace: String,
    #[serde(default)]
    version: u32,
    #[serde(default)]
    info: Option<RawInfo>,
    #[serde(default)]
    chart: Option<RawChartSummary>,
}

/// A history entry: the summary plus the user-supplied values (so the
/// timeline can say what changed between revisions).
#[derive(Debug, Default, Deserialize)]
pub struct RawRevision {
    #[serde(default)]
    version: u32,
    #[serde(default)]
    info: Option<RawInfo>,
    #[serde(default)]
    chart: Option<RawChartSummary>,
    #[serde(default)]
    config: Option<Value>,
}

#[derive(Debug, Default, Deserialize)]
pub struct RawRelease {
    #[serde(default)]
    name: String,
    #[serde(default)]
    namespace: String,
    #[serde(default)]
    version: u32,
    #[serde(default)]
    info: Option<RawInfo>,
    #[serde(default)]
    chart: Option<RawChart>,
    #[serde(default)]
    config: Option<Value>,
    #[serde(default)]
    manifest: Option<String>,
    #[serde(default)]
    hooks: Vec<RawHook>,
}

/* ---------------------------------------------------------- front end -- */

/// One release (its latest revision) in the releases list.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HelmRelease {
    pub name: String,
    pub namespace: String,
    pub revision: u32,
    pub status: String,
    /// Chart name.
    pub chart: String,
    pub chart_version: String,
    pub app_version: String,
    /// RFC 3339 (milliseconds) of the last deployment.
    pub updated: Option<String>,
    pub description: String,
    pub icon: Option<String>,
    /// "secret" or "configmap".
    pub storage: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HelmRevision {
    pub revision: u32,
    pub status: String,
    pub chart: String,
    pub chart_version: String,
    pub app_version: String,
    pub updated: Option<String>,
    pub description: String,
    /// User-supplied values of the revision.
    pub values: Value,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HelmHook {
    pub name: String,
    pub kind: String,
    pub path: String,
    pub events: Vec<String>,
    pub weight: i64,
    pub manifest: String,
    /// Phase of the last run: Running, Succeeded, Failed (empty: never ran).
    pub phase: String,
    pub started_at: Option<String>,
    pub completed_at: Option<String>,
}

/// Everything about one revision.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HelmReleaseDetail {
    pub name: String,
    pub namespace: String,
    pub revision: u32,
    pub status: String,
    pub updated: Option<String>,
    pub first_deployed: Option<String>,
    pub description: String,
    pub notes: String,
    pub chart: ChartMetadata,
    /// User-supplied values.
    pub values: Value,
    /// The chart's defaults with the user-supplied values on top
    /// (`helm get values --all`).
    pub computed_values: Value,
    pub values_schema: Option<Value>,
    pub manifest: String,
    pub hooks: Vec<HelmHook>,
}

/// Go timestamps (nanoseconds, any offset) as RFC 3339 UTC with
/// milliseconds, which every JS engine parses. Unparseable: as is.
pub fn normalize_time(value: Option<String>) -> Option<String> {
    let value = value.filter(|v| !v.is_empty() && !v.starts_with("0001-01-01"))?;
    Some(
        DateTime::parse_from_rfc3339(&value)
            .map(|t| t.with_timezone(&chrono::Utc).to_rfc3339_opts(SecondsFormat::Millis, true))
            .unwrap_or(value),
    )
}

fn empty_object() -> Value {
    Value::Object(Default::default())
}

/// `null` values (helm stores `{}` or nothing for "no values") as `{}`.
fn values_or_empty(value: Option<Value>) -> Value {
    match value {
        Some(Value::Object(map)) => Value::Object(map),
        _ => empty_object(),
    }
}

/// Helm's coalescing of values: `overrides` on top of `defaults`, maps
/// merged key by key, anything else replaced; a `null` override removes
/// the default.
pub fn coalesce(defaults: &Value, overrides: &Value) -> Value {
    match (defaults, overrides) {
        (Value::Object(base), Value::Object(top)) => {
            let mut merged = base.clone();
            for (key, value) in top {
                if value.is_null() {
                    merged.remove(key);
                    continue;
                }
                let next = match merged.get(key) {
                    Some(existing) => coalesce(existing, value),
                    None => value.clone(),
                };
                merged.insert(key.clone(), next);
            }
            Value::Object(merged)
        }
        (_, top) => top.clone(),
    }
}

fn info_status(info: &Option<RawInfo>, fallback: &str) -> String {
    info.as_ref()
        .and_then(|i| i.status.clone())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| fallback.to_string())
}

impl RawReleaseSummary {
    pub fn into_release(self, storage: &str, status_label: &str) -> HelmRelease {
        let metadata = self.chart.and_then(|c| c.metadata).unwrap_or_default();
        let status = info_status(&self.info, status_label);
        let info = self.info.unwrap_or_default();
        HelmRelease {
            name: self.name,
            namespace: self.namespace,
            revision: self.version,
            status,
            chart: metadata.name,
            chart_version: metadata.version,
            app_version: metadata.app_version.unwrap_or_default(),
            updated: normalize_time(info.last_deployed),
            description: info.description.unwrap_or_default(),
            icon: metadata.icon.filter(|i| !i.is_empty()),
            storage: storage.to_string(),
        }
    }
}

impl RawRevision {
    pub fn into_revision(self) -> HelmRevision {
        let metadata = self.chart.and_then(|c| c.metadata).unwrap_or_default();
        let status = info_status(&self.info, "unknown");
        let info = self.info.unwrap_or_default();
        HelmRevision {
            revision: self.version,
            status,
            chart: metadata.name,
            chart_version: metadata.version,
            app_version: metadata.app_version.unwrap_or_default(),
            updated: normalize_time(info.last_deployed),
            description: info.description.unwrap_or_default(),
            values: values_or_empty(self.config),
        }
    }
}

impl RawRelease {
    pub fn into_detail(self) -> HelmReleaseDetail {
        let chart = self.chart.unwrap_or_default();
        let values = values_or_empty(self.config);
        let defaults = values_or_empty(chart.values);
        let computed_values = coalesce(&defaults, &values);
        let values_schema = chart
            .schema
            .and_then(|s| base64::engine::general_purpose::STANDARD.decode(s.trim()).ok())
            .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
            .filter(Value::is_object);
        let status = info_status(&self.info, "unknown");
        let info = self.info.unwrap_or_default();
        let mut hooks: Vec<HelmHook> = self
            .hooks
            .into_iter()
            .map(|hook| {
                let run = hook.last_run.unwrap_or_default();
                HelmHook {
                    name: hook.name,
                    kind: hook.kind,
                    path: hook.path,
                    events: hook.events,
                    weight: hook.weight,
                    manifest: hook.manifest,
                    phase: run.phase.unwrap_or_default(),
                    started_at: normalize_time(run.started_at),
                    completed_at: normalize_time(run.completed_at),
                }
            })
            .collect();
        hooks.sort_by(|a, b| a.weight.cmp(&b.weight).then_with(|| a.name.cmp(&b.name)));
        HelmReleaseDetail {
            name: self.name,
            namespace: self.namespace,
            revision: self.version,
            status,
            updated: normalize_time(info.last_deployed),
            first_deployed: normalize_time(info.first_deployed),
            description: info.description.unwrap_or_default(),
            notes: info.notes.unwrap_or_default(),
            chart: chart.metadata.unwrap_or_default(),
            values,
            computed_values,
            values_schema,
            manifest: self.manifest.unwrap_or_default(),
            hooks,
        }
    }
}

/// Labels of one storage object, as far as listing needs them.
#[derive(Debug, Clone, PartialEq)]
pub struct StoredRevision {
    pub namespace: String,
    pub release: String,
    pub revision: u32,
    pub status: String,
    /// The storage object.
    pub object: String,
    pub uid: String,
    pub resource_version: String,
    pub storage: &'static str,
}

impl StoredRevision {
    /// From an object's metadata; None when it isn't a helm release object.
    pub fn from_meta(
        meta: &kube::api::ObjectMeta,
        storage: &'static str,
    ) -> Option<StoredRevision> {
        let labels = meta.labels.as_ref()?;
        if labels.get(OWNER_LABEL).map(String::as_str) != Some("helm") {
            return None;
        }
        Some(StoredRevision {
            namespace: meta.namespace.clone().unwrap_or_default(),
            release: labels.get(NAME_LABEL)?.clone(),
            revision: labels.get(VERSION_LABEL)?.parse().ok()?,
            status: labels.get(STATUS_LABEL).cloned().unwrap_or_default(),
            object: meta.name.clone()?,
            uid: meta.uid.clone().unwrap_or_default(),
            resource_version: meta.resource_version.clone().unwrap_or_default(),
            storage,
        })
    }
}

/// The latest revision of every release, without uninstalled releases
/// (`helm uninstall --keep-history`), sorted by namespace and name.
pub fn latest_revisions(objects: Vec<StoredRevision>) -> Vec<StoredRevision> {
    let mut latest: std::collections::BTreeMap<(String, String), StoredRevision> = Default::default();
    for object in objects {
        let key = (object.namespace.clone(), object.release.clone());
        match latest.get(&key) {
            Some(existing) if existing.revision >= object.revision => {}
            _ => {
                latest.insert(key, object);
            }
        }
    }
    latest.into_values().filter(|o| o.status != "uninstalled").collect()
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use flate2::write::GzEncoder;
    use flate2::Compression;
    use std::io::Write;

    /// A release as helm 3 stores it (trimmed: one template, one file).
    pub(crate) const FIXTURE: &str = include_str!("fixtures/release.json");

    /// Encodes like helm's storage driver: gzip, then base64.
    pub(crate) fn helm_encode(json: &str) -> Vec<u8> {
        let mut gz = GzEncoder::new(Vec::new(), Compression::default());
        gz.write_all(json.as_bytes()).unwrap();
        let compressed = gz.finish().unwrap();
        base64::engine::general_purpose::STANDARD.encode(compressed).into_bytes()
    }

    #[test]
    fn decodes_a_compressed_release_summary() {
        let summary: RawReleaseSummary = decode_release(&helm_encode(FIXTURE)).unwrap();
        let release = summary.into_release("secret", "deployed");
        assert_eq!(release.name, "payments-api");
        assert_eq!(release.namespace, "payments");
        assert_eq!(release.revision, 42);
        assert_eq!(release.status, "deployed");
        assert_eq!(release.chart, "payments-api");
        assert_eq!(release.chart_version, "2.14.3");
        assert_eq!(release.app_version, "2.14.3");
        assert_eq!(release.updated.as_deref(), Some("2026-10-12T08:15:30.123Z"));
        assert_eq!(release.description, "Upgrade complete");
        assert_eq!(release.icon.as_deref(), Some("https://acme.dev/payments.svg"));
    }

    #[test]
    fn decodes_uncompressed_releases_and_whitespace() {
        let mut encoded = base64::engine::general_purpose::STANDARD.encode(FIXTURE).into_bytes();
        encoded.insert(10, b'\n');
        let summary: RawReleaseSummary = decode_release(&encoded).unwrap();
        assert_eq!(summary.name, "payments-api");
    }

    #[test]
    fn rejects_garbage() {
        assert!(decode_release::<RawReleaseSummary>(b"not base64 !!").is_err());
        let truncated = &helm_encode(FIXTURE)[..40];
        assert!(decode_release::<RawReleaseSummary>(truncated).is_err());
    }

    #[test]
    fn details_carry_values_notes_manifest_and_hooks() {
        let raw: RawRelease = decode_release(&helm_encode(FIXTURE)).unwrap();
        let detail = raw.into_detail();
        assert_eq!(detail.chart.home.as_deref(), Some("https://github.com/acme/payments-api"));
        assert_eq!(detail.chart.sources, vec!["https://github.com/acme/charts".to_string()]);
        assert_eq!(detail.chart.maintainers[0].name, "Platform team");
        assert!(detail.notes.contains("kubectl get pods"));
        assert!(detail.manifest.contains("kind: Deployment"));
        assert_eq!(detail.first_deployed.as_deref(), Some("2026-01-03T09:00:00.000Z"));
        // user values
        assert_eq!(detail.values["image"]["tag"], "v2.14.3");
        assert!(detail.values.get("resources").is_none());
        // computed: defaults with the user values on top; null removes
        assert_eq!(detail.computed_values["image"]["tag"], "v2.14.3");
        assert_eq!(detail.computed_values["image"]["repository"], "ghcr.io/acme/payments-api");
        assert_eq!(detail.computed_values["replicaCount"], 4);
        assert!(detail.computed_values.get("podAnnotations").is_none());
        assert_eq!(detail.computed_values["resources"]["requests"]["cpu"], "250m");
        // schema decoded from base64
        assert_eq!(detail.values_schema.as_ref().unwrap()["type"], "object");
        // hooks by weight
        assert_eq!(detail.hooks.len(), 2);
        assert_eq!(detail.hooks[0].name, "payments-api-migrate");
        assert_eq!(detail.hooks[0].phase, "Succeeded");
        assert_eq!(detail.hooks[1].events, vec!["test".to_string()]);
    }

    #[test]
    fn revisions_keep_the_user_values() {
        let raw: RawRevision = decode_release(&helm_encode(FIXTURE)).unwrap();
        let revision = raw.into_revision();
        assert_eq!(revision.revision, 42);
        assert_eq!(revision.values["replicaCount"], 4);
    }

    #[test]
    fn coalesce_merges_maps_and_drops_nulls() {
        let defaults = serde_json::json!({ "a": { "b": 1, "c": 2 }, "d": [1, 2], "e": "x" });
        let overrides = serde_json::json!({ "a": { "c": 3, "f": 4 }, "d": [9], "e": null, "g": true });
        assert_eq!(
            coalesce(&defaults, &overrides),
            serde_json::json!({ "a": { "b": 1, "c": 3, "f": 4 }, "d": [9], "g": true })
        );
    }

    #[test]
    fn go_timestamps_are_normalized() {
        assert_eq!(
            normalize_time(Some("2026-10-12T10:15:30.123456789+02:00".into())).as_deref(),
            Some("2026-10-12T08:15:30.123Z")
        );
        assert_eq!(normalize_time(Some("0001-01-01T00:00:00Z".into())), None);
        assert_eq!(normalize_time(Some("".into())), None);
        assert_eq!(normalize_time(Some("yesterday".into())).as_deref(), Some("yesterday"));
    }

    fn stored(namespace: &str, release: &str, revision: u32, status: &str) -> StoredRevision {
        StoredRevision {
            namespace: namespace.into(),
            release: release.into(),
            revision,
            status: status.into(),
            object: format!("sh.helm.release.v1.{release}.v{revision}"),
            uid: format!("{release}-{revision}"),
            resource_version: "1".into(),
            storage: "secret",
        }
    }

    #[test]
    fn latest_revision_per_release() {
        let latest = latest_revisions(vec![
            stored("a", "web", 1, "superseded"),
            stored("a", "web", 3, "failed"),
            stored("a", "web", 2, "superseded"),
            stored("b", "web", 1, "deployed"),
            stored("a", "gone", 2, "uninstalled"),
            stored("a", "api", 7, "pending-upgrade"),
        ]);
        let names: Vec<_> = latest.iter().map(|o| (o.namespace.as_str(), o.release.as_str(), o.revision)).collect();
        assert_eq!(names, vec![("a", "api", 7), ("a", "web", 3), ("b", "web", 1)]);
    }

    #[test]
    fn storage_labels_are_read() {
        let mut meta = kube::api::ObjectMeta {
            name: Some("sh.helm.release.v1.web.v3".into()),
            namespace: Some("apps".into()),
            uid: Some("u1".into()),
            resource_version: Some("77".into()),
            ..Default::default()
        };
        meta.labels = Some(
            [("owner", "helm"), ("name", "web"), ("version", "3"), ("status", "deployed")]
                .into_iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect(),
        );
        let stored = StoredRevision::from_meta(&meta, "secret").unwrap();
        assert_eq!(stored.release, "web");
        assert_eq!(stored.revision, 3);
        assert_eq!(stored.object, "sh.helm.release.v1.web.v3");

        meta.labels.as_mut().unwrap().insert("owner".into(), "someone".into());
        assert!(StoredRevision::from_meta(&meta, "secret").is_none());
    }
}

//! Cluster OpenAPI v3 schemas for the YAML editor.
//!
//! The editor validates and completes manifests against the schemas the API
//! server itself publishes (`/openapi/v3`), so CRDs get the same treatment as
//! built-in kinds. Requests go through the cached kube client (no kubectl
//! spawn, no repeated exec-plugin runs) and responses are cached in memory:
//!
//! - the discovery index (`/openapi/v3`) per (kubeconfig, context), for a few
//!   minutes so new CRDs show up;
//! - group-version documents per (kubeconfig, context, server URL). The URL
//!   carries the server's content hash (`?hash=...`), so an entry never goes
//!   stale: a changed schema gets a new URL.
//!
//! Documents are returned as raw JSON bytes (`ipc::Response`) so a multi-MB
//! schema is not escaped into a JSON string and parsed twice.

use crate::kubernetes::client::{client_with_context, SerializableKubeError};
use crate::util::lock;
use once_cell::sync::Lazy;
use serde::Serialize;
use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::http::Request;
use tracing::debug;

const INDEX_TTL: Duration = Duration::from_secs(5 * 60);
/// Group-version documents kept in memory (a core/v1 document is ~1-2 MB).
const MAX_CACHED_DOCUMENTS: usize = 24;

type ContextKey = (String, String);

static INDEXES: Lazy<Mutex<HashMap<ContextKey, (Instant, Arc<HashMap<String, String>>)>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

#[derive(Default)]
struct DocumentCache {
    order: VecDeque<(ContextKey, String)>,
    documents: HashMap<(ContextKey, String), Arc<Vec<u8>>>,
}

impl DocumentCache {
    fn get(&self, key: &(ContextKey, String)) -> Option<Arc<Vec<u8>>> {
        self.documents.get(key).cloned()
    }

    fn insert(&mut self, key: (ContextKey, String), document: Arc<Vec<u8>>, capacity: usize) {
        if self.documents.insert(key.clone(), document).is_none() {
            self.order.push_back(key);
        }
        while self.order.len() > capacity {
            if let Some(oldest) = self.order.pop_front() {
                self.documents.remove(&oldest);
            }
        }
    }
}

static DOCUMENTS: Lazy<Mutex<DocumentCache>> = Lazy::new(|| Mutex::new(DocumentCache::default()));

/// Same shape as `SerializableKubeError` (the frontend reads `message` and
/// `reason`), constructible here.
#[derive(Debug, Serialize)]
pub struct SchemaError {
    message: String,
    code: Option<u16>,
    reason: Option<String>,
}

impl From<SerializableKubeError> for SchemaError {
    fn from(error: SerializableKubeError) -> Self {
        let value = serde_json::to_value(&error).unwrap_or_default();
        SchemaError {
            message: value["message"].as_str().unwrap_or("Kubernetes API error").to_string(),
            code: value["code"].as_u64().and_then(|c| u16::try_from(c).ok()),
            reason: value["reason"].as_str().map(str::to_string),
        }
    }
}

fn error(message: impl Into<String>, reason: &str) -> SchemaError {
    SchemaError { message: message.into(), code: None, reason: Some(reason.to_string()) }
}

/// The OpenAPI v3 discovery path of a manifest `apiVersion`: core kinds live
/// under `api/v1`, everything else under `apis/<group>/<version>`.
pub(crate) fn openapi_path(api_version: &str) -> Option<String> {
    let api_version = api_version.trim();
    match api_version.split_once('/') {
        None if !api_version.is_empty() => Some(format!("api/{}", api_version)),
        Some((group, version))
            if !group.is_empty() && !version.is_empty() && !version.contains('/') =>
        {
            Some(format!("apis/{}/{}", group, version))
        }
        _ => None,
    }
}

/// Parses the `/openapi/v3` discovery document into path -> server URL.
pub(crate) fn parse_index(body: &str) -> Result<HashMap<String, String>, String> {
    let value: serde_json::Value = serde_json::from_str(body).map_err(|e| e.to_string())?;
    let paths = value
        .get("paths")
        .and_then(|p| p.as_object())
        .ok_or_else(|| "The OpenAPI v3 index has no paths".to_string())?;

    Ok(paths
        .iter()
        .filter_map(|(path, entry)| {
            let url = entry.get("serverRelativeURL")?.as_str()?;
            // Only ever follow URLs inside the OpenAPI tree.
            url.starts_with("/openapi/v3/")
                .then(|| (path.clone(), url.to_string()))
        })
        .collect())
}

async fn get_text(client: &kube::Client, url: &str) -> Result<String, SchemaError> {
    let request = Request::get(url)
        .header("Accept", "application/json")
        .body(Vec::new())
        .map_err(|e| error(e.to_string(), "BadRequest"))?;
    client
        .request_text(request)
        .await
        .map_err(|e| SchemaError::from(SerializableKubeError::from(e)))
}

async fn index_for(
    client: &kube::Client,
    key: &ContextKey,
) -> Result<Arc<HashMap<String, String>>, SchemaError> {
    if let Some((fetched, index)) = lock(&INDEXES).get(key) {
        if fetched.elapsed() < INDEX_TTL {
            return Ok(index.clone());
        }
    }

    let body = get_text(client, "/openapi/v3").await?;
    let index = Arc::new(parse_index(&body).map_err(|e| error(e, "InvalidIndex"))?);
    lock(&INDEXES).insert(key.clone(), (Instant::now(), index.clone()));
    Ok(index)
}

/// Returns the OpenAPI v3 document (raw JSON) describing `api_version`
/// (e.g. `v1`, `apps/v1`, `cert-manager.io/v1`) on the cluster of `context`.
#[tauri::command]
pub async fn get_openapi_v3_schema(
    context: &str,
    kube_config: Option<String>,
    api_version: &str,
) -> Result<tauri::ipc::Response, SchemaError> {
    let path = openapi_path(api_version)
        .ok_or_else(|| error(format!("Invalid apiVersion '{}'", api_version), "BadRequest"))?;
    let key: ContextKey = (kube_config.clone().unwrap_or_default(), context.to_string());

    let client = client_with_context(context, kube_config.as_deref()).await?;
    let index = index_for(&client, &key).await?;
    let url = index.get(&path).cloned().ok_or_else(|| {
        error(
            format!("The cluster publishes no OpenAPI v3 schema for {}", api_version),
            "NotFound",
        )
    })?;

    let cache_key = (key, url.clone());
    if let Some(document) = lock(&DOCUMENTS).get(&cache_key) {
        return Ok(tauri::ipc::Response::new(document.as_ref().clone()));
    }

    debug!("Fetching OpenAPI v3 schema for {}", api_version);
    let document = Arc::new(get_text(&client, &url).await?.into_bytes());
    lock(&DOCUMENTS).insert(cache_key, document.clone(), MAX_CACHED_DOCUMENTS);
    Ok(tauri::ipc::Response::new(document.as_ref().clone()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn api_versions_map_to_openapi_paths() {
        assert_eq!(openapi_path("v1").as_deref(), Some("api/v1"));
        assert_eq!(openapi_path("apps/v1").as_deref(), Some("apis/apps/v1"));
        assert_eq!(
            openapi_path("cert-manager.io/v1").as_deref(),
            Some("apis/cert-manager.io/v1")
        );
        assert_eq!(openapi_path(""), None);
        assert_eq!(openapi_path("/v1"), None);
        assert_eq!(openapi_path("a/b/c"), None);
    }

    #[test]
    fn index_keeps_only_openapi_urls() {
        let index = parse_index(
            r#"{"paths":{
                "api/v1":{"serverRelativeURL":"/openapi/v3/api/v1?hash=AB"},
                "apis/apps/v1":{"serverRelativeURL":"/openapi/v3/apis/apps/v1?hash=CD"},
                "evil":{"serverRelativeURL":"/api/v1/secrets"},
                "broken":{}
            }}"#,
        )
        .unwrap();
        assert_eq!(index.len(), 2);
        assert_eq!(index["api/v1"], "/openapi/v3/api/v1?hash=AB");
        assert!(parse_index("{}").is_err());
    }

    #[test]
    fn document_cache_evicts_oldest() {
        let mut cache = DocumentCache::default();
        let key = |n: &str| (("kc".to_string(), "ctx".to_string()), n.to_string());
        cache.insert(key("a"), Arc::new(vec![1]), 2);
        cache.insert(key("b"), Arc::new(vec![2]), 2);
        cache.insert(key("a"), Arc::new(vec![3]), 2);
        cache.insert(key("c"), Arc::new(vec![4]), 2);
        assert!(cache.get(&key("a")).is_none());
        assert_eq!(cache.get(&key("b")).unwrap().as_slice(), &[2]);
        assert_eq!(cache.get(&key("c")).unwrap().as_slice(), &[4]);
    }

    #[test]
    fn errors_serialize_like_kube_errors() {
        let value = serde_json::to_value(error("nope", "NotFound")).unwrap();
        assert_eq!(value["message"], "nope");
        assert_eq!(value["reason"], "NotFound");
    }
}

//! Raw requests to the Kubernetes API of a context.
//!
//! The front end's way to reach any API path through the cached kube client
//! (same credentials, broker and auth reporting as every other command):
//! reading custom resources, merge/JSON patches (GitOps reconcile, labels,
//! taints), access reviews, and the API server's service proxy (Prometheus
//! queries without a port-forward).
//!
//! Only paths on the API server are accepted (no scheme or host), and the
//! response body is returned as raw bytes (`ipc::Response`) so large lists
//! are not escaped into a JSON string first.

use crate::kubernetes::client::{client_with_context, resolve_kubeconfig_path, with_auth_context, SerializableKubeError};
use serde::Deserialize;
use std::time::Duration;
use tauri::http::{Method, Request};
use tracing::debug;

/// Longest a single request may take (a slow Prometheus range query
/// included); the front end shows its own error after this.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(60);

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KubeRequest {
    pub method: String,
    /// Absolute API path with query, e.g. `/apis/apps/v1/namespaces/a/deployments`.
    pub path: String,
    /// Request body; sent as JSON.
    pub body: Option<serde_json::Value>,
    /// Content type of the body, e.g. `application/merge-patch+json`.
    /// Defaults to `application/json` (`application/merge-patch+json` for PATCH).
    pub content_type: Option<String>,
    /// Accept header; defaults to `application/json`.
    pub accept: Option<String>,
}

fn bad_request(message: impl Into<String>) -> SerializableKubeError {
    SerializableKubeError {
        message: message.into(),
        code: Some(400),
        reason: Some("BadRequest".into()),
        details: None,
        auth: None,
    }
}

/// Validates the method and path of a request.
pub(crate) fn validate(request: &KubeRequest) -> Result<Method, SerializableKubeError> {
    let method = match request.method.to_ascii_uppercase().as_str() {
        "GET" => Method::GET,
        "POST" => Method::POST,
        "PUT" => Method::PUT,
        "PATCH" => Method::PATCH,
        "DELETE" => Method::DELETE,
        other => return Err(bad_request(format!("Unsupported method '{}'", other))),
    };
    let path = request.path.as_str();
    // A path on the API server: never a URL to another host.
    if !path.starts_with('/') || path.starts_with("//") || path.contains("://") {
        return Err(bad_request(format!("Invalid API path '{}'", path)));
    }
    if path.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err(bad_request("API paths can't contain whitespace"));
    }
    Ok(method)
}

fn content_type(request: &KubeRequest, method: &Method) -> String {
    request.content_type.clone().unwrap_or_else(|| {
        if method == Method::PATCH {
            "application/merge-patch+json".into()
        } else {
            "application/json".into()
        }
    })
}

#[tauri::command]
pub async fn kube_request(
    context: &str,
    kube_config: Option<String>,
    request: KubeRequest,
) -> Result<tauri::ipc::Response, SerializableKubeError> {
    let method = validate(&request)?;
    debug!("{} {} on context {}", method, request.path, context);

    let body = match &request.body {
        Some(value) => serde_json::to_vec(value).map_err(|e| bad_request(e.to_string()))?,
        None => Vec::new(),
    };
    let mut builder = Request::builder()
        .method(method.clone())
        .uri(request.path.as_str())
        .header("Accept", request.accept.as_deref().unwrap_or("application/json"));
    if !body.is_empty() {
        builder = builder.header("Content-Type", content_type(&request, &method));
    }
    let http_request = builder.body(body).map_err(|e| bad_request(e.to_string()))?;

    let client = client_with_context(context, kube_config.as_deref()).await?;
    let text = tokio::time::timeout(REQUEST_TIMEOUT, client.request_text(http_request))
        .await
        .map_err(|_| SerializableKubeError {
            message: format!("The request timed out after {} seconds", REQUEST_TIMEOUT.as_secs()),
            code: Some(504),
            reason: Some("Timeout".into()),
            details: None,
            auth: None,
        })?
        .map_err(|err| {
            with_auth_context(
                SerializableKubeError::from(err),
                &resolve_kubeconfig_path(kube_config.as_deref()),
                context,
            )
        })?;
    Ok(tauri::ipc::Response::new(text.into_bytes()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(method: &str, path: &str) -> KubeRequest {
        KubeRequest { method: method.into(), path: path.into(), body: None, content_type: None, accept: None }
    }

    #[test]
    fn accepts_api_paths() {
        assert_eq!(validate(&request("get", "/api/v1/namespaces")).unwrap(), Method::GET);
        assert_eq!(
            validate(&request("PATCH", "/apis/kustomize.toolkit.fluxcd.io/v1/namespaces/a/kustomizations/b")).unwrap(),
            Method::PATCH
        );
        assert!(validate(&request(
            "GET",
            "/api/v1/namespaces/monitoring/services/http:prometheus:9090/proxy/api/v1/query?query=up"
        ))
        .is_ok());
    }

    #[test]
    fn rejects_other_hosts_and_methods() {
        assert!(validate(&request("GET", "https://example.com/api")).is_err());
        assert!(validate(&request("GET", "//example.com/api")).is_err());
        assert!(validate(&request("GET", "api/v1")).is_err());
        assert!(validate(&request("GET", "/api/v1 x")).is_err());
        assert!(validate(&request("TRACE", "/api/v1")).is_err());
    }

    #[test]
    fn patches_default_to_merge_patch() {
        let r = request("PATCH", "/api/v1/nodes/a");
        assert_eq!(content_type(&r, &Method::PATCH), "application/merge-patch+json");
        assert_eq!(content_type(&r, &Method::POST), "application/json");
    }
}

//! Scaleway (`api.scaleway.com`, `X-Auth-Token: <secret key>`):
//! `GET /k8s/v1/regions/{region}/clusters` (`page`, optional
//! `project_id`), `GET /k8s/v1/regions/{region}/clusters/{id}/kubeconfig`
//! and `GET /account/v3/projects/{id}` for a project's name.

use serde_json::Value;

use super::http::{self, ApiRequest};
use super::{base64_text, path_segment, text, timestamp_ms, CloudContext, CloudError};
use super::{Provider, RemoteCluster};

const PROVIDER: Provider = Provider::Scaleway;
const PAGE_SIZE: usize = 100;
const MAX_PAGES: u64 = 50;

/// Regions with Kapsule.
pub const REGIONS: &[&str] = &["fr-par", "nl-ams", "pl-waw"];

fn region_param(region: &str) -> Result<&str, CloudError> {
    if REGIONS.contains(&region) {
        Ok(region)
    } else {
        Err(CloudError::Invalid(format!(
            "\"{region}\" is not a Scaleway region."
        )))
    }
}

fn request(url: String, key: &str) -> ApiRequest {
    ApiRequest::get(url).header("x-auth-token", key.to_string())
}

fn cluster_of(value: &Value, region: &str) -> Option<RemoteCluster> {
    Some(RemoteCluster {
        id: text(value, "id")?,
        name: text(value, "name")?,
        region: text(value, "region").unwrap_or_else(|| region.to_string()),
        version: text(value, "version"),
        status: text(value, "status"),
        endpoint: text(value, "cluster_url"),
        created_at: timestamp_ms(value.get("created_at")),
        project_id: text(value, "project_id"),
    })
}

/// The clusters of one region (of `project_id`, else every project the key
/// can see). Also validates the key.
pub async fn clusters(
    ctx: &CloudContext,
    key: &str,
    region: &str,
    project_id: Option<&str>,
) -> Result<Vec<RemoteCluster>, CloudError> {
    let origin = ctx.origin(PROVIDER, None);
    let region = region_param(region)?;
    let project = match project_id {
        Some(project) => format!("&project_id={}", path_segment(project)?),
        None => String::new(),
    };
    let mut out = Vec::new();
    let mut page: u64 = 1;
    loop {
        let url = format!(
            "{origin}/k8s/v1/regions/{region}/clusters?page={page}&page_size={PAGE_SIZE}{project}"
        );
        let value = http::json(ctx, PROVIDER, &|| Ok(request(url.clone(), key))).await?;
        let found: Vec<RemoteCluster> = value
            .get("clusters")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|c| cluster_of(c, region))
            .collect();
        let count = found.len();
        out.extend(found);
        let total = value
            .get("total_count")
            .and_then(Value::as_u64)
            .unwrap_or(0) as usize;
        if count < PAGE_SIZE || out.len() >= total || page >= MAX_PAGES {
            return Ok(out);
        }
        page += 1;
    }
}

/// The name of a project (None when the key may not read it).
pub async fn project_name(
    ctx: &CloudContext,
    key: &str,
    project_id: &str,
) -> Result<Option<String>, CloudError> {
    let url = format!(
        "{}/account/v3/projects/{}",
        ctx.origin(PROVIDER, None),
        path_segment(project_id)?
    );
    match http::json(ctx, PROVIDER, &|| Ok(request(url.clone(), key))).await {
        Ok(value) => Ok(text(&value, "name")),
        Err(CloudError::Unauthorized(_)) => Ok(None),
        Err(other) => Err(other),
    }
}

/// The cluster's kubeconfig (YAML).
pub async fn kubeconfig(
    ctx: &CloudContext,
    key: &str,
    region: &str,
    cluster_id: &str,
) -> Result<String, CloudError> {
    let url = format!(
        "{}/k8s/v1/regions/{}/clusters/{}/kubeconfig",
        ctx.origin(PROVIDER, None),
        region_param(region)?,
        path_segment(cluster_id)?
    );
    let response = http::send(ctx, PROVIDER, &|| Ok(request(url.clone(), key)))
        .await?
        .check(PROVIDER)?;
    // A file object ({"content": base64}) or, with `?dl=1`, the YAML.
    match response.json() {
        Ok(value) if value.get("content").is_some() => {
            let data = text(&value, "content")
                .ok_or_else(|| CloudError::Invalid("Scaleway returned no kubeconfig.".into()))?;
            base64_text(&data, "kubeconfig")
        }
        _ => String::from_utf8(response.body)
            .map_err(|_| CloudError::Invalid("Scaleway returned no kubeconfig.".into())),
    }
}

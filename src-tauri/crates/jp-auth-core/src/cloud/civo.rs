//! Civo (`api.civo.com`, bearer API key): `GET /v2/regions` (validates the
//! key), `GET /v2/kubernetes/clusters?region=` per region (`page`) and the
//! cluster's `kubeconfig` field (null until the cluster is ready).

use serde_json::Value;

use super::http::{self, ApiRequest};
use super::{path_segment, text, timestamp_ms, CloudContext, CloudError, Provider, RemoteCluster};

const PROVIDER: Provider = Provider::Civo;
const PER_PAGE: usize = 100;
const MAX_PAGES: u64 = 50;

/// Public regions, for the picker and when the key can't list them.
pub const REGIONS: &[&str] = &["FRA1", "LON1", "NYC1", "PHX1"];

fn region_param(region: &str) -> Result<&str, CloudError> {
    if !region.is_empty()
        && region.len() <= 32
        && region
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-')
    {
        Ok(region)
    } else {
        Err(CloudError::Invalid(format!(
            "\"{region}\" is not a Civo region."
        )))
    }
}

/// Unauthorized for keys Civo doesn't know (it answers 404 for those).
fn unknown_key(error: CloudError) -> CloudError {
    match error {
        CloudError::NotFound(message) => CloudError::Unauthorized(format!(
            "Civo did not accept the API key: {}",
            message.trim_start_matches("Civo: ")
        )),
        other => other,
    }
}

/// `GET /v2/regions`: validates the key; the codes of the regions with
/// Kubernetes.
pub async fn regions(ctx: &CloudContext, key: &str) -> Result<Vec<String>, CloudError> {
    let url = format!("{}/v2/regions", ctx.origin(PROVIDER, None));
    let value = http::json(ctx, PROVIDER, &|| {
        Ok(ApiRequest::get(url.clone()).bearer(key))
    })
    .await
    .map_err(unknown_key)?;
    let mut codes: Vec<String> = value
        .as_array()
        .into_iter()
        .flatten()
        .filter(|r| {
            r.pointer("/features/kubernetes")
                .and_then(Value::as_bool)
                .unwrap_or(true)
        })
        .filter_map(|r| text(r, "code"))
        .collect();
    codes.sort();
    codes.dedup();
    Ok(codes)
}

fn cluster_of(value: &Value, region: &str) -> Option<RemoteCluster> {
    Some(RemoteCluster {
        id: text(value, "id")?,
        name: text(value, "name")?,
        region: region.to_string(),
        version: text(value, "kubernetes_version").or_else(|| text(value, "version")),
        status: text(value, "status"),
        endpoint: text(value, "api_endpoint"),
        created_at: timestamp_ms(value.get("created_at")),
        project_id: None,
    })
}

/// The clusters of one region.
pub async fn clusters(
    ctx: &CloudContext,
    key: &str,
    region: &str,
) -> Result<Vec<RemoteCluster>, CloudError> {
    let origin = ctx.origin(PROVIDER, None);
    let region = region_param(region)?;
    let mut out = Vec::new();
    let mut page = 1;
    loop {
        let url = format!(
            "{origin}/v2/kubernetes/clusters?region={region}&page={page}&per_page={PER_PAGE}"
        );
        let value = http::json(ctx, PROVIDER, &|| {
            Ok(ApiRequest::get(url.clone()).bearer(key))
        })
        .await
        .map_err(unknown_key)?;
        out.extend(
            value
                .get("items")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(|c| cluster_of(c, region)),
        );
        let pages = value.get("pages").and_then(Value::as_u64).unwrap_or(1);
        if page >= pages || page >= MAX_PAGES {
            return Ok(out);
        }
        page += 1;
    }
}

/// The cluster's kubeconfig (YAML), once it is ready.
pub async fn kubeconfig(
    ctx: &CloudContext,
    key: &str,
    region: &str,
    cluster_id: &str,
) -> Result<String, CloudError> {
    let url = format!(
        "{}/v2/kubernetes/clusters/{}?region={}",
        ctx.origin(PROVIDER, None),
        path_segment(cluster_id)?,
        region_param(region)?
    );
    let value = http::json(ctx, PROVIDER, &|| {
        Ok(ApiRequest::get(url.clone()).bearer(key))
    })
    .await?;
    value
        .get("kubeconfig")
        .and_then(Value::as_str)
        .filter(|k| !k.trim().is_empty())
        .map(str::to_string)
        .ok_or_else(|| {
            CloudError::NotReady(
                "The kubeconfig of this cluster is not available yet. Try again when it is ready."
                    .into(),
            )
        })
}

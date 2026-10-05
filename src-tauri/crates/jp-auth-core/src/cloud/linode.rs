//! Akamai Connected Cloud / Linode (`api.linode.com`, bearer personal
//! access token): `GET /v4/profile`, `GET /v4/lke/clusters` (`page`) and
//! `GET /v4/lke/clusters/{id}/kubeconfig` (base64; HTTP 503 until the
//! cluster is ready).

use serde_json::Value;

use super::http::{self, ApiRequest};
use super::{base64_text, path_segment, text, timestamp_ms, CloudContext, CloudError};
use super::{Provider, RemoteCluster};

const PROVIDER: Provider = Provider::Linode;
const PAGE_SIZE: usize = 500;
const MAX_PAGES: u64 = 50;

/// Regions with LKE (October 2026), when the public list can't be fetched.
pub const REGIONS: &[&str] = &[
    "ap-northeast",
    "ap-south",
    "ap-southeast",
    "ap-west",
    "au-mel",
    "br-gru",
    "ca-central",
    "de-fra-2",
    "es-mad",
    "eu-central",
    "eu-west",
    "fr-par",
    "fr-par-2",
    "gb-lon",
    "id-cgk",
    "in-bom-2",
    "in-maa",
    "it-mil",
    "jp-osa",
    "jp-tyo-3",
    "nl-ams",
    "se-sto",
    "sg-sin-2",
    "us-central",
    "us-east",
    "us-iad",
    "us-iad-2",
    "us-lax",
    "us-mia",
    "us-ord",
    "us-sea",
    "us-southeast",
    "us-west",
];

/// `GET /v4/regions` (public): the regions with Kubernetes.
pub async fn regions(ctx: &CloudContext) -> Result<Vec<String>, CloudError> {
    let url = format!("{}/v4/regions?page_size=500", ctx.origin(PROVIDER, None));
    let value = http::json(ctx, PROVIDER, &|| Ok(ApiRequest::get(url.clone()))).await?;
    Ok(value
        .get("data")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|r| {
            r.get("capabilities")
                .and_then(Value::as_array)
                .is_some_and(|c| c.iter().any(|c| c.as_str() == Some("Kubernetes")))
        })
        .filter_map(|r| text(r, "id"))
        .collect())
}

/// `GET /v4/profile`: validates a token; the user name.
pub async fn profile(ctx: &CloudContext, token: &str) -> Result<Option<String>, CloudError> {
    let url = format!("{}/v4/profile", ctx.origin(PROVIDER, None));
    let value = http::json(ctx, PROVIDER, &|| {
        Ok(ApiRequest::get(url.clone()).bearer(token))
    })
    .await?;
    Ok(text(&value, "username").or_else(|| text(&value, "email")))
}

fn cluster_of(value: &Value) -> Option<RemoteCluster> {
    Some(RemoteCluster {
        id: text(value, "id")?,
        name: text(value, "label")?,
        region: text(value, "region")?,
        version: text(value, "k8s_version"),
        status: text(value, "status"),
        endpoint: None,
        created_at: timestamp_ms(value.get("created")),
        project_id: None,
    })
}

/// Every LKE cluster of the account.
pub async fn clusters(ctx: &CloudContext, token: &str) -> Result<Vec<RemoteCluster>, CloudError> {
    let origin = ctx.origin(PROVIDER, None);
    let mut out = Vec::new();
    let mut page = 1;
    loop {
        let url = format!("{origin}/v4/lke/clusters?page={page}&page_size={PAGE_SIZE}");
        let value = http::json(ctx, PROVIDER, &|| {
            Ok(ApiRequest::get(url.clone()).bearer(token))
        })
        .await?;
        out.extend(
            value
                .get("data")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(cluster_of),
        );
        let pages = value.get("pages").and_then(Value::as_u64).unwrap_or(1);
        if page >= pages || page >= MAX_PAGES {
            return Ok(out);
        }
        page += 1;
    }
}

/// The cluster's kubeconfig (YAML).
pub async fn kubeconfig(
    ctx: &CloudContext,
    token: &str,
    cluster_id: &str,
) -> Result<String, CloudError> {
    let url = format!(
        "{}/v4/lke/clusters/{}/kubeconfig",
        ctx.origin(PROVIDER, None),
        path_segment(cluster_id)?
    );
    let response = http::send(ctx, PROVIDER, &|| {
        Ok(ApiRequest::get(url.clone()).bearer(token))
    })
    .await?;
    if response.status == 503 {
        return Err(CloudError::NotReady(
            "The kubeconfig of this cluster is not available yet. Try again when it is ready."
                .into(),
        ));
    }
    let value = response.check(PROVIDER)?.json()?;
    let data = text(&value, "kubeconfig")
        .ok_or_else(|| CloudError::Invalid("Akamai returned no kubeconfig.".into()))?;
    base64_text(&data, "kubeconfig")
}

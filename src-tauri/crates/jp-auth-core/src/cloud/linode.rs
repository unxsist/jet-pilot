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

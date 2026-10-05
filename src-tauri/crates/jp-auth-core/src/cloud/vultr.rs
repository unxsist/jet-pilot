//! Vultr (`api.vultr.com`, bearer API key): `GET /v2/account`,
//! `GET /v2/kubernetes/clusters` (cursor pages through
//! `meta.links.next`) and `GET /v2/kubernetes/clusters/{id}/config`
//! (base64 kubeconfig).

use serde_json::Value;

use super::http::{self, ApiRequest};
use super::{base64_text, path_segment, text, timestamp_ms, CloudContext, CloudError};
use super::{Provider, RemoteCluster};

const PROVIDER: Provider = Provider::Vultr;
const PER_PAGE: usize = 100;
const MAX_PAGES: usize = 50;

/// Regions with VKE (October 2026), when the public list can't be fetched.
pub const REGIONS: &[&str] = &[
    "ams", "atl", "blr", "bom", "cdg", "del", "dfw", "ewr", "fra", "hnl", "icn", "itm", "jnb",
    "lax", "lhr", "mad", "man", "mel", "mex", "mia", "mxp", "nrt", "ord", "sao", "scl", "sea",
    "sgp", "sjc", "sto", "syd", "tlv", "waw", "yto",
];

/// `GET /v2/regions` (public): the regions with Kubernetes.
pub async fn regions(ctx: &CloudContext) -> Result<Vec<String>, CloudError> {
    let url = format!("{}/v2/regions?per_page=500", ctx.origin(PROVIDER, None));
    let value = http::json(ctx, PROVIDER, &|| Ok(ApiRequest::get(url.clone()))).await?;
    Ok(value
        .get("regions")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|r| {
            r.get("options")
                .and_then(Value::as_array)
                .is_some_and(|o| o.iter().any(|o| o.as_str() == Some("kubernetes")))
        })
        .filter_map(|r| text(r, "id"))
        .collect())
}

/// `GET /v2/account`: validates the key; the account name or email.
pub async fn account(ctx: &CloudContext, key: &str) -> Result<Option<String>, CloudError> {
    let url = format!("{}/v2/account", ctx.origin(PROVIDER, None));
    let value = http::json(ctx, PROVIDER, &|| {
        Ok(ApiRequest::get(url.clone()).bearer(key))
    })
    .await?;
    let account = value.get("account").cloned().unwrap_or(Value::Null);
    Ok(text(&account, "name").or_else(|| text(&account, "email")))
}

fn cluster_of(value: &Value) -> Option<RemoteCluster> {
    let endpoint = text(value, "endpoint").map(|host| {
        if host.starts_with("https://") {
            host
        } else {
            format!("https://{host}:6443")
        }
    });
    Some(RemoteCluster {
        id: text(value, "id")?,
        name: text(value, "label").unwrap_or_else(|| text(value, "id").unwrap_or_default()),
        region: text(value, "region")?,
        version: text(value, "version"),
        status: text(value, "status"),
        endpoint,
        created_at: timestamp_ms(value.get("date_created")),
        project_id: None,
    })
}

/// A cursor is passed back verbatim: keep it to safe characters.
fn cursor_param(cursor: &str) -> Option<String> {
    let ok = cursor.len() <= 512
        && cursor
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-_=+/.".contains(&b));
    ok.then(|| {
        cursor
            .replace('+', "%2B")
            .replace('/', "%2F")
            .replace('=', "%3D")
    })
}

/// Every VKE cluster of the account.
pub async fn clusters(ctx: &CloudContext, key: &str) -> Result<Vec<RemoteCluster>, CloudError> {
    let origin = ctx.origin(PROVIDER, None);
    let mut out = Vec::new();
    let mut cursor: Option<String> = None;
    for _ in 0..MAX_PAGES {
        let url = match &cursor {
            Some(cursor) => {
                format!("{origin}/v2/kubernetes/clusters?per_page={PER_PAGE}&cursor={cursor}")
            }
            None => format!("{origin}/v2/kubernetes/clusters?per_page={PER_PAGE}"),
        };
        let value = http::json(ctx, PROVIDER, &|| {
            Ok(ApiRequest::get(url.clone()).bearer(key))
        })
        .await?;
        out.extend(
            value
                .get("vke_clusters")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(cluster_of),
        );
        let next = value
            .pointer("/meta/links/next")
            .and_then(Value::as_str)
            .filter(|n| !n.is_empty())
            .and_then(cursor_param);
        match next {
            Some(next) if Some(&next) != cursor.as_ref() => cursor = Some(next),
            _ => return Ok(out),
        }
    }
    Err(CloudError::Invalid(
        "Vultr returned too many pages of clusters.".into(),
    ))
}

/// The cluster's kubeconfig (YAML).
pub async fn kubeconfig(
    ctx: &CloudContext,
    key: &str,
    cluster_id: &str,
) -> Result<String, CloudError> {
    let url = format!(
        "{}/v2/kubernetes/clusters/{}/config",
        ctx.origin(PROVIDER, None),
        path_segment(cluster_id)?
    );
    let value = http::json(ctx, PROVIDER, &|| {
        Ok(ApiRequest::get(url.clone()).bearer(key))
    })
    .await?;
    let data = text(&value, "kube_config")
        .ok_or_else(|| CloudError::Invalid("Vultr returned no kubeconfig.".into()))?;
    base64_text(&data, "kubeconfig")
}

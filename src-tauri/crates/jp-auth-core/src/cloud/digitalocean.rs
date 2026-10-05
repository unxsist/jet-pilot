//! DigitalOcean (`api.digitalocean.com`, bearer API token):
//! `GET /v2/account`, `GET /v2/kubernetes/clusters` (pages followed through
//! `links.pages.next`) and `GET /v2/kubernetes/clusters/{id}/credentials`
//! (`expiry_seconds`), which mints the short-lived tokens of
//! `jetpilot-auth credential digitalocean`.

use serde_json::Value;

use super::http::{self, ApiRequest};
use super::mint::MintedCredential;
use super::{base64_text, path_segment, text, timestamp_ms, CloudContext, CloudError};
use super::{Provider, RemoteCluster};

const PROVIDER: Provider = Provider::DigitalOcean;
/// Pages followed at most (200 clusters each).
const MAX_PAGES: usize = 50;

/// Who a token belongs to.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Account {
    pub email: Option<String>,
    pub team: Option<String>,
}

/// `GET /v2/account`: validates a token.
pub async fn account(ctx: &CloudContext, token: &str) -> Result<Account, CloudError> {
    let url = format!("{}/v2/account", ctx.origin(PROVIDER, None));
    let value = http::json(ctx, PROVIDER, &|| {
        Ok(ApiRequest::get(url.clone()).bearer(token))
    })
    .await?;
    let account = value.get("account").cloned().unwrap_or(Value::Null);
    Ok(Account {
        email: text(&account, "email"),
        team: account.get("team").and_then(|t| text(t, "name")),
    })
}

fn cluster_of(value: &Value) -> Option<RemoteCluster> {
    Some(RemoteCluster {
        id: text(value, "id")?,
        name: text(value, "name")?,
        region: text(value, "region")?,
        version: text(value, "version"),
        status: value.get("status").and_then(|s| text(s, "state")),
        endpoint: text(value, "endpoint"),
        created_at: timestamp_ms(value.get("created_at")),
        project_id: None,
    })
}

/// The path + query of a `links.pages.next` URL (always requested from our
/// own origin: the allowlist stays in force).
fn next_path(value: &Value) -> Option<String> {
    let next = value.pointer("/links/pages/next")?.as_str()?;
    let rest = next.split_once("://").map(|(_, rest)| rest).unwrap_or(next);
    let path = &rest[rest.find('/')?..];
    path.starts_with("/v2/kubernetes/clusters")
        .then(|| path.to_string())
}

/// Every Kubernetes cluster of the account.
pub async fn clusters(ctx: &CloudContext, token: &str) -> Result<Vec<RemoteCluster>, CloudError> {
    let origin = ctx.origin(PROVIDER, None);
    let mut path = "/v2/kubernetes/clusters?per_page=200".to_string();
    let mut out = Vec::new();
    for _ in 0..MAX_PAGES {
        let url = format!("{origin}{path}");
        let value = http::json(ctx, PROVIDER, &|| {
            Ok(ApiRequest::get(url.clone()).bearer(token))
        })
        .await?;
        out.extend(
            value
                .get("kubernetes_clusters")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(cluster_of),
        );
        match next_path(&value) {
            Some(next) if next != path => path = next,
            _ => return Ok(out),
        }
    }
    Err(CloudError::Invalid(
        "DigitalOcean returned too many pages of clusters.".into(),
    ))
}

/// What the credentials endpoint returns: the API server, its CA (base64
/// PEM) and the minted credential.
#[derive(Debug)]
pub struct ClusterCredentials {
    pub server: String,
    pub certificate_authority: Option<String>,
    pub credential: MintedCredential,
}

/// `GET /v2/kubernetes/clusters/{id}/credentials?expiry_seconds=`: a token
/// (older clusters: a client certificate) valid for `expiry_seconds`.
pub async fn credentials(
    ctx: &CloudContext,
    token: &str,
    cluster_id: &str,
    expiry_seconds: i64,
) -> Result<ClusterCredentials, CloudError> {
    let url = format!(
        "{}/v2/kubernetes/clusters/{}/credentials?expiry_seconds={expiry_seconds}",
        ctx.origin(PROVIDER, None),
        path_segment(cluster_id)?
    );
    let requested_at = crate::now_secs();
    let response = http::send(ctx, PROVIDER, &|| {
        Ok(ApiRequest::get(url.clone()).bearer(token))
    })
    .await?;
    let value = match response.check(PROVIDER) {
        Ok(response) => response.json()?,
        Err(CloudError::NotFound(_)) => {
            return Err(CloudError::NotFound(
                "This DigitalOcean cluster no longer exists.".into(),
            ))
        }
        Err(other) => return Err(other),
    };
    let server = text(&value, "server")
        .ok_or_else(|| CloudError::Invalid("DigitalOcean returned no API server.".into()))?;
    let decoded = |key: &str, what: &str| -> Result<Option<String>, CloudError> {
        text(&value, key)
            .map(|data| base64_text(&data, what))
            .transpose()
    };
    let credential = MintedCredential {
        token: text(&value, "token"),
        client_certificate_pem: decoded("client_certificate_data", "client certificate")?,
        client_key_pem: decoded("client_key_data", "client key")?,
        expires_at: value
            .get("expires_at")
            .and_then(|v| timestamp_ms(Some(v)))
            .map(|ms| ms / 1000)
            .unwrap_or(requested_at + expiry_seconds),
    };
    if credential.is_empty() {
        return Err(CloudError::Invalid(
            "DigitalOcean returned no credentials for this cluster.".into(),
        ));
    }
    Ok(ClusterCredentials {
        server,
        certificate_authority: text(&value, "certificate_authority_data"),
        credential,
    })
}

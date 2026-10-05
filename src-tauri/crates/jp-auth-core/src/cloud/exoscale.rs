//! Exoscale (`api-<zone>.exoscale.com`), every request signed with the
//! API key and secret (EXO2-HMAC-SHA256, see [`authorization`]):
//! `GET /v2/sks-cluster` per zone, the control plane CA
//! (`GET /v2/sks-cluster/{id}/authority/control-plane/cert`), client
//! certificate kubeconfigs (`POST /v2/sks-cluster-kubeconfig/{id}`) and
//! `GET /v2/organization` for the account's name.

use base64::Engine;
use hmac::{Hmac, Mac};
use serde_json::{json, Value};
use sha2::Sha256;

use super::http::{self, ApiRequest};
use super::{base64_text, path_segment, text, timestamp_ms, ApiKey, CloudContext, CloudError};
use super::{Provider, RemoteCluster};

const PROVIDER: Provider = Provider::Exoscale;
/// Signed requests are valid this long.
const SIGNATURE_TTL: i64 = 10 * 60;
/// Lifetime of minted kubeconfig client certificates.
pub const KUBECONFIG_TTL: i64 = 86_400;

/// Zones with SKS.
pub const ZONES: &[&str] = &[
    "at-vie-1", "at-vie-2", "bg-sof-1", "ch-dk-2", "ch-gva-2", "de-fra-1", "de-muc-1", "hr-zag-1",
];

/// The `Authorization` header of a request, per
/// <https://openapi-v2.exoscale.com/topic/topic-api-request-signature>:
///
/// The message is the request method and URL path (`GET /v2/...`), the
/// body, the values of the signed query parameters (names sorted, only
/// parameters with exactly one value) concatenated without separator, the
/// signed header values (none) and the expiry (unix seconds), joined by
/// `\n`. The signature is base64(HMAC-SHA256(secret, message)):
///
/// `EXO2-HMAC-SHA256 credential=<key>[,signed-query-args=<p1;p2>],expires=<expiry>,signature=<signature>`
pub fn authorization(
    key: &str,
    secret: &str,
    method: &str,
    path: &str,
    query: &[(&str, &str)],
    body: &[u8],
    expires: i64,
) -> String {
    let mut names: Vec<&str> = query
        .iter()
        .map(|(name, _)| *name)
        .filter(|name| query.iter().filter(|(n, _)| n == name).count() == 1)
        .collect();
    names.sort_unstable();
    let values: String = names
        .iter()
        .filter_map(|name| query.iter().find(|(n, _)| n == name).map(|(_, v)| *v))
        .collect();
    let message = format!(
        "{method} {path}\n{}\n{values}\n\n{expires}",
        String::from_utf8_lossy(body)
    );
    let mut mac =
        Hmac::<Sha256>::new_from_slice(secret.as_bytes()).expect("HMAC takes keys of any length");
    mac.update(message.as_bytes());
    let signature = base64::engine::general_purpose::STANDARD.encode(mac.finalize().into_bytes());
    let mut header = format!("EXO2-HMAC-SHA256 credential={key}");
    if !names.is_empty() {
        header.push_str(",signed-query-args=");
        header.push_str(&names.join(";"));
    }
    header.push_str(&format!(",expires={expires},signature={signature}"));
    header
}

/// `GET /v2/zone` (public): every zone.
pub async fn zones(ctx: &CloudContext) -> Result<Vec<String>, CloudError> {
    let url = format!("{}/v2/zone", ctx.origin(PROVIDER, Some("ch-gva-2")));
    let value = http::json(ctx, PROVIDER, &|| Ok(ApiRequest::get(url.clone()))).await?;
    Ok(value
        .get("zones")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|z| text(z, "name"))
        .filter(|z| crate::request::valid_region(z))
        .collect())
}

fn zone_param(zone: &str) -> Result<&str, CloudError> {
    if crate::request::valid_region(zone) {
        Ok(zone)
    } else {
        Err(CloudError::Invalid(format!(
            "\"{zone}\" is not an Exoscale zone."
        )))
    }
}

/// A signed request to `path` (starting with `/v2/`) in `zone`.
async fn signed(
    ctx: &CloudContext,
    key: &ApiKey,
    zone: &str,
    method: &'static str,
    path: &str,
    body: Option<Value>,
) -> Result<http::ApiResponse, CloudError> {
    let zone = zone_param(zone)?;
    let url = format!("{}{path}", ctx.origin(PROVIDER, Some(zone)));
    let body = body.map(|b| b.to_string().into_bytes());
    http::send(ctx, PROVIDER, &|| {
        let expires = crate::now_secs() + SIGNATURE_TTL;
        let header = authorization(
            &key.key,
            &key.secret,
            method,
            path,
            &[],
            body.as_deref().unwrap_or_default(),
            expires,
        );
        let mut request = ApiRequest {
            method,
            url: url.clone(),
            headers: vec![("authorization", header)],
            body: body.clone(),
        };
        if body.is_some() {
            request
                .headers
                .push(("content-type", "application/json".into()));
        }
        Ok(request)
    })
    .await
}

/// The organization's name (None when the key may not read it).
pub async fn organization(ctx: &CloudContext, key: &ApiKey) -> Result<Option<String>, CloudError> {
    let response = signed(ctx, key, "ch-gva-2", "GET", "/v2/organization", None).await?;
    match response.check(PROVIDER) {
        Ok(response) => Ok(text(&response.json()?, "name")),
        Err(CloudError::Unauthorized(_)) | Err(CloudError::NotFound(_)) => Ok(None),
        Err(other) => Err(other),
    }
}

fn cluster_of(value: &Value, zone: &str) -> Option<RemoteCluster> {
    Some(RemoteCluster {
        id: text(value, "id")?,
        name: text(value, "name")?,
        region: zone.to_string(),
        version: text(value, "version"),
        status: text(value, "state"),
        endpoint: text(value, "endpoint"),
        created_at: timestamp_ms(value.get("created-at")),
        project_id: None,
    })
}

/// The SKS clusters of a zone (also validates the key).
pub async fn clusters(
    ctx: &CloudContext,
    key: &ApiKey,
    zone: &str,
) -> Result<Vec<RemoteCluster>, CloudError> {
    let value = signed(ctx, key, zone, "GET", "/v2/sks-cluster", None)
        .await?
        .check(PROVIDER)?
        .json()?;
    Ok(value
        .get("sks-clusters")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|c| cluster_of(c, zone))
        .collect())
}

/// The control plane CA of a cluster (base64 PEM).
pub async fn certificate_authority(
    ctx: &CloudContext,
    key: &ApiKey,
    zone: &str,
    cluster_id: &str,
) -> Result<String, CloudError> {
    let path = format!(
        "/v2/sks-cluster/{}/authority/control-plane/cert",
        path_segment(cluster_id)?
    );
    let value = signed(ctx, key, zone, "GET", &path, None)
        .await?
        .check(PROVIDER)?
        .json()?;
    let cert = text(&value, "cacert")
        .ok_or_else(|| CloudError::Invalid("Exoscale returned no cluster CA.".into()))?;
    if cert.starts_with("-----BEGIN") {
        return Ok(base64::engine::general_purpose::STANDARD.encode(cert.as_bytes()));
    }
    let pem = base64_text(&cert, "cluster CA")?;
    if !pem.contains("-----BEGIN CERTIFICATE-----") {
        return Err(CloudError::Invalid(
            "Exoscale returned an invalid cluster CA.".into(),
        ));
    }
    Ok(cert)
}

/// A kubeconfig (YAML) with a client certificate for `user` / `groups`,
/// valid for `ttl` seconds.
pub async fn kubeconfig(
    ctx: &CloudContext,
    key: &ApiKey,
    zone: &str,
    cluster_id: &str,
    user: &str,
    groups: &[String],
    ttl: i64,
) -> Result<String, CloudError> {
    let path = format!("/v2/sks-cluster-kubeconfig/{}", path_segment(cluster_id)?);
    let body = json!({ "ttl": ttl, "user": user, "groups": groups });
    let response = signed(ctx, key, zone, "POST", &path, Some(body)).await?;
    let value = match response.check(PROVIDER) {
        Ok(response) => response.json()?,
        Err(CloudError::NotFound(_)) => {
            return Err(CloudError::NotFound(
                "This Exoscale cluster no longer exists.".into(),
            ))
        }
        Err(other) => return Err(other),
    };
    let data = text(&value, "kubeconfig")
        .ok_or_else(|| CloudError::Invalid("Exoscale returned no kubeconfig.".into()))?;
    base64_text(&data, "kubeconfig")
}

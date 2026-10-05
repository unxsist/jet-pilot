//! Credentials minted for `jetpilot-auth credential digitalocean|exoscale`
//! (and in-process by the app): short-lived DigitalOcean tokens and
//! Exoscale client certificates, cached in the vault
//! (`cache:<provider>:<connection>:<cluster>`) until shortly before they
//! expire, shared by the app and every helper run. Never interactive.

use serde::{Deserialize, Serialize};
use zeroize::Zeroize;

use super::{digitalocean, exoscale, kubeconfig, CloudContext, CloudError};
use crate::connections::{cache_prefix, CloudConnection, ConnectionKind};
use crate::exec_credential::{ExecCredential, ExecCredentialStatus};
use crate::request::{DigitaloceanArgs, ExoscaleArgs};

/// Lifetime of minted DigitalOcean tokens.
pub const DIGITALOCEAN_TOKEN_TTL: i64 = 60 * 60;
/// Cached DigitalOcean tokens are used while valid at least this long.
pub const DIGITALOCEAN_MARGIN: i64 = 5 * 60;
/// Cached Exoscale certificates are used while valid at least this long.
pub const EXOSCALE_MARGIN: i64 = 15 * 60;

/// A token and/or client certificate with its expiry.
#[derive(Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MintedCredential {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub token: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_certificate_pem: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_key_pem: Option<String>,
    /// Unix seconds.
    pub expires_at: i64,
}

impl Drop for MintedCredential {
    fn drop(&mut self) {
        self.token.zeroize();
        self.client_key_pem.zeroize();
    }
}

impl std::fmt::Debug for MintedCredential {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("MintedCredential")
            .field("token", &self.token.is_some())
            .field("client_certificate", &self.client_certificate_pem.is_some())
            .field("client_key", &self.client_key_pem.is_some())
            .field("expires_at", &self.expires_at)
            .finish()
    }
}

impl MintedCredential {
    fn has_client_certificate(&self) -> bool {
        self.client_certificate_pem
            .as_deref()
            .is_some_and(|c| !c.is_empty())
            && self
                .client_key_pem
                .as_deref()
                .is_some_and(|k| !k.is_empty())
    }

    /// Neither a token nor a complete certificate + key.
    pub fn is_empty(&self) -> bool {
        self.token.as_deref().is_none_or(str::is_empty) && !self.has_client_certificate()
    }

    pub fn to_exec_credential(&self, api_version: &str) -> ExecCredential {
        let (cert, key) = if self.has_client_certificate() {
            (
                self.client_certificate_pem.clone(),
                self.client_key_pem.clone(),
            )
        } else {
            (None, None)
        };
        ExecCredential::new(
            api_version,
            ExecCredentialStatus {
                expiration_timestamp: Some(crate::time::format_rfc3339(self.expires_at)),
                token: self.token.clone().filter(|t| !t.is_empty()),
                client_certificate_data: cert,
                client_key_data: key,
            },
        )
    }
}

pub fn digitalocean_cache_id(connection_id: &str, cluster_id: &str) -> String {
    format!(
        "{}{cluster_id}",
        cache_prefix("digitalocean", connection_id)
    )
}

pub fn exoscale_cache_id(connection_id: &str, cluster_id: &str) -> String {
    format!("{}{cluster_id}", cache_prefix("exoscale", connection_id))
}

/// A cached credential valid at least `margin` seconds more.
pub async fn cached(ctx: &CloudContext, id: String, margin: i64) -> Option<MintedCredential> {
    let now = crate::now_secs();
    ctx.with_store(move |store| crate::cache::get::<MintedCredential>(store, &id, now, margin))
        .await
}

/// Caches a minted credential until it expires (a failed write is only a
/// cache miss later).
pub async fn remember(ctx: &CloudContext, id: String, credential: &MintedCredential) {
    let copy = credential.clone();
    let now = crate::now_secs();
    let _ = ctx
        .with_store(move |store| crate::cache::put(store, &id, &copy, copy.expires_at, now))
        .await;
}

fn connection_for(
    ctx: &CloudContext,
    id: &str,
    provider: &str,
    kind: ConnectionKind,
) -> Result<CloudConnection, CloudError> {
    let connection = ctx.connection(id)?;
    if connection.provider != provider || connection.kind != kind {
        return Err(CloudError::Invalid(format!(
            "The connection {id} can't mint {provider} credentials."
        )));
    }
    Ok(connection)
}

/// A DigitalOcean token for a cluster of a token connection.
pub async fn digitalocean(
    ctx: &CloudContext,
    args: &DigitaloceanArgs,
) -> Result<MintedCredential, CloudError> {
    let connection = connection_for(ctx, &args.connection, "digitalocean", ConnectionKind::Token)?;
    let cache_id = digitalocean_cache_id(&connection.id, &args.cluster);
    if let Some(credential) = cached(ctx, cache_id.clone(), DIGITALOCEAN_MARGIN).await {
        return Ok(credential);
    }
    let token = ctx.api_token(&connection.id).await?;
    let minted =
        digitalocean::credentials(ctx, &token.token, &args.cluster, DIGITALOCEAN_TOKEN_TTL).await?;
    remember(ctx, cache_id, &minted.credential).await;
    Ok(minted.credential.clone())
}

/// An Exoscale client certificate for a cluster of an API key connection,
/// for the connection's user and groups.
pub async fn exoscale(
    ctx: &CloudContext,
    args: &ExoscaleArgs,
) -> Result<MintedCredential, CloudError> {
    let connection = connection_for(ctx, &args.connection, "exoscale", ConnectionKind::ApiKey)?;
    let cache_id = exoscale_cache_id(&connection.id, &args.cluster);
    if let Some(credential) = cached(ctx, cache_id.clone(), EXOSCALE_MARGIN).await {
        return Ok(credential);
    }
    let key = ctx.api_key(&connection.id).await?;
    let settings = connection.exoscale_settings();
    let requested_at = crate::now_secs();
    let config = exoscale::kubeconfig(
        ctx,
        &key,
        &args.zone,
        &args.cluster,
        &settings.user,
        &settings.groups,
        exoscale::KUBECONFIG_TTL,
    )
    .await?;
    let (cert, private_key) = kubeconfig::client_certificate(&config)?;
    let credential = MintedCredential {
        token: None,
        client_certificate_pem: Some(cert),
        client_key_pem: Some(private_key),
        expires_at: requested_at + exoscale::KUBECONFIG_TTL,
    };
    remember(ctx, cache_id, &credential).await;
    Ok(credential)
}

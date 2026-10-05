//! Clouds other than AWS, over their REST APIs (feature `cloud`), shared by
//! the app (discovery, adding clusters) and the helper (minting):
//!
//! - [`http`]: the HTTP client (the rustls + ring connector of the AWS SDK
//!   clients, timeouts, 429 / 5xx backoff, a per-provider host allowlist);
//! - [`digitalocean`], [`linode`], [`civo`], [`scaleway`], [`vultr`],
//!   [`exoscale`]: accounts, cluster listings and kubeconfigs;
//! - [`mint`]: short-lived DigitalOcean tokens and Exoscale client
//!   certificates for `jetpilot-auth credential digitalocean|exoscale`,
//!   cached in the vault until shortly before they expire;
//! - [`kubeconfig`]: the client credentials of a provider-made kubeconfig
//!   without a YAML library (the helper stays small).
//!
//! API tokens and keys live in the vault (`conn:<id>:api-token`,
//! `conn:<id>:api-key`); nothing here logs or returns them.

pub mod civo;
pub mod digitalocean;
pub mod exoscale;
pub mod http;
pub mod kubeconfig;
pub mod linode;
pub mod mint;
pub mod scaleway;
#[cfg(test)]
mod tests;
pub mod vultr;

use std::path::PathBuf;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use zeroize::Zeroize;

use crate::connections::{api_key_secret_id, api_token_secret_id, CloudConnection};
use crate::vault::{Store, VaultError};

/// A loopback base URL used for every provider instead of the real APIs
/// (the helper's integration tests). Anything that isn't
/// `http://127.0.0.1:<port>` / `http://localhost:<port>` is ignored, so the
/// variable can never send credentials to another host.
pub const TEST_ENDPOINT_ENV: &str = "JET_PILOT_CLOUD_TEST_ENDPOINT";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Provider {
    DigitalOcean,
    Linode,
    Civo,
    Scaleway,
    Vultr,
    Exoscale,
}

impl Provider {
    pub const ALL: [Provider; 6] = [
        Provider::DigitalOcean,
        Provider::Linode,
        Provider::Civo,
        Provider::Scaleway,
        Provider::Vultr,
        Provider::Exoscale,
    ];

    /// The id in connections and catalog keys.
    pub fn id(self) -> &'static str {
        match self {
            Provider::DigitalOcean => "digitalocean",
            Provider::Linode => "linode",
            Provider::Civo => "civo",
            Provider::Scaleway => "scaleway",
            Provider::Vultr => "vultr",
            Provider::Exoscale => "exoscale",
        }
    }

    pub fn from_id(id: &str) -> Option<Provider> {
        Provider::ALL.into_iter().find(|p| p.id() == id)
    }

    /// For messages.
    pub fn name(self) -> &'static str {
        match self {
            Provider::DigitalOcean => "DigitalOcean",
            Provider::Linode => "Akamai",
            Provider::Civo => "Civo",
            Provider::Scaleway => "Scaleway",
            Provider::Vultr => "Vultr",
            Provider::Exoscale => "Exoscale",
        }
    }

    /// The API origin (Exoscale: of a zone).
    pub fn origin(self, zone: Option<&str>) -> String {
        match self {
            Provider::DigitalOcean => "https://api.digitalocean.com".to_string(),
            Provider::Linode => "https://api.linode.com".to_string(),
            Provider::Civo => "https://api.civo.com".to_string(),
            Provider::Scaleway => "https://api.scaleway.com".to_string(),
            Provider::Vultr => "https://api.vultr.com".to_string(),
            Provider::Exoscale => {
                format!("https://api-{}.exoscale.com", zone.unwrap_or("ch-gva-2"))
            }
        }
    }

    /// Whether `host` is one of the provider's API hosts (the outbound
    /// allowlist).
    pub fn allows_host(self, host: &str) -> bool {
        let host = host.to_ascii_lowercase();
        match self {
            Provider::Exoscale => host
                .strip_prefix("api-")
                .and_then(|rest| rest.strip_suffix(".exoscale.com"))
                .is_some_and(crate::request::valid_region),
            other => other
                .origin(None)
                .strip_prefix("https://")
                .is_some_and(|allowed| allowed == host),
        }
    }
}

/// What went wrong talking to a provider. Messages are user-facing and
/// never contain credentials.
#[derive(Debug, Clone, PartialEq)]
pub enum CloudError {
    /// The provider refused the credentials (401 / 403).
    Unauthorized(String),
    /// The resource (or the connection) does not exist (any more).
    NotFound(String),
    /// The cluster isn't ready for this yet (no kubeconfig yet).
    NotReady(String),
    /// Nothing is stored for the connection: add it again.
    MissingCredentials(String),
    /// The provider answered with an error.
    Service {
        status: u16,
        message: String,
    },
    /// The provider could not be reached (or took too long).
    Network(String),
    Vault(VaultError),
    Invalid(String),
}

impl std::fmt::Display for CloudError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CloudError::Unauthorized(message)
            | CloudError::NotFound(message)
            | CloudError::NotReady(message)
            | CloudError::MissingCredentials(message)
            | CloudError::Network(message)
            | CloudError::Invalid(message)
            | CloudError::Service { message, .. } => f.write_str(message),
            CloudError::Vault(error) => write!(f, "{error}"),
        }
    }
}

impl std::error::Error for CloudError {}

impl From<VaultError> for CloudError {
    fn from(error: VaultError) -> Self {
        CloudError::Vault(error)
    }
}

/// The API token of a token connection (`conn:<id>:api-token`).
#[derive(Clone, Serialize, Deserialize)]
pub struct ApiToken {
    pub token: String,
}

impl Drop for ApiToken {
    fn drop(&mut self) {
        self.token.zeroize();
    }
}

impl std::fmt::Debug for ApiToken {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("ApiToken(<redacted>)")
    }
}

/// The API key + secret of an Exoscale connection (`conn:<id>:api-key`).
#[derive(Clone, Serialize, Deserialize)]
pub struct ApiKey {
    pub key: String,
    pub secret: String,
}

impl Drop for ApiKey {
    fn drop(&mut self) {
        self.secret.zeroize();
    }
}

impl std::fmt::Debug for ApiKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ApiKey")
            .field("key", &self.key)
            .field("secret", &"<redacted>")
            .finish()
    }
}

/// A cluster a provider listed.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct RemoteCluster {
    /// The provider's id (UUID, number).
    pub id: String,
    pub name: String,
    /// Region (Exoscale: zone) as the API names it.
    pub region: String,
    pub version: Option<String>,
    pub status: Option<String>,
    /// The API server URL, when the listing has it.
    pub endpoint: Option<String>,
    /// Unix ms.
    pub created_at: Option<i64>,
    /// Scaleway: the cluster's project.
    pub project_id: Option<String>,
}

/// Everything the cloud calls depend on: the vault, the connections file,
/// timeouts and (tests) an endpoint override.
#[derive(Clone)]
pub struct CloudContext {
    pub store: Store,
    /// `connections.json`.
    pub connections_file: PathBuf,
    /// A base URL used for every provider instead of the real APIs
    /// (a fake server in tests).
    pub endpoint: Option<String>,
    /// Per-attempt timeout of an API call.
    pub timeout: Duration,
    pub max_attempts: u32,
    pub initial_backoff: Duration,
}

/// `value` when it is a loopback http base URL (see [`TEST_ENDPOINT_ENV`]).
pub fn loopback_endpoint(value: &str) -> Option<String> {
    let value = value.trim().trim_end_matches('/');
    let rest = value.strip_prefix("http://")?;
    let (host, port) = rest.rsplit_once(':')?;
    let loopback = host == "127.0.0.1" || host.eq_ignore_ascii_case("localhost");
    let port_ok = !port.is_empty() && port.len() <= 5 && port.bytes().all(|b| b.is_ascii_digit());
    (loopback && port_ok).then(|| value.to_string())
}

impl CloudContext {
    /// The real environment: `store`, the JET Pilot home's connections and
    /// the providers' APIs.
    pub fn system(store: Store) -> CloudContext {
        CloudContext {
            store,
            connections_file: crate::paths::jet_pilot_home().join(crate::connections::FILE_NAME),
            endpoint: std::env::var(TEST_ENDPOINT_ENV)
                .ok()
                .and_then(|v| loopback_endpoint(&v)),
            timeout: Duration::from_secs(15),
            max_attempts: 4,
            initial_backoff: Duration::from_millis(500),
        }
    }

    /// The base URL of `provider`'s API (Exoscale: of `zone`).
    pub fn origin(&self, provider: Provider, zone: Option<&str>) -> String {
        match &self.endpoint {
            Some(endpoint) => endpoint.trim_end_matches('/').to_string(),
            None => provider.origin(zone),
        }
    }

    pub fn connection(&self, id: &str) -> Result<CloudConnection, CloudError> {
        crate::connections::find(&self.connections_file, id)
            .map_err(|e| {
                CloudError::Invalid(format!("The JET Pilot connections can't be read: {e}"))
            })?
            .ok_or_else(|| {
                CloudError::NotFound(
                    "This connection no longer exists in JET Pilot. Add the cluster again."
                        .to_string(),
                )
            })
    }

    /// Runs vault work off the async runtime.
    pub(crate) async fn with_store<T: Send + 'static>(
        &self,
        work: impl FnOnce(&Store) -> T + Send + 'static,
    ) -> T {
        let store = self.store.clone();
        match tokio::task::spawn_blocking(move || work(&store)).await {
            Ok(value) => value,
            Err(e) => std::panic::resume_unwind(e.into_panic()),
        }
    }

    async fn secret<T: serde::de::DeserializeOwned + Send + 'static>(
        &self,
        id: String,
    ) -> Result<T, CloudError> {
        let value = self.with_store(move |store| store.get(&id)).await?;
        let value = value.ok_or_else(|| {
            CloudError::MissingCredentials(
                "JET Pilot has no stored credentials for this connection. Add the connection again."
                    .to_string(),
            )
        })?;
        serde_json::from_value(value).map_err(|_| {
            CloudError::Invalid("The stored credentials of this connection are not valid.".into())
        })
    }

    /// The API token of a token connection.
    pub async fn api_token(&self, connection_id: &str) -> Result<ApiToken, CloudError> {
        self.secret(api_token_secret_id(connection_id)).await
    }

    /// The API key + secret of an Exoscale connection.
    pub async fn api_key(&self, connection_id: &str) -> Result<ApiKey, CloudError> {
        self.secret(api_key_secret_id(connection_id)).await
    }
}

/* -------------------------------------------------------- JSON helpers */

pub(crate) fn text(value: &serde_json::Value, key: &str) -> Option<String> {
    match value.get(key)? {
        serde_json::Value::String(s) if !s.trim().is_empty() => Some(s.trim().to_string()),
        serde_json::Value::Number(n) => Some(n.to_string()),
        _ => None,
    }
}

/// Unix ms of an RFC 3339 timestamp; one without a zone is UTC (Linode).
pub(crate) fn timestamp_ms(value: Option<&serde_json::Value>) -> Option<i64> {
    let text = value?.as_str()?.trim();
    crate::time::parse_rfc3339(text)
        .or_else(|| crate::time::parse_rfc3339(&format!("{text}Z")))
        .map(|secs| secs * 1000)
}

/// Decodes base64 (standard, padding optional) into text.
pub(crate) fn base64_text(data: &str, what: &str) -> Result<String, CloudError> {
    use base64::Engine;
    let compact: String = data.chars().filter(|c| !c.is_whitespace()).collect();
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(compact.as_bytes())
        .or_else(|_| base64::engine::general_purpose::STANDARD_NO_PAD.decode(compact.as_bytes()))
        .map_err(|_| CloudError::Invalid(format!("The {what} is not valid base64.")))?;
    String::from_utf8(bytes).map_err(|_| CloudError::Invalid(format!("The {what} is not text.")))
}

/// Checks an id before it goes into a URL path.
pub(crate) fn path_segment(id: &str) -> Result<&str, CloudError> {
    if crate::request::valid_cloud_cluster_id(id) {
        Ok(id)
    } else {
        Err(CloudError::Invalid(format!("\"{id}\" is not a valid id.")))
    }
}

/// A test context: `store` and `connections_file` as given, every API at
/// `base_url`, quick retries.
#[cfg(any(test, feature = "test-util"))]
pub fn test_context(store: Store, connections_file: PathBuf, base_url: &str) -> CloudContext {
    CloudContext {
        store,
        connections_file,
        endpoint: Some(base_url.trim_end_matches('/').to_string()),
        timeout: Duration::from_secs(5),
        max_attempts: 3,
        initial_backoff: Duration::from_millis(1),
    }
}

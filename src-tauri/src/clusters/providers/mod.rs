//! Cloud providers behind the connections and the catalog:
//!
//! - [`aws`]: IAM Identity Center, profiles and access keys (SDK);
//! - [`api`]: DigitalOcean, Akamai (Linode), Civo, Scaleway, Vultr and
//!   Exoscale over their REST APIs with a token / key from the vault
//!   (`jp_auth_core::cloud`);
//! - [`gcp`], [`azure`], [`doctl`]: the signed-in user of `gcloud`, `az`
//!   or `doctl`, run non-interactively through [`cli`].
//!
//! Every provider discovers into the same [`Listing`]s; the catalog merges
//! them and adds clusters from what [`Prepared`] describes.

pub mod api;
pub mod aws;
pub mod azure;
pub mod cli;
pub mod doctl;
pub mod gcp;
#[cfg(test)]
mod tests;

use std::sync::Arc;

use jp_auth_core::cloud::{CloudContext, Provider as ApiProvider};
use jp_auth_core::connections::{CloudConnection, ConnectionKind};
use kube::config::{AuthInfo, Cluster};
use serde::Serialize;

use crate::clusters::error::AppError;

pub const AWS: &str = "aws";
pub const GCP: &str = "gcp";
pub const AZURE: &str = "azure";
pub const DIGITALOCEAN: &str = "digitalocean";
pub const LINODE: &str = "linode";
pub const CIVO: &str = "civo";
pub const SCALEWAY: &str = "scaleway";
pub const VULTR: &str = "vultr";
pub const EXOSCALE: &str = "exoscale";

/// For messages: `Google Cloud`, `Azure`, ...
pub fn display_name(provider: &str) -> &'static str {
    match provider {
        AWS => "AWS",
        GCP => "Google Cloud",
        AZURE => "Azure",
        DIGITALOCEAN => "DigitalOcean",
        LINODE => "Akamai",
        CIVO => "Civo",
        SCALEWAY => "Scaleway",
        VULTR => "Vultr",
        EXOSCALE => "Exoscale",
        _ => "the cloud provider",
    }
}

/// The context name prefix of a provider's clusters (`eks-<region>-<name>`).
pub fn context_prefix(provider: &str) -> &'static str {
    match provider {
        AWS => "eks",
        GCP => "gke",
        AZURE => "aks",
        DIGITALOCEAN => "do",
        LINODE => "lke",
        CIVO => "civo",
        SCALEWAY => "scw",
        VULTR => "vke",
        EXOSCALE => "sks",
        _ => "cloud",
    }
}

/* ------------------------------------------------------- discovery types */

/// A cluster a provider listed.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Found {
    pub name: String,
    /// Region / location / zone, as the provider names it.
    pub region: String,
    /// The provider's id: EKS ARN, GKE self link, AKS resource id, the
    /// cluster id of the API providers.
    pub native_id: Option<String>,
    pub version: Option<String>,
    /// `ACTIVE`, `running`, `RUNNING`, ...
    pub status: Option<String>,
    pub endpoint: Option<String>,
    /// Unix ms.
    pub created_at: Option<i64>,
    /// base64 PEM (EKS, GKE).
    pub certificate_authority: Option<String>,
    /// AKS.
    pub resource_group: Option<String>,
    /// The details are known (else only the name: known details are kept).
    pub described: bool,
}

/// The clusters of one scope (account, project, subscription or the
/// whole connection) in the regions it covers. `complete` = the listing
/// finished, so clusters missing from it are gone.
#[derive(Debug, Clone, PartialEq)]
pub struct Listing {
    /// AWS account, GCP project, Azure subscription; empty for providers
    /// without scopes.
    pub account_id: String,
    pub account_name: Option<String>,
    pub role_name: Option<String>,
    pub profile: Option<String>,
    /// The regions this listing covers; None = every region (listings of
    /// the whole account).
    pub regions: Option<Vec<String>>,
    pub complete: bool,
    pub clusters: Vec<Found>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProgressState {
    Running,
    Done,
    Error,
}

/// A progress update of one scope.
#[derive(Debug, Clone, PartialEq)]
pub struct Progress {
    /// `acme-prod (123456789012) · eu-west-1`, `... · regions`.
    pub scope: String,
    pub account_id: Option<String>,
    pub account_name: Option<String>,
    pub region: Option<String>,
    pub state: ProgressState,
    pub message: Option<String>,
}

impl Progress {
    pub fn of(scope: impl Into<String>, region: Option<&str>, state: ProgressState) -> Progress {
        Progress {
            scope: scope.into(),
            account_id: None,
            account_name: None,
            region: region.map(str::to_string),
            state,
            message: None,
        }
    }

    pub fn account(mut self, id: &str, name: Option<&str>) -> Progress {
        self.account_id = Some(id.to_string()).filter(|i| !i.is_empty());
        self.account_name = name.map(str::to_string);
        self
    }

    pub fn message(mut self, message: impl Into<String>) -> Progress {
        self.message = Some(message.into());
        self
    }
}

pub type ProgressFn = dyn Fn(Progress) + Send + Sync;

/// The outcome of discovering one connection.
#[derive(Debug, Clone, Default)]
pub struct Discovery {
    pub listings: Vec<Listing>,
    /// Who the connection is (the ARN, the CLI account, ...).
    pub identity: Option<String>,
    /// Why nothing (or not everything) could be listed.
    pub error: Option<String>,
    /// The connection needs an interactive sign-in first.
    pub needs_sign_in: bool,
}

impl Discovery {
    /// A discovery that failed up front (reported as one error progress).
    pub fn failed(
        connection: &CloudConnection,
        progress: &ProgressFn,
        message: String,
        needs_sign_in: bool,
    ) -> Discovery {
        progress(
            Progress::of(connection.display_name(), None, ProgressState::Error)
                .message(message.clone()),
        );
        Discovery {
            error: Some(message),
            needs_sign_in,
            ..Discovery::default()
        }
    }
}

/// Whether a cluster in `region` is in the chosen region `wanted`: the
/// same (any case), or one of its zones (`europe-west1-b` in
/// `europe-west1`, GKE zonal clusters).
pub fn region_matches(wanted: &str, region: &str) -> bool {
    if wanted.eq_ignore_ascii_case(region) {
        return true;
    }
    let (w, r) = (wanted.as_bytes(), region.as_bytes());
    r.len() == w.len() + 2
        && r[..w.len()].eq_ignore_ascii_case(w)
        && r[w.len()] == b'-'
        && r[w.len() + 1].is_ascii_lowercase()
}

/// Region filtering of listings that cover every region at once: the
/// connection's regions (None = all) and the clusters in them.
pub fn filter_regions(connection: &CloudConnection, clusters: Vec<Found>) -> Listing {
    let (regions, clusters) = if connection.regions.is_empty() {
        (None, clusters)
    } else {
        let wanted = &connection.regions;
        (
            Some(wanted.clone()),
            clusters
                .into_iter()
                .filter(|c| wanted.iter().any(|r| region_matches(r, &c.region)))
                .collect(),
        )
    };
    Listing {
        account_id: String::new(),
        account_name: None,
        role_name: None,
        profile: None,
        regions,
        complete: true,
        clusters,
    }
}

/// Discovers the clusters of `connection` (never interactive).
pub async fn discover(connection: &CloudConnection, progress: Arc<ProgressFn>) -> Discovery {
    match connection.provider.as_str() {
        AWS => aws::discovery::discover(&aws::context(), connection, progress).await,
        GCP => gcp::discover(connection, progress).await,
        AZURE => azure::discover(connection, progress).await,
        DIGITALOCEAN if connection.kind == ConnectionKind::Cli => {
            doctl::discover(connection, progress).await
        }
        other => match ApiProvider::from_id(other) {
            Some(provider) => api::discover(&context(), provider, connection, progress).await,
            None => Discovery::failed(
                connection,
                &*progress,
                format!("JET Pilot does not know the provider \"{other}\""),
                false,
            ),
        },
    }
}

/* ---------------------------------------------------------- adding */

/// What adding a catalog cluster writes: the cluster (server + CA), the
/// user (an exec plugin, never inline credentials) and the secrets that go
/// to the vault first.
pub struct Prepared {
    pub cluster: Cluster,
    pub user: AuthInfo,
    pub secrets: Vec<(String, serde_json::Value)>,
    /// Identity of the user for duplicate detection (hashed into the
    /// fingerprint).
    pub identity: String,
    pub native_id: Option<String>,
    pub warnings: Vec<String>,
}

impl std::fmt::Debug for Prepared {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Prepared")
            .field("server", &self.cluster.server)
            .field("secrets", &self.secrets.len())
            .field("warnings", &self.warnings)
            .finish()
    }
}

/// The server and base64 CA of a catalog entry, or why it can't be added
/// yet.
pub fn server_and_ca(
    name: &str,
    status: Option<&str>,
    ready: &[&str],
    endpoint: Option<&str>,
    ca: Option<&str>,
) -> Result<(String, String), String> {
    let endpoint = endpoint.filter(|e| !e.is_empty());
    let ca = ca.map(str::trim).filter(|c| !c.is_empty());
    match (endpoint, ca) {
        (Some(endpoint), Some(ca)) => {
            use base64::Engine;
            if base64::engine::general_purpose::STANDARD
                .decode(ca)
                .is_err()
            {
                return Err(format!(
                    "The provider returned an invalid certificate for {name}."
                ));
            }
            Ok((endpoint.to_string(), ca.to_string()))
        }
        _ => Err(not_ready(name, status, ready)),
    }
}

/// `<name> is not ready yet (<status>).` or "refresh the catalog".
pub fn not_ready(name: &str, status: Option<&str>, ready: &[&str]) -> String {
    match status {
        Some(status) if !ready.iter().any(|r| r.eq_ignore_ascii_case(status)) => {
            format!("{name} is not ready yet ({status}).")
        }
        _ => format!("The details of {name} are not known yet. Refresh the catalog and try again."),
    }
}

/* ------------------------------------------------------------- context */

#[cfg(test)]
static TEST_CONTEXT: std::sync::Mutex<Option<CloudContext>> = std::sync::Mutex::new(None);

/// Serialises tests that swap the process-wide AWS / cloud contexts, the
/// catalog paths or the CLI environment.
#[cfg(test)]
pub(crate) static TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Points the cloud API code at a test context (None = the system).
#[cfg(test)]
pub(crate) fn use_test_context(ctx: Option<CloudContext>) {
    *crate::util::lock(&TEST_CONTEXT) = ctx;
}

/// The cloud API environment: the app's vault (with an unlocked passphrase
/// vault's key) and the JET Pilot home's connections.
pub(crate) fn context() -> CloudContext {
    #[cfg(test)]
    if let Some(ctx) = crate::util::lock(&TEST_CONTEXT).clone() {
        return ctx;
    }
    CloudContext::system(crate::secrets::store())
}

/* ------------------------------------------------------------ commands */

/// A project (GCP) or subscription (Azure) a CLI connection can scan.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionScope {
    pub id: String,
    pub name: String,
    pub detail: Option<String>,
}

/// The projects (GCP) or subscriptions (Azure) of a CLI connection, for the
/// scope picker (`targets`). AWS IAM Identity Center uses
/// `aws_sso_accounts`.
#[tauri::command]
pub async fn connection_scopes(connection_id: String) -> Result<Vec<ConnectionScope>, AppError> {
    let connection = crate::clusters::blocking(move || {
        let ctx = aws::context();
        ctx.connection(&connection_id).map_err(AppError::from)
    })
    .await?;
    match (connection.provider.as_str(), connection.kind) {
        (GCP, ConnectionKind::Cli) => gcp::projects(&connection).await,
        (AZURE, ConnectionKind::Cli) => azure::subscriptions(&connection).await,
        _ => Err(AppError::invalid(
            "connectionId",
            "Only Google Cloud and Azure connections have projects or subscriptions to choose.",
        )),
    }
}

/// The regions (Exoscale: zones) of a provider, for the region picker.
#[tauri::command]
pub async fn provider_regions(provider: String) -> Result<Vec<String>, AppError> {
    let mut regions: Vec<String> = match provider.as_str() {
        AWS => aws::regions::EKS_REGIONS
            .iter()
            .map(|r| r.to_string())
            .collect(),
        GCP => gcp::REGIONS.iter().map(|r| r.to_string()).collect(),
        AZURE => azure::REGIONS.iter().map(|r| r.to_string()).collect(),
        other => match ApiProvider::from_id(other) {
            Some(provider) => api::regions(&context(), provider).await,
            None => {
                return Err(AppError::invalid(
                    "provider",
                    format!("JET Pilot can't list the regions of \"{provider}\"."),
                ))
            }
        },
    };
    regions.sort();
    regions.dedup();
    Ok(regions)
}

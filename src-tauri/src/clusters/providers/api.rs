//! Clusters of the REST API providers (DigitalOcean, Akamai, Civo,
//! Scaleway, Vultr, Exoscale), over `jp_auth_core::cloud` with the token
//! or key of the connection from the vault:
//!
//! - discovery: one listing of the whole account (DigitalOcean, Akamai,
//!   Vultr) or one per region / zone (Civo, Scaleway, Exoscale);
//! - adding: DigitalOcean and Exoscale clusters run the helper, which mints
//!   short-lived tokens / client certificates
//!   (`jetpilot-auth credential digitalocean|exoscale`); the others hand
//!   out a kubeconfig with a static credential, which moves to the vault
//!   (`jetpilot-auth credential static`);
//! - credential status of the helper entries without network calls.

use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, Instant};

use futures::stream::{self, StreamExt};
use jp_auth_core::cloud::mint::{self, MintedCredential};
use jp_auth_core::cloud::{
    civo, digitalocean, exoscale, linode, scaleway, vultr, ApiKey, ApiToken, CloudContext,
    CloudError, Provider, RemoteCluster,
};
use jp_auth_core::connections::{api_key_secret_id, api_token_secret_id, CloudConnection};
use jp_auth_core::request::{DigitaloceanArgs, ExoscaleArgs};
use kube::config::{AuthInfo, Cluster};

use super::aws::EntrySession;
use super::{
    filter_regions, not_ready, Discovery, Found, Listing, Prepared, Progress, ProgressFn,
    ProgressState,
};
use crate::clusters::managed_kubeconfig as managed;

/// Region listings running at once.
const REGION_CONCURRENCY: usize = 4;

/// DigitalOcean regions with DOKS (its option list needs a token).
pub const DIGITALOCEAN_REGIONS: &[&str] = &[
    "ams3", "atl1", "blr1", "fra1", "lon1", "nyc1", "nyc3", "sfo2", "sfo3", "sgp1", "syd1", "tor1",
];

/// Statuses in which a cluster can be added.
fn ready_states(provider: Provider) -> &'static [&'static str] {
    match provider {
        Provider::DigitalOcean => &["running", "degraded", "upgrading"],
        Provider::Linode => &["ready"],
        Provider::Civo => &["ACTIVE"],
        Provider::Scaleway => &["ready", "updating", "upgrading"],
        Provider::Vultr => &["active"],
        Provider::Exoscale => &["running", "updating", "upgrading"],
    }
}

/// The region list of a provider (fetched where it's public).
pub async fn regions(ctx: &CloudContext, provider: Provider) -> Vec<String> {
    let fallback = |list: &[&str]| list.iter().map(|r| r.to_string()).collect::<Vec<_>>();
    let fetched = match provider {
        Provider::Linode => linode::regions(ctx).await.ok(),
        Provider::Vultr => vultr::regions(ctx).await.ok(),
        Provider::Exoscale => exoscale::zones(ctx).await.ok(),
        _ => None,
    };
    match fetched.filter(|list| !list.is_empty()) {
        Some(list) => list,
        None => match provider {
            Provider::DigitalOcean => fallback(DIGITALOCEAN_REGIONS),
            Provider::Linode => fallback(linode::REGIONS),
            Provider::Civo => fallback(civo::REGIONS),
            Provider::Scaleway => fallback(scaleway::REGIONS),
            Provider::Vultr => fallback(vultr::REGIONS),
            Provider::Exoscale => fallback(exoscale::ZONES),
        },
    }
}

/* ---------------------------------------------------------- validation */

/// What a token / key validation learned: a label and an identity.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Validated {
    pub label: Option<String>,
    pub identity: Option<String>,
}

/// Checks a token with a cheap authenticated call.
pub async fn validate_token(
    ctx: &CloudContext,
    provider: Provider,
    token: &str,
    project_id: Option<&str>,
) -> Result<Validated, CloudError> {
    Ok(match provider {
        Provider::DigitalOcean => {
            let account = digitalocean::account(ctx, token).await?;
            Validated {
                label: account.team.clone().or(account.email.clone()),
                identity: account.email,
            }
        }
        Provider::Linode => {
            let user = linode::profile(ctx, token).await?;
            Validated {
                label: user.clone(),
                identity: user,
            }
        }
        Provider::Civo => {
            civo::regions(ctx, token).await?;
            Validated::default()
        }
        Provider::Scaleway => {
            scaleway::clusters(ctx, token, scaleway::REGIONS[0], project_id).await?;
            let label = match project_id {
                Some(project) => scaleway::project_name(ctx, token, project)
                    .await
                    .ok()
                    .flatten(),
                None => None,
            };
            Validated {
                label,
                identity: None,
            }
        }
        Provider::Vultr => {
            let name = vultr::account(ctx, token).await?;
            Validated {
                label: name.clone(),
                identity: name,
            }
        }
        Provider::Exoscale => {
            return Err(CloudError::Invalid(
                "Exoscale connections use an API key and secret.".into(),
            ))
        }
    })
}

/// Checks an Exoscale key (it must be able to list SKS clusters).
pub async fn validate_key(ctx: &CloudContext, key: &ApiKey) -> Result<Validated, CloudError> {
    exoscale::clusters(ctx, key, "ch-gva-2").await?;
    let organization = exoscale::organization(ctx, key).await.ok().flatten();
    Ok(Validated {
        label: organization,
        identity: Some(key.key.clone()),
    })
}

/* ----------------------------------------------------------- discovery */

enum Secret {
    Token(ApiToken),
    Key(ApiKey),
}

impl Secret {
    /// The bearer token / X-Auth-Token value.
    fn token(&self) -> &str {
        match self {
            Secret::Token(token) => &token.token,
            Secret::Key(key) => &key.key,
        }
    }

    fn key(&self) -> Option<&ApiKey> {
        match self {
            Secret::Key(key) => Some(key),
            Secret::Token(_) => None,
        }
    }
}

async fn secret(ctx: &CloudContext, provider: Provider, id: &str) -> Result<Secret, CloudError> {
    if provider == Provider::Exoscale {
        ctx.api_key(id).await.map(Secret::Key)
    } else {
        ctx.api_token(id).await.map(Secret::Token)
    }
}

fn found_of(cluster: RemoteCluster) -> Found {
    Found {
        name: cluster.name,
        region: cluster.region,
        native_id: Some(cluster.id),
        version: cluster.version,
        status: cluster.status,
        endpoint: cluster.endpoint,
        created_at: cluster.created_at,
        certificate_authority: None,
        resource_group: None,
        described: true,
    }
}

fn count(clusters: usize) -> String {
    match clusters {
        1 => "1 cluster".to_string(),
        n => format!("{n} clusters"),
    }
}

/// Discovers the clusters of an API connection (never interactive).
pub async fn discover(
    ctx: &CloudContext,
    provider: Provider,
    connection: &CloudConnection,
    progress: Arc<ProgressFn>,
) -> Discovery {
    let label = connection.display_name();
    let secret = match secret(ctx, provider, &connection.id).await {
        Ok(secret) => secret,
        Err(error) => return Discovery::failed(connection, &*progress, error.to_string(), false),
    };
    let mut discovery = Discovery::default();

    // One listing of the whole account.
    if matches!(
        provider,
        Provider::DigitalOcean | Provider::Linode | Provider::Vultr
    ) {
        let scope = format!("{label} · clusters");
        progress(Progress::of(&scope, None, ProgressState::Running));
        let listed = match provider {
            Provider::DigitalOcean => digitalocean::clusters(ctx, secret.token()).await,
            Provider::Linode => linode::clusters(ctx, secret.token()).await,
            _ => vultr::clusters(ctx, secret.token()).await,
        };
        match listed {
            Ok(clusters) => {
                let listing =
                    filter_regions(connection, clusters.into_iter().map(found_of).collect());
                progress(
                    Progress::of(&scope, None, ProgressState::Done)
                        .message(count(listing.clusters.len())),
                );
                discovery.listings.push(listing);
            }
            Err(error) => {
                progress(
                    Progress::of(&scope, None, ProgressState::Error).message(error.to_string()),
                );
                discovery.error = Some(error.to_string());
            }
        }
        return discovery;
    }

    // One listing per region / zone.
    let regions: Vec<String> = if !connection.regions.is_empty() {
        connection.regions.clone()
    } else if provider == Provider::Civo {
        match civo::regions(ctx, secret.token()).await {
            Ok(regions) if !regions.is_empty() => regions,
            Ok(_) => civo::REGIONS.iter().map(|r| r.to_string()).collect(),
            Err(error) => {
                return Discovery::failed(connection, &*progress, error.to_string(), false)
            }
        }
    } else if provider == Provider::Scaleway {
        scaleway::REGIONS.iter().map(|r| r.to_string()).collect()
    } else {
        exoscale::ZONES.iter().map(|z| z.to_string()).collect()
    };
    let secret = Arc::new(secret);
    let project = connection.project_id.clone();
    let listings: Vec<(Listing, Option<String>)> =
        stream::iter(regions.into_iter().map(|region| {
            let (secret, progress, project, label) = (
                secret.clone(),
                progress.clone(),
                project.clone(),
                label.clone(),
            );
            async move {
                let scope = format!("{label} · {region}");
                progress(Progress::of(&scope, Some(&region), ProgressState::Running));
                let listed = match provider {
                    Provider::Civo => civo::clusters(ctx, secret.token(), &region).await,
                    Provider::Scaleway => {
                        scaleway::clusters(ctx, secret.token(), &region, project.as_deref()).await
                    }
                    _ => match secret.key() {
                        Some(key) => exoscale::clusters(ctx, key, &region).await,
                        None => Err(CloudError::Invalid("No API key".into())),
                    },
                };
                let (complete, clusters, error) = match listed {
                    Ok(clusters) => {
                        progress(
                            Progress::of(&scope, Some(&region), ProgressState::Done)
                                .message(count(clusters.len())),
                        );
                        (true, clusters.into_iter().map(found_of).collect(), None)
                    }
                    Err(error) => {
                        progress(
                            Progress::of(&scope, Some(&region), ProgressState::Error)
                                .message(error.to_string()),
                        );
                        (false, Vec::new(), Some(error.to_string()))
                    }
                };
                (
                    Listing {
                        account_id: String::new(),
                        account_name: None,
                        role_name: None,
                        profile: None,
                        regions: Some(vec![region]),
                        complete,
                        clusters,
                    },
                    error,
                )
            }
        }))
        .buffer_unordered(REGION_CONCURRENCY)
        .collect()
        .await;
    for (listing, error) in listings {
        if let Some(error) = error {
            discovery.error.get_or_insert(error);
        }
        discovery.listings.push(listing);
    }
    discovery
}

/* -------------------------------------------------------------- adding */

/// A catalog cluster to add.
#[derive(Debug, Clone)]
pub struct AddTarget {
    /// The managed cluster id (`do-…`).
    pub cluster_id: String,
    /// The provider's cluster id.
    pub native_id: String,
    pub name: String,
    pub region: String,
    pub status: Option<String>,
    pub endpoint: Option<String>,
}

fn message(error: CloudError) -> String {
    error.to_string()
}

/// A managed entry from a provider kubeconfig: the cluster as it is (CA
/// inlined), the credential moved to the vault (`credential static`).
pub fn static_entry(text: &str, cluster_id: &str, helper: &Path) -> Result<Prepared, String> {
    let config = managed::parse(text)
        .map_err(|e| format!("The provider returned a kubeconfig JET Pilot can't read: {e}"))?;
    entry_from_kubeconfig(&config, cluster_id, helper, &|c| which::which(c).ok())
}

/// The current (else first) context of a provider-made kubeconfig as a
/// managed entry, converted like a kubeconfig import: tokens and client
/// certificates move to the vault, exec plugins get absolute commands
/// (`resolve`).
pub fn entry_from_kubeconfig(
    config: &kube::config::Kubeconfig,
    cluster_id: &str,
    helper: &Path,
    resolve: &dyn Fn(&str) -> Option<std::path::PathBuf>,
) -> Result<Prepared, String> {
    let named = config
        .current_context
        .as_deref()
        .and_then(|current| config.contexts.iter().find(|c| c.name == current))
        .or_else(|| config.contexts.first())
        .ok_or("The provider returned a kubeconfig without a context.")?;
    let context = named.context.clone().unwrap_or_default();
    let cluster = config
        .clusters
        .iter()
        .find(|c| c.name == context.cluster)
        .and_then(|c| c.cluster.as_ref());
    let user = context.user.as_deref().and_then(|name| {
        config
            .auth_infos
            .iter()
            .find(|u| u.name == name)
            .and_then(|u| u.auth_info.as_ref())
    });
    let cluster: Cluster =
        crate::clusters::import::convert_cluster(cluster).map_err(|e| e.message)?;
    if cluster.server.as_deref().is_none_or(str::is_empty) {
        return Err("The provider's kubeconfig has no API server.".to_string());
    }
    let identity = managed::identity_of(user);
    let (user, secrets) = crate::clusters::import::convert_user(cluster_id, user, helper, resolve)
        .map_err(|e| e.message)?;
    if user.exec.is_none() {
        return Err("The provider's kubeconfig has no credentials.".to_string());
    }
    Ok(Prepared {
        cluster,
        user,
        secrets,
        identity,
        native_id: None,
        warnings: Vec::new(),
    })
}

fn helper_user(exec: kube::config::ExecConfig) -> AuthInfo {
    AuthInfo {
        exec: Some(exec),
        ..AuthInfo::default()
    }
}

/// Prepares a catalog cluster of an API connection for the managed
/// kubeconfig (network: tokens, CAs, kubeconfigs).
pub async fn prepare(
    ctx: &CloudContext,
    provider: Provider,
    connection: &CloudConnection,
    target: &AddTarget,
    helper: &Path,
) -> Result<Prepared, String> {
    let secret = secret(ctx, provider, &connection.id)
        .await
        .map_err(message)?;
    let not_ready_yet = |error: CloudError| match error {
        CloudError::NotReady(_) => not_ready(
            &target.name,
            target.status.as_deref(),
            ready_states(provider),
        ),
        other => message(other),
    };
    let mut prepared = match provider {
        Provider::DigitalOcean => {
            let minted = digitalocean::credentials(
                ctx,
                secret.token(),
                &target.native_id,
                mint::DIGITALOCEAN_TOKEN_TTL,
            )
            .await
            .map_err(message)?;
            let ca = minted.certificate_authority.clone().ok_or_else(|| {
                format!("DigitalOcean returned no certificate for {}.", target.name)
            })?;
            // The token is good for an hour: the first kubectl run uses it.
            mint::remember(
                ctx,
                mint::digitalocean_cache_id(&connection.id, &target.native_id),
                &minted.credential,
            )
            .await;
            let args = DigitaloceanArgs {
                connection: connection.id.clone(),
                cluster: target.native_id.clone(),
            };
            jp_auth_core::request::parse(jp_auth_core::request::digitalocean_args(&args))
                .map_err(|e| e.0)?;
            Prepared {
                cluster: Cluster {
                    server: Some(minted.server.clone()),
                    certificate_authority_data: Some(ca),
                    ..Cluster::default()
                },
                user: helper_user(managed::digitalocean_exec(&args, helper)),
                secrets: Vec::new(),
                identity: format!("digitalocean:{}", connection.id),
                native_id: None,
                warnings: Vec::new(),
            }
        }
        Provider::Exoscale => {
            let endpoint = target
                .endpoint
                .clone()
                .filter(|e| !e.is_empty())
                .ok_or_else(|| {
                    not_ready(
                        &target.name,
                        target.status.as_deref(),
                        ready_states(provider),
                    )
                })?;
            let key = secret.key().ok_or("No API key")?;
            let ca = exoscale::certificate_authority(ctx, key, &target.region, &target.native_id)
                .await
                .map_err(message)?;
            let args = ExoscaleArgs {
                connection: connection.id.clone(),
                zone: target.region.clone(),
                cluster: target.native_id.clone(),
            };
            jp_auth_core::request::parse(jp_auth_core::request::exoscale_args(&args))
                .map_err(|e| e.0)?;
            let settings = connection.exoscale_settings();
            Prepared {
                cluster: Cluster {
                    server: Some(endpoint),
                    certificate_authority_data: Some(ca),
                    ..Cluster::default()
                },
                user: helper_user(managed::exoscale_exec(&args, helper)),
                secrets: Vec::new(),
                identity: format!(
                    "exoscale:{}:{}:{}",
                    connection.id,
                    settings.user,
                    settings.groups.join(",")
                ),
                native_id: None,
                warnings: Vec::new(),
            }
        }
        Provider::Linode | Provider::Civo | Provider::Scaleway | Provider::Vultr => {
            let text = match provider {
                Provider::Linode => {
                    linode::kubeconfig(ctx, secret.token(), &target.native_id).await
                }
                Provider::Civo => {
                    civo::kubeconfig(ctx, secret.token(), &target.region, &target.native_id).await
                }
                Provider::Scaleway => {
                    scaleway::kubeconfig(ctx, secret.token(), &target.region, &target.native_id)
                        .await
                }
                _ => vultr::kubeconfig(ctx, secret.token(), &target.native_id).await,
            }
            .map_err(not_ready_yet)?;
            static_entry(&text, &target.cluster_id, helper)?
        }
    };
    prepared.native_id = Some(target.native_id.clone());
    Ok(prepared)
}

/* -------------------------------------------------------------- minting */

/// A DigitalOcean token for a helper entry, minted in-process.
pub async fn mint_digitalocean(args: &DigitaloceanArgs) -> Result<MintedCredential, CloudError> {
    mint::digitalocean(&super::context(), args).await
}

/// An Exoscale client certificate for a helper entry, minted in-process.
pub async fn mint_exoscale(args: &ExoscaleArgs) -> Result<MintedCredential, CloudError> {
    mint::exoscale(&super::context(), args).await
}

/* --------------------------------------------------------------- status */

type StatusCache = HashMap<String, (Instant, EntrySession)>;

static STATUS_CACHE: std::sync::Mutex<Option<StatusCache>> = std::sync::Mutex::new(None);

/// Forgets cached entry statuses (after a connection change).
pub(crate) fn forget_entry_statuses() {
    *crate::util::lock(&STATUS_CACHE) = None;
}

/// The credential state of a helper `digitalocean` / `exoscale` entry
/// without network calls: a cached minted credential's expiry, else
/// whether the connection's token / key is stored. Cached for a few
/// seconds (the hub asks for many contexts at once).
pub(crate) fn entry_status(provider: Provider, connection_id: &str, cluster: &str) -> EntrySession {
    let key = format!("{}\0{connection_id}\0{cluster}", provider.id());
    if let Some((at, session)) = crate::util::lock(&STATUS_CACHE)
        .get_or_insert_with(HashMap::new)
        .get(&key)
    {
        if at.elapsed() < Duration::from_secs(3) {
            return *session;
        }
    }
    let session = compute_entry_status(&super::context(), provider, connection_id, cluster);
    crate::util::lock(&STATUS_CACHE)
        .get_or_insert_with(HashMap::new)
        .insert(key, (Instant::now(), session));
    session
}

pub(crate) fn compute_entry_status(
    ctx: &CloudContext,
    provider: Provider,
    connection_id: &str,
    cluster: &str,
) -> EntrySession {
    if ctx.connection(connection_id).is_err() {
        return EntrySession::Missing;
    }
    let cache_id = match provider {
        Provider::Exoscale => mint::exoscale_cache_id(connection_id, cluster),
        _ => mint::digitalocean_cache_id(connection_id, cluster),
    };
    let now = jp_auth_core::now_secs();
    if let Some(cached) =
        jp_auth_core::cache::get::<MintedCredential>(&ctx.store, &cache_id, now, 0)
    {
        return EntrySession::Expires(cached.expires_at);
    }
    let secret_id = match provider {
        Provider::Exoscale => api_key_secret_id(connection_id),
        _ => api_token_secret_id(connection_id),
    };
    match ctx.store.get(&secret_id) {
        Ok(Some(_)) => EntrySession::Ongoing,
        Ok(None) => EntrySession::Missing,
        Err(_) => EntrySession::Unknown,
    }
}

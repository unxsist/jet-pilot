//! EKS discovery of a connection: credentials per scope (SSO account +
//! role, or the profile / keys identity), the regions to scan (the
//! connection's, else the enabled ones), then `ListClusters` +
//! `DescribeCluster` with six regions at a time. Never interactive: a
//! connection that needs a sign-in is skipped with a message.

use std::sync::Arc;

use futures::stream::{self, StreamExt};
use jp_auth_core::aws::creds::{self, AwsCredentials};
use jp_auth_core::aws::{AwsContext, AwsError};
use jp_auth_core::aws_client_config;
use jp_auth_core::connections::{CloudConnection, ConnectionKind};

use super::regions;

/// Region listings running at once.
const REGION_CONCURRENCY: usize = 6;
/// `DescribeCluster` calls at once per region.
const DESCRIBE_CONCURRENCY: usize = 8;

/// A cluster EKS reported.
#[derive(Debug, Clone, PartialEq)]
pub struct DiscoveredCluster {
    pub name: String,
    pub arn: Option<String>,
    pub version: Option<String>,
    pub status: Option<String>,
    pub endpoint: Option<String>,
    /// Unix ms.
    pub created_at: Option<i64>,
    /// base64 PEM.
    pub certificate_authority: Option<String>,
    /// DescribeCluster worked (else only the name is known).
    pub described: bool,
}

/// The clusters of one account + region. `complete` = the listing
/// finished, so clusters missing from it are gone.
#[derive(Debug, Clone, PartialEq)]
pub struct Listing {
    pub account_id: String,
    pub account_name: Option<String>,
    pub role_name: Option<String>,
    pub profile: Option<String>,
    pub region: String,
    pub complete: bool,
    pub clusters: Vec<DiscoveredCluster>,
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

/// The outcome of discovering one connection.
#[derive(Debug, Clone, Default)]
pub struct Discovery {
    pub listings: Vec<Listing>,
    /// The ARN `GetCallerIdentity` returned (profile / key connections).
    pub identity: Option<String>,
    /// Why nothing (or not everything) could be listed.
    pub error: Option<String>,
    /// The connection needs an interactive sign-in first.
    pub needs_sign_in: bool,
}

/// Where a scope's credentials come from.
#[derive(Debug, Clone)]
struct Scope {
    account_id: Option<String>,
    account_name: Option<String>,
    role_name: Option<String>,
    profile: Option<String>,
}

impl Scope {
    fn display(&self) -> String {
        match (&self.account_name, &self.account_id) {
            (Some(name), Some(id)) if name != id => format!("{name} ({id})"),
            (_, Some(id)) => id.clone(),
            (Some(name), None) => name.clone(),
            (None, None) => self
                .profile
                .clone()
                .unwrap_or_else(|| "account".to_string()),
        }
    }

    fn progress(
        &self,
        what: &str,
        region: Option<&str>,
        state: ProgressState,
        message: Option<String>,
    ) -> Progress {
        Progress {
            scope: format!("{} · {what}", self.display()),
            account_id: self.account_id.clone(),
            account_name: self.account_name.clone(),
            region: region.map(str::to_string),
            state,
            message,
        }
    }
}

pub type ProgressFn = dyn Fn(Progress) + Send + Sync;

/// The message for a connection that needs a person.
pub fn sign_in_message(connection: &CloudConnection, error: &AwsError) -> String {
    match error {
        AwsError::MfaRequired(_) => format!(
            "Enter an MFA code for {} to discover its clusters",
            connection.display_name()
        ),
        _ => format!(
            "Sign in to {} to discover its clusters",
            connection.display_name()
        ),
    }
}

fn eks_client(ctx: &AwsContext, region: &str, credentials: &AwsCredentials) -> aws_sdk_eks::Client {
    let builder = aws_client_config!(
        aws_sdk_eks::Config::builder(),
        ctx,
        region,
        ctx.endpoints.eks.as_deref()
    )
    .credentials_provider(credentials.to_sdk());
    aws_sdk_eks::Client::from_conf(builder.build())
}

fn eks_error<E, R>(error: aws_sdk_eks::error::SdkError<E, R>) -> AwsError
where
    E: aws_sdk_eks::error::ProvideErrorMetadata + std::error::Error + Send + Sync + 'static,
    R: std::fmt::Debug,
{
    use aws_sdk_eks::error::{DisplayErrorContext, SdkError};
    match &error {
        SdkError::ServiceError(service) => {
            let err = service.err();
            AwsError::Service {
                code: err.code().map(str::to_string),
                message: jp_auth_core::redact(
                    err.message().or(err.code()).unwrap_or("the request failed"),
                ),
            }
        }
        SdkError::TimeoutError(_) => AwsError::Network("AWS did not answer in time".to_string()),
        _ => AwsError::Network(jp_auth_core::redact(&format!(
            "AWS could not be reached: {}",
            DisplayErrorContext(&error)
        ))),
    }
}

/// `ListClusters` (all pages) + `DescribeCluster` of each. A failed
/// describe keeps the name (the listing stays complete).
pub async fn list_region(
    ctx: &AwsContext,
    credentials: &AwsCredentials,
    region: &str,
) -> Result<Vec<DiscoveredCluster>, AwsError> {
    let client = eks_client(ctx, region, credentials);
    let mut names = Vec::new();
    let mut next: Option<String> = None;
    loop {
        let page = client
            .list_clusters()
            .max_results(100)
            .set_next_token(next.take())
            .send()
            .await
            .map_err(eks_error)?;
        names.extend(page.clusters().iter().cloned());
        match page.next_token() {
            Some(token) if !token.is_empty() => next = Some(token.to_string()),
            _ => break,
        }
    }
    let described: Vec<DiscoveredCluster> = stream::iter(names.into_iter().map(|name| {
        let client = client.clone();
        async move {
            match client.describe_cluster().name(&name).send().await {
                Ok(output) => match output.cluster() {
                    Some(cluster) => DiscoveredCluster {
                        name: cluster.name().unwrap_or(&name).to_string(),
                        arn: cluster.arn().map(str::to_string),
                        version: cluster.version().map(str::to_string),
                        status: cluster.status().map(|s| s.as_str().to_string()),
                        endpoint: cluster.endpoint().map(str::to_string),
                        created_at: cluster.created_at().and_then(|t| t.to_millis().ok()),
                        certificate_authority: cluster
                            .certificate_authority()
                            .and_then(|ca| ca.data())
                            .map(str::to_string),
                        described: true,
                    },
                    None => bare(name),
                },
                Err(_) => bare(name),
            }
        }
    }))
    .buffered(DESCRIBE_CONCURRENCY)
    .collect()
    .await;
    Ok(described)
}

fn bare(name: String) -> DiscoveredCluster {
    DiscoveredCluster {
        name,
        arn: None,
        version: None,
        status: None,
        endpoint: None,
        created_at: None,
        certificate_authority: None,
        described: false,
    }
}

/// The regions of a scope: the connection's, else the enabled ones
/// (`DescribeRegions`), else the default list of the partition.
async fn scope_regions(
    ctx: &AwsContext,
    connection: &CloudConnection,
    scope: &Scope,
    credentials: &AwsCredentials,
    progress: &ProgressFn,
) -> Vec<String> {
    if !connection.regions.is_empty() {
        return connection.regions.clone();
    }
    let home = connection.home_region();
    progress(scope.progress("regions", None, ProgressState::Running, None));
    match regions::describe_regions(ctx, credentials, &home).await {
        Ok(found) => {
            progress(scope.progress("regions", None, ProgressState::Done, None));
            found
        }
        Err(error) => {
            // Roles without ec2:DescribeRegions: scan the default regions.
            progress(scope.progress(
                "regions",
                None,
                ProgressState::Done,
                Some(format!("Scanning the default regions ({error})")),
            ));
            regions::fallback_regions(&home)
        }
    }
}

/// Discovers the clusters of `connection`.
pub async fn discover(
    ctx: &AwsContext,
    connection: &CloudConnection,
    progress: Arc<ProgressFn>,
) -> Discovery {
    let mut discovery = Discovery::default();
    let label = Scope {
        account_id: None,
        account_name: Some(connection.display_name()),
        role_name: None,
        profile: None,
    };

    // Credentials per scope.
    let mut scopes: Vec<(Scope, AwsCredentials)> = Vec::new();
    match connection.kind {
        ConnectionKind::Sso => {
            if connection.targets.is_empty() {
                let message = format!(
                    "Choose the accounts and roles of {} to scan",
                    connection.display_name()
                );
                progress(Progress {
                    scope: connection.display_name(),
                    account_id: None,
                    account_name: None,
                    region: None,
                    state: ProgressState::Error,
                    message: Some(message.clone()),
                });
                discovery.error = Some(message);
                return discovery;
            }
            let Some(sso) = &connection.sso else {
                discovery.error = Some("The connection has no start URL".to_string());
                return discovery;
            };
            // One session check up front: no sign-in, no scanning.
            if let Err(error) =
                jp_auth_core::aws::session::access_token(ctx, Some(&connection.id), &sso.start_url)
                    .await
            {
                let needs_sign_in = matches!(error, AwsError::SignInRequired(_));
                let message = if needs_sign_in {
                    sign_in_message(connection, &error)
                } else {
                    error.to_string()
                };
                progress(Progress {
                    scope: connection.display_name(),
                    account_id: None,
                    account_name: None,
                    region: None,
                    state: ProgressState::Error,
                    message: Some(message.clone()),
                });
                discovery.needs_sign_in = needs_sign_in;
                discovery.error = Some(message);
                return discovery;
            }
            for target in &connection.targets {
                let scope = Scope {
                    account_id: Some(target.account_id.clone()),
                    account_name: target.account_name.clone(),
                    role_name: Some(target.role_name.clone()),
                    profile: None,
                };
                match creds::sso_role(ctx, connection, &target.account_id, &target.role_name).await
                {
                    Ok(credentials) => scopes.push((scope, credentials)),
                    Err(error) => {
                        if matches!(error, AwsError::SignInRequired(_)) {
                            discovery.needs_sign_in = true;
                        }
                        let message =
                            format!("{} as {}: {error}", scope.display(), target.role_name);
                        progress(scope.progress(
                            "credentials",
                            None,
                            ProgressState::Error,
                            Some(error.to_string()),
                        ));
                        discovery.error.get_or_insert(message);
                    }
                }
            }
        }
        ConnectionKind::Profile | ConnectionKind::Keys => {
            let credentials = match creds::for_connection(ctx, connection, None, None).await {
                Ok(credentials) => credentials,
                Err(error) => {
                    let interactive = matches!(
                        error,
                        AwsError::SignInRequired(_) | AwsError::MfaRequired(_)
                    );
                    let message = if interactive {
                        sign_in_message(connection, &error)
                    } else {
                        error.to_string()
                    };
                    progress(label.progress(
                        "credentials",
                        None,
                        ProgressState::Error,
                        Some(message.clone()),
                    ));
                    discovery.needs_sign_in = interactive;
                    discovery.error = Some(message);
                    return discovery;
                }
            };
            match creds::caller_identity(ctx, &credentials, &connection.home_region()).await {
                Ok((account, arn)) => {
                    discovery.identity = Some(arn);
                    scopes.push((
                        Scope {
                            account_id: Some(account),
                            account_name: None,
                            role_name: None,
                            profile: connection.profile.clone(),
                        },
                        credentials,
                    ));
                }
                Err(error) => {
                    let message = error.to_string();
                    progress(label.progress(
                        "credentials",
                        None,
                        ProgressState::Error,
                        Some(message.clone()),
                    ));
                    discovery.error = Some(message);
                    return discovery;
                }
            }
        }
        ConnectionKind::Cli | ConnectionKind::Token | ConnectionKind::ApiKey => {
            discovery.error = Some("This is not an AWS connection".to_string());
            return discovery;
        }
    }

    // Regions per scope, then every (scope, region) listing, six at a time.
    let mut jobs = Vec::new();
    for (scope, credentials) in scopes {
        let regions = scope_regions(ctx, connection, &scope, &credentials, &*progress).await;
        let credentials = Arc::new(credentials);
        for region in regions {
            jobs.push((scope.clone(), credentials.clone(), region));
        }
    }
    let listings: Vec<Listing> =
        stream::iter(jobs.into_iter().map(|(scope, credentials, region)| {
            let progress = progress.clone();
            let ctx = ctx.clone();
            async move {
                progress(scope.progress(&region, Some(&region), ProgressState::Running, None));
                let result = list_region(&ctx, &credentials, &region).await;
                let (complete, clusters) = match result {
                    Ok(clusters) => {
                        let count = clusters.len();
                        progress(scope.progress(
                            &region,
                            Some(&region),
                            ProgressState::Done,
                            Some(match count {
                                1 => "1 cluster".to_string(),
                                n => format!("{n} clusters"),
                            }),
                        ));
                        (true, clusters)
                    }
                    Err(error) => {
                        progress(scope.progress(
                            &region,
                            Some(&region),
                            ProgressState::Error,
                            Some(error.to_string()),
                        ));
                        (false, Vec::new())
                    }
                };
                Listing {
                    account_id: scope.account_id.clone().unwrap_or_default(),
                    account_name: scope.account_name.clone(),
                    role_name: scope.role_name.clone(),
                    profile: scope.profile.clone(),
                    region,
                    complete,
                    clusters,
                }
            }
        }))
        .buffer_unordered(REGION_CONCURRENCY)
        .collect()
        .await;
    discovery.listings = listings;
    discovery
}

//! Cloud connections (`~/.kube/jet-pilot/connections.json`, see
//! `jp_auth_core::connections`): AWS IAM Identity Center, `~/.aws`
//! profiles and access keys; the signed-in user of `gcloud`, `az` or
//! `doctl`; API tokens (DigitalOcean, Akamai, Civo, Scaleway, Vultr) and
//! Exoscale API keys. Secrets go to the vault; listing computes each
//! connection's state without prompts (CLI connections from the CLI's
//! status, cached for a minute).

use std::collections::BTreeSet;

use jp_auth_core::aws::creds::{self, StoredKeys};
use jp_auth_core::aws::AwsContext;
use jp_auth_core::cloud::{CloudError, Provider as ApiProvider};
use jp_auth_core::connections::{
    self as store, api_key_secret_id, api_token_secret_id, keys_secret_id, CloudConnection,
    ConnectionKind, ConnectionStatus, ExoscaleSettings, SsoSettings, SsoTarget,
};
use jp_auth_core::request::{valid_account_id, valid_profile_name, valid_region, valid_role_name};
use serde::Deserialize;
use tracing::info;

use super::error::AppError;
use super::managed_kubeconfig as managed;
use super::providers::{self, api, aws, cli, gcp};

#[derive(Clone, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ConnectionSpec {
    Sso {
        #[serde(default)]
        label: Option<String>,
        start_url: String,
        region: String,
    },
    Profile {
        #[serde(default)]
        label: Option<String>,
        profile: String,
    },
    Keys {
        #[serde(default)]
        label: Option<String>,
        access_key_id: String,
        secret_access_key: String,
        #[serde(default)]
        session_token: Option<String>,
        region: String,
    },
    /// The signed-in user of `gcloud` (gcp), `az` (azure) or `doctl`
    /// (digitalocean).
    Cli {
        provider: String,
        #[serde(default)]
        label: Option<String>,
        /// The gcloud account / az user / doctl context (None = current).
        #[serde(default)]
        cli_account: Option<String>,
    },
    /// An API token: digitalocean, linode, civo, scaleway (with an optional
    /// project), vultr.
    Token {
        provider: String,
        #[serde(default)]
        label: Option<String>,
        token: String,
        #[serde(default)]
        project_id: Option<String>,
    },
    /// An Exoscale API key and secret.
    ApiKey {
        #[serde(default)]
        provider: Option<String>,
        #[serde(default)]
        label: Option<String>,
        key: String,
        secret: String,
        #[serde(default)]
        user: Option<String>,
        #[serde(default)]
        groups: Option<Vec<String>>,
    },
}

impl std::fmt::Debug for ConnectionSpec {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ConnectionSpec::Sso {
                start_url, region, ..
            } => write!(f, "Sso({start_url}, {region})"),
            ConnectionSpec::Profile { profile, .. } => write!(f, "Profile({profile})"),
            ConnectionSpec::Keys { region, .. } => write!(f, "Keys(<redacted>, {region})"),
            ConnectionSpec::Cli {
                provider,
                cli_account,
                ..
            } => write!(f, "Cli({provider}, {cli_account:?})"),
            ConnectionSpec::Token { provider, .. } => write!(f, "Token({provider}, <redacted>)"),
            ConnectionSpec::ApiKey { key, .. } => write!(f, "ApiKey({key}, <redacted>)"),
        }
    }
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionPatch {
    #[serde(default)]
    pub label: Option<String>,
    #[serde(default)]
    pub regions: Option<Vec<String>>,
    #[serde(default)]
    pub targets: Option<Vec<SsoTarget>>,
    /// Exoscale: who minted client certificates are for.
    #[serde(default)]
    pub exoscale: Option<ExoscaleSettings>,
}

fn vault_error(e: jp_auth_core::vault::VaultError) -> AppError {
    AppError::from(jp_auth_core::aws::AwsError::Vault(e))
}

fn load(ctx: &AwsContext) -> Result<Vec<CloudConnection>, AppError> {
    store::load(&ctx.connections_file).map_err(|e| AppError::io("The connections can't be read", e))
}

/// The state of a CLI connection from the CLI's last known status.
fn cli_state(
    connection: &CloudConnection,
) -> Option<(ConnectionStatus, Option<i64>, Option<String>)> {
    let tool = cli::CliTool::for_provider(&connection.provider)?;
    let status = cli::cached_status(tool)?;
    let account = connection.cli_account.as_deref().filter(|a| !a.is_empty());
    Some(if !status.installed {
        (
            ConnectionStatus::Error,
            None,
            Some(format!(
                "{} is not installed. Install it from {}.",
                tool.binary(),
                tool.install_url()
            )),
        )
    } else if !status.signed_in {
        (ConnectionStatus::SignedOut, None, status.message.clone())
    } else if account.is_some_and(|a| !status.accounts.iter().any(|x| x == a)) {
        (
            ConnectionStatus::SignedOut,
            None,
            Some(format!(
                "{} is not signed in as {}",
                tool.binary(),
                account.unwrap_or_default()
            )),
        )
    } else {
        (ConnectionStatus::SignedIn, None, None)
    })
}

/// The connection with its state computed (no network, no prompts).
pub(crate) fn with_status(ctx: &AwsContext, mut connection: CloudConnection) -> CloudConnection {
    let computed = match connection.kind {
        ConnectionKind::Sso | ConnectionKind::Profile | ConnectionKind::Keys => {
            Some(aws::credential_state(ctx, &connection))
        }
        ConnectionKind::Cli => cli_state(&connection),
        // The key / token is in the vault; failures are recorded by use.
        ConnectionKind::Token | ConnectionKind::ApiKey => {
            Some((ConnectionStatus::SignedIn, None, None))
        }
    };
    let Some((status, expires_at, message)) = computed else {
        return connection;
    };
    // A failed discovery is kept until the next one succeeds, unless the
    // connection is signed out meanwhile.
    if status == ConnectionStatus::SignedIn && connection.status == ConnectionStatus::Error {
        connection.expires_at = expires_at;
        return connection;
    }
    connection.status = status;
    connection.expires_at = expires_at;
    connection.message = message;
    connection
}

/// Refreshes the (cached) status of the CLIs `connections` use.
async fn refresh_cli_statuses(connections: &[CloudConnection], max_age: std::time::Duration) {
    let tools: BTreeSet<&str> = connections
        .iter()
        .filter(|c| c.kind == ConnectionKind::Cli)
        .map(|c| c.provider.as_str())
        .collect();
    let checks = tools
        .into_iter()
        .filter_map(cli::CliTool::for_provider)
        .map(|tool| cli::status(tool, max_age));
    futures::future::join_all(checks).await;
}

/// One connection (with status).
pub(crate) fn get(id: &str) -> Result<CloudConnection, AppError> {
    let ctx = aws::context();
    let connection = load(&ctx)?
        .into_iter()
        .find(|c| c.id == id)
        .ok_or_else(|| AppError::not_found("This connection no longer exists."))?;
    Ok(with_status(&ctx, connection))
}

/// Records the outcome of using a connection: `Ok(identity)` clears a
/// previous error (and stores the identity when given), `Err(message)`
/// marks it as failing.
pub(crate) fn record_status(
    id: &str,
    outcome: Result<Option<String>, String>,
) -> Result<(), AppError> {
    let ctx = aws::context();
    store::update::<_, AppError>(&ctx.connections_file, |list| {
        if let Some(connection) = list.iter_mut().find(|c| c.id == id) {
            match outcome {
                Ok(identity) => {
                    if connection.status == ConnectionStatus::Error {
                        connection.status = ConnectionStatus::SignedIn;
                    }
                    connection.message = None;
                    if identity.is_some() {
                        connection.identity = identity;
                    }
                }
                Err(message) => {
                    connection.status = ConnectionStatus::Error;
                    connection.message = Some(jp_auth_core::redact(&message));
                }
            }
        }
        Ok(())
    })
}

fn clean_label(label: Option<String>) -> Option<String> {
    label
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
        .map(|l| l.chars().take(100).collect())
}

/// A start URL: https with a host, no credentials, query or fragment.
fn validate_start_url(start_url: &str) -> Result<String, AppError> {
    let start_url = start_url.trim();
    let url = tauri::Url::parse(start_url).map_err(|_| {
        AppError::invalid(
            "startUrl",
            "Enter the AWS access portal URL, such as https://my-company.awsapps.com/start.",
        )
    })?;
    if url.scheme() != "https" || url.host_str().is_none_or(str::is_empty) {
        return Err(AppError::invalid(
            "startUrl",
            "The access portal URL must start with https://.",
        ));
    }
    if !url.username().is_empty() || url.password().is_some() || url.fragment().is_some() {
        return Err(AppError::invalid(
            "startUrl",
            "The access portal URL can't contain a user name, password or fragment.",
        ));
    }
    Ok(start_url.to_string())
}

fn validate_region(region: &str, field: &str) -> Result<String, AppError> {
    let region = region.trim();
    if valid_region(region) {
        Ok(region.to_string())
    } else {
        Err(AppError::invalid(
            field,
            format!("\"{region}\" is not an AWS region."),
        ))
    }
}

/// A region (zone, location) of another provider: 1-40 of `[A-Za-z0-9-]`.
fn validate_cloud_region(provider: &str, region: &str) -> Result<String, AppError> {
    let region = region.trim();
    let ok = !region.is_empty()
        && region.len() <= 40
        && !region.starts_with('-')
        && region
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-');
    let ok = ok
        && (provider != providers::SCALEWAY
            || jp_auth_core::cloud::scaleway::REGIONS.contains(&region));
    if ok {
        Ok(region.to_string())
    } else {
        Err(AppError::invalid(
            "regions",
            format!(
                "\"{region}\" is not a {} region.",
                providers::display_name(provider)
            ),
        ))
    }
}

/// An account / user / context name of a CLI: printable, no flags.
fn validate_cli_account(account: Option<String>) -> Result<Option<String>, AppError> {
    let Some(account) = account
        .map(|a| a.trim().to_string())
        .filter(|a| !a.is_empty())
    else {
        return Ok(None);
    };
    if account.len() > 256
        || account.starts_with('-')
        || account.chars().any(|c| c.is_control() || c.is_whitespace())
    {
        return Err(AppError::invalid(
            "cliAccount",
            "This is not an account of the CLI.",
        ));
    }
    Ok(Some(account))
}

/// Exoscale certificate identity: a user and its groups (Kubernetes RBAC
/// subjects).
fn validate_exoscale(settings: ExoscaleSettings) -> Result<ExoscaleSettings, AppError> {
    let name_ok =
        |name: &str| !name.is_empty() && name.len() <= 128 && !name.chars().any(|c| c.is_control());
    let user = settings.user.trim().to_string();
    if !name_ok(&user) {
        return Err(AppError::invalid(
            "exoscale.user",
            "Enter the Kubernetes user the certificates are for.",
        ));
    }
    let mut groups = Vec::new();
    for group in settings.groups {
        let group = group.trim().to_string();
        if !name_ok(&group) {
            return Err(AppError::invalid(
                "exoscale.groups",
                "Group names can't be empty or contain control characters.",
            ));
        }
        if !groups.contains(&group) {
            groups.push(group);
        }
    }
    if groups.len() > 32 {
        return Err(AppError::invalid(
            "exoscale.groups",
            "Use at most 32 groups.",
        ));
    }
    Ok(ExoscaleSettings { user, groups })
}

/// A token as pasted: trimmed, one line, no spaces.
fn clean_secret(value: &str, field: &str, what: &str) -> Result<String, AppError> {
    let value = value.trim();
    if value.is_empty() {
        return Err(AppError::invalid(field, format!("Enter the {what}.")));
    }
    if value.len() > 1024 || value.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err(AppError::invalid(
            field,
            format!("This doesn't look like a {what}."),
        ));
    }
    Ok(value.to_string())
}

fn new_connection(provider: &str, kind: ConnectionKind, label: String) -> CloudConnection {
    CloudConnection {
        id: jp_auth_core::fsutil::random_id(),
        provider: provider.to_string(),
        kind,
        label,
        identity: None,
        sso: None,
        profile: None,
        region: None,
        regions: Vec::new(),
        targets: Vec::new(),
        cli_account: None,
        project_id: None,
        exoscale: None,
        status: ConnectionStatus::SignedOut,
        expires_at: None,
        message: None,
        created_at: managed::now_ms(),
    }
}

/// A validation failure of a token / key: refused credentials point at the
/// field, the rest is a provider error.
fn credentials_error(error: CloudError, field: &str) -> AppError {
    match error {
        CloudError::Unauthorized(message) => AppError::invalid(field, message),
        other => AppError::from(other),
    }
}

/// Cloud connections, with their sign-in state.
#[tauri::command]
pub async fn connections_list() -> Result<Vec<CloudConnection>, AppError> {
    let ctx = aws::context();
    let connections = {
        let ctx = ctx.clone();
        super::blocking(move || load(&ctx)).await?
    };
    refresh_cli_statuses(&connections, cli::STATUS_MAX_AGE).await;
    super::blocking(move || {
        Ok(connections
            .into_iter()
            .map(|c| with_status(&ctx, c))
            .collect())
    })
    .await
}

/// What a new connection stores in the vault.
enum NewSecret {
    Keys(StoredKeys),
    Value(String, serde_json::Value),
}

/// Adds a connection. Access keys, API tokens and keys are checked with a
/// cheap authenticated call and stored in the vault; a profile must exist;
/// a CLI must be installed (signed out is fine: sign in after).
#[tauri::command]
pub async fn connection_create(spec: ConnectionSpec) -> Result<CloudConnection, AppError> {
    let ctx = aws::context();
    let existing = {
        let ctx = ctx.clone();
        super::blocking(move || load(&ctx)).await?
    };
    let (connection, secret) = match spec {
        ConnectionSpec::Sso {
            label,
            start_url,
            region,
        } => {
            let start_url = validate_start_url(&start_url)?;
            let region = validate_region(&region, "region")?;
            if existing.iter().any(|c| {
                c.sso.as_ref().is_some_and(|s| {
                    jp_auth_core::aws::config::same_start_url(&s.start_url, &start_url)
                })
            }) {
                return Err(AppError::invalid(
                    "startUrl",
                    "This access portal is already connected.",
                ));
            }
            let default_label = tauri::Url::parse(&start_url)
                .ok()
                .and_then(|u| {
                    u.host_str()
                        .map(|h| h.split('.').next().unwrap_or(h).to_string())
                })
                .unwrap_or_else(|| start_url.clone());
            let mut connection = new_connection(
                providers::AWS,
                ConnectionKind::Sso,
                clean_label(label).unwrap_or(default_label),
            );
            connection.sso = Some(SsoSettings { start_url, region });
            (connection, None)
        }
        ConnectionSpec::Profile { label, profile } => {
            let profile = profile.trim().to_string();
            if !valid_profile_name(&profile) {
                return Err(AppError::invalid(
                    "profile",
                    "Choose a profile from ~/.aws/config.",
                ));
            }
            let files = {
                let ctx = ctx.clone();
                super::blocking(move || Ok(jp_auth_core::aws::config::AwsFiles::load(&ctx))).await?
            };
            if !files.has_profile(&profile) {
                return Err(AppError::invalid(
                    "profile",
                    format!("There is no profile \"{profile}\" in ~/.aws."),
                ));
            }
            if existing.iter().any(|c| {
                c.kind == ConnectionKind::Profile && c.profile.as_deref() == Some(&profile)
            }) {
                return Err(AppError::invalid(
                    "profile",
                    "This profile is already connected.",
                ));
            }
            let mut connection = new_connection(
                providers::AWS,
                ConnectionKind::Profile,
                clean_label(label).unwrap_or_else(|| profile.clone()),
            );
            connection.region = files.region(&profile);
            connection.profile = Some(profile);
            (connection, None)
        }
        ConnectionSpec::Keys {
            label,
            access_key_id,
            secret_access_key,
            session_token,
            region,
        } => {
            let access_key_id = access_key_id.trim().to_string();
            if access_key_id.len() < 16
                || access_key_id.len() > 128
                || !access_key_id.bytes().all(|b| b.is_ascii_alphanumeric())
            {
                return Err(AppError::invalid(
                    "accessKeyId",
                    "Enter an access key ID, such as AKIAIOSFODNN7EXAMPLE.",
                ));
            }
            let secret_access_key = secret_access_key.trim().to_string();
            if secret_access_key.is_empty() {
                return Err(AppError::invalid(
                    "secretAccessKey",
                    "Enter the secret access key.",
                ));
            }
            let region = validate_region(&region, "region")?;
            let keys = StoredKeys {
                access_key_id,
                secret_access_key,
                session_token: session_token
                    .map(|t| t.trim().to_string())
                    .filter(|t| !t.is_empty()),
            };
            let credentials = creds::AwsCredentials {
                access_key_id: keys.access_key_id.clone(),
                secret_access_key: keys.secret_access_key.clone(),
                session_token: keys.session_token.clone(),
                expires_at: None,
            };
            let (account, arn) = creds::caller_identity(&ctx, &credentials, &region)
                .await
                .map_err(|e| match e {
                    jp_auth_core::aws::AwsError::Service { message, .. } => AppError::invalid(
                        "accessKeyId",
                        format!("AWS did not accept these keys: {message}"),
                    ),
                    other => AppError::from(other),
                })?;
            let mut connection = new_connection(
                providers::AWS,
                ConnectionKind::Keys,
                clean_label(label).unwrap_or(account),
            );
            connection.region = Some(region);
            connection.identity = Some(arn);
            connection.status = ConnectionStatus::SignedIn;
            (connection, Some(NewSecret::Keys(keys)))
        }
        ConnectionSpec::Cli {
            provider,
            label,
            cli_account,
        } => {
            let tool = cli::CliTool::for_provider(&provider).ok_or_else(|| {
                AppError::invalid(
                    "provider",
                    "Only Google Cloud (gcp), Azure (azure) and DigitalOcean (digitalocean) connect through a CLI.",
                )
            })?;
            let cli_account = validate_cli_account(cli_account)?;
            let status = cli::status(tool, std::time::Duration::ZERO).await;
            if !status.installed {
                return Err(AppError::invalid(
                    "provider",
                    format!(
                        "{} is not installed. Install it from {}, then try again.",
                        tool.binary(),
                        tool.install_url()
                    ),
                ));
            }
            if let Some(account) = &cli_account {
                if status.signed_in && !status.accounts.iter().any(|a| a == account) {
                    return Err(AppError::invalid(
                        "cliAccount",
                        format!("{} is not signed in as {account}.", tool.binary()),
                    ));
                }
            }
            if existing.iter().any(|c| {
                c.kind == ConnectionKind::Cli
                    && c.provider == provider
                    && c.cli_account == cli_account
            }) {
                return Err(AppError::invalid(
                    "cliAccount",
                    format!("This {} sign-in is already connected.", tool.binary()),
                ));
            }
            let account = cli_account.clone().or(status.account.clone());
            let default_label = match (&account, tool) {
                (Some(account), cli::CliTool::Doctl) => format!("DigitalOcean ({account})"),
                (Some(account), _) => account.clone(),
                (None, _) => providers::display_name(&provider).to_string(),
            };
            let mut connection = new_connection(
                &provider,
                ConnectionKind::Cli,
                clean_label(label).unwrap_or(default_label),
            );
            connection.cli_account = cli_account;
            connection.identity = account;
            (connection, None)
        }
        ConnectionSpec::Token {
            provider,
            label,
            token,
            project_id,
        } => {
            let api_provider = ApiProvider::from_id(&provider)
                .filter(|p| *p != ApiProvider::Exoscale)
                .ok_or_else(|| {
                    AppError::invalid(
                        "provider",
                        "API tokens work for DigitalOcean, Akamai (linode), Civo, Scaleway and Vultr.",
                    )
                })?;
            let token = clean_secret(&token, "token", "API token")?;
            let project_id = project_id
                .map(|p| p.trim().to_string())
                .filter(|p| !p.is_empty());
            if let Some(project) = &project_id {
                if api_provider != ApiProvider::Scaleway {
                    return Err(AppError::invalid(
                        "projectId",
                        "Only Scaleway connections have a project.",
                    ));
                }
                if !jp_auth_core::request::valid_cloud_cluster_id(project) {
                    return Err(AppError::invalid(
                        "projectId",
                        "Enter the project ID, such as 11111111-1111-4111-8111-111111111111.",
                    ));
                }
            }
            let validated = api::validate_token(
                &providers::context(),
                api_provider,
                &token,
                project_id.as_deref(),
            )
            .await
            .map_err(|e| credentials_error(e, "token"))?;
            let mut connection = new_connection(
                &provider,
                ConnectionKind::Token,
                clean_label(label)
                    .or(validated.label)
                    .unwrap_or_else(|| providers::display_name(&provider).to_string()),
            );
            connection.identity = validated.identity;
            connection.project_id = project_id;
            connection.status = ConnectionStatus::SignedIn;
            let secret = NewSecret::Value(
                api_token_secret_id(&connection.id),
                serde_json::json!({ "token": token }),
            );
            (connection, Some(secret))
        }
        ConnectionSpec::ApiKey {
            provider,
            label,
            key,
            secret,
            user,
            groups,
        } => {
            if provider
                .as_deref()
                .is_some_and(|p| p != providers::EXOSCALE)
            {
                return Err(AppError::invalid(
                    "provider",
                    "API keys with a secret are for Exoscale.",
                ));
            }
            let key = clean_secret(&key, "key", "API key")?;
            let secret = clean_secret(&secret, "secret", "API secret")?;
            let defaults = ExoscaleSettings::default();
            let settings = validate_exoscale(ExoscaleSettings {
                user: user.unwrap_or(defaults.user),
                groups: groups.unwrap_or(defaults.groups),
            })?;
            let api_key = jp_auth_core::cloud::ApiKey {
                key: key.clone(),
                secret: secret.clone(),
            };
            let validated = api::validate_key(&providers::context(), &api_key)
                .await
                .map_err(|e| credentials_error(e, "key"))?;
            let mut connection = new_connection(
                providers::EXOSCALE,
                ConnectionKind::ApiKey,
                clean_label(label)
                    .or(validated.label)
                    .unwrap_or_else(|| "Exoscale".to_string()),
            );
            connection.identity = validated.identity;
            connection.exoscale = Some(settings);
            connection.status = ConnectionStatus::SignedIn;
            let secret = NewSecret::Value(
                api_key_secret_id(&connection.id),
                serde_json::json!({ "key": key, "secret": secret }),
            );
            (connection, Some(secret))
        }
    };
    let ctx2 = ctx.clone();
    let created = super::blocking(move || {
        let item = match secret {
            Some(NewSecret::Keys(keys)) => Some((
                keys_secret_id(&connection.id),
                serde_json::to_value(&keys).map_err(|e| AppError::internal(e.to_string()))?,
            )),
            Some(NewSecret::Value(id, value)) => Some((id, value)),
            None => None,
        };
        if let Some(item) = item {
            ctx2.store
                .put_and_remove(vec![item], &[])
                .map_err(vault_error)?;
        }
        let saved = connection.clone();
        store::update::<_, AppError>(&ctx2.connections_file, move |list| {
            list.push(saved);
            Ok(())
        })?;
        Ok(with_status(&ctx2, connection))
    })
    .await?;
    info!(
        "Added {} connection {} ({:?})",
        created.provider, created.id, created.kind
    );
    Ok(created)
}

/// Validates scope targets for a connection: AWS account + role pairs (SSO),
/// GCP project ids or Azure subscription ids (CLI, role empty).
fn validate_targets(
    connection: &CloudConnection,
    targets: Vec<SsoTarget>,
) -> Result<Vec<SsoTarget>, AppError> {
    let kind = (connection.provider.as_str(), connection.kind);
    let mut out: Vec<SsoTarget> = Vec::new();
    for target in targets {
        let account_id = target.account_id.trim().to_string();
        match kind {
            (providers::AWS, _) => {
                if !valid_account_id(&account_id) {
                    return Err(AppError::invalid(
                        "targets",
                        format!("\"{account_id}\" is not an AWS account id."),
                    ));
                }
                if !valid_role_name(&target.role_name) {
                    return Err(AppError::invalid(
                        "targets",
                        format!("\"{}\" is not a role name.", target.role_name),
                    ));
                }
            }
            (providers::GCP, ConnectionKind::Cli) => {
                if !gcp::valid_project_id(&account_id) {
                    return Err(AppError::invalid(
                        "targets",
                        format!("\"{account_id}\" is not a Google Cloud project id."),
                    ));
                }
            }
            (providers::AZURE, ConnectionKind::Cli) => {
                if !providers::azure::valid_subscription_id(&account_id) {
                    return Err(AppError::invalid(
                        "targets",
                        format!("\"{account_id}\" is not an Azure subscription id."),
                    ));
                }
            }
            _ => {
                return Err(AppError::invalid(
                    "targets",
                    "This connection has no accounts, projects or subscriptions to choose.",
                ))
            }
        }
        let role_name = if connection.provider == providers::AWS {
            target.role_name.clone()
        } else {
            String::new()
        };
        if !out
            .iter()
            .any(|t| t.account_id == account_id && t.role_name == role_name)
        {
            out.push(SsoTarget {
                account_id,
                account_name: clean_label(target.account_name),
                role_name,
            });
        }
    }
    Ok(out)
}

/// The managed contexts' users of a connection's clusters (to forget their
/// cached credentials).
fn connection_users(connection_id: &str) -> Vec<String> {
    let path = super::catalog::managed_file();
    let Ok(doc) = managed::read(&path) else {
        return Vec::new();
    };
    doc.contexts
        .iter()
        .filter(|c| managed::cloud_meta_of(c).is_some_and(|m| m.connection_id == connection_id))
        .filter_map(|c| c.context.as_ref()?.user.clone())
        .collect()
}

/// Renames a connection, or sets its regions, targets (accounts + roles,
/// projects, subscriptions) or Exoscale certificate identity.
#[tauri::command]
pub async fn connection_update(
    id: String,
    patch: ConnectionPatch,
) -> Result<CloudConnection, AppError> {
    super::blocking(move || {
        let ctx = aws::context();
        let current = load(&ctx)?
            .into_iter()
            .find(|c| c.id == id)
            .ok_or_else(|| AppError::not_found("This connection no longer exists."))?;
        let label = match patch.label {
            Some(label) => Some(
                clean_label(Some(label))
                    .ok_or_else(|| AppError::invalid("label", "Enter a name."))?,
            ),
            None => None,
        };
        let regions = match patch.regions {
            Some(regions) => {
                let mut set = BTreeSet::new();
                for region in regions {
                    set.insert(if current.provider == providers::AWS {
                        validate_region(&region, "regions")?
                    } else {
                        validate_cloud_region(&current.provider, &region)?
                    });
                }
                Some(set.into_iter().collect::<Vec<_>>())
            }
            None => None,
        };
        let targets = match patch.targets {
            Some(targets) => {
                if current.provider == providers::AWS
                    && current.kind != ConnectionKind::Sso
                    && !targets.is_empty()
                {
                    return Err(AppError::invalid(
                        "targets",
                        "Only IAM Identity Center connections have account targets.",
                    ));
                }
                Some(validate_targets(&current, targets)?)
            }
            None => None,
        };
        let exoscale = match patch.exoscale {
            Some(settings) => {
                if current.provider != providers::EXOSCALE {
                    return Err(AppError::invalid(
                        "exoscale",
                        "Only Exoscale connections mint client certificates.",
                    ));
                }
                Some(validate_exoscale(settings)?)
            }
            None => None,
        };
        let identity_changed = exoscale
            .as_ref()
            .is_some_and(|s| *s != current.exoscale_settings());
        let updated = store::update::<_, AppError>(&ctx.connections_file, |list| {
            let connection = list
                .iter_mut()
                .find(|c| c.id == id)
                .ok_or_else(|| AppError::not_found("This connection no longer exists."))?;
            if let Some(label) = label {
                connection.label = label;
            }
            if let Some(regions) = regions {
                connection.regions = regions;
            }
            if let Some(targets) = targets {
                connection.targets = targets;
            }
            if let Some(exoscale) = exoscale {
                connection.exoscale = Some(exoscale);
            }
            Ok(connection.clone())
        })?;
        if identity_changed {
            // Certificates for the old user / groups: mint new ones.
            let cached = ctx
                .store
                .ids_with_prefix(&store::cache_prefix(providers::EXOSCALE, &id))
                .map_err(vault_error)?;
            ctx.store
                .put_and_remove(Vec::new(), &cached)
                .map_err(vault_error)?;
            let users = connection_users(&id);
            let path = super::catalog::managed_file();
            let path =
                crate::kubernetes::client::resolve_kubeconfig_path(Some(&path.to_string_lossy()));
            crate::auth::broker::invalidate(|key| {
                key.kube_config == path && users.contains(&key.user)
            });
            api::forget_entry_statuses();
        }
        super::catalog::prune_connection_scope(&updated)?;
        aws::forget_entry_statuses();
        Ok(with_status(&ctx, updated))
    })
    .await
}

/// Removes a connection and forgets its secrets (SSO session copy, client
/// registration, keys, tokens, cached role credentials, minted tokens and
/// certificates). `remove_clusters` also removes the clusters added from
/// it (and their stored credentials). The aws CLI's token cache and the
/// cloud CLIs' own sign-ins are left alone.
#[tauri::command]
pub async fn connection_delete(id: String, remove_clusters: bool) -> Result<(), AppError> {
    super::blocking(move || {
        let ctx = aws::context();
        let Some(connection) = load(&ctx)?.into_iter().find(|c| c.id == id) else {
            return Err(AppError::not_found("This connection no longer exists."));
        };
        let mut secret_ids = Vec::new();
        for prefix in store::secret_prefixes(&id) {
            secret_ids.extend(ctx.store.ids_with_prefix(&prefix).map_err(vault_error)?);
        }
        ctx.store
            .put_and_remove(Vec::new(), &secret_ids)
            .map_err(vault_error)?;
        if remove_clusters {
            let path = super::catalog::managed_file();
            let doc = managed::read(&path)?;
            let contexts: Vec<String> = doc
                .contexts
                .iter()
                .filter(|c| managed::cloud_meta_of(c).is_some_and(|m| m.connection_id == id))
                .map(|c| c.name.clone())
                .collect();
            let forget = connection.provider != providers::AWS;
            super::remove(&path, &contexts, forget)?;
        }
        store::update::<_, AppError>(&ctx.connections_file, |list| {
            list.retain(|c| c.id != id);
            Ok(())
        })?;
        super::catalog::forget_connection(&id)?;
        aws::forget_entry_statuses();
        api::forget_entry_statuses();
        info!("Removed {} connection {}", connection.provider, id);
        Ok(())
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn specs_and_patches_use_the_ipc_shapes() {
        let sso: ConnectionSpec = serde_json::from_value(serde_json::json!({
            "kind": "sso", "startUrl": "https://acme.awsapps.com/start", "region": "eu-west-1"
        }))
        .unwrap();
        assert!(
            matches!(sso, ConnectionSpec::Sso { label: None, ref start_url, .. } if start_url == "https://acme.awsapps.com/start")
        );
        let keys: ConnectionSpec = serde_json::from_value(serde_json::json!({
            "kind": "keys", "label": "ci", "accessKeyId": "AKIA", "secretAccessKey": "s3cr3t", "region": "eu-west-1"
        }))
        .unwrap();
        assert!(!format!("{keys:?}").contains("s3cr3t"));
        let profile: ConnectionSpec =
            serde_json::from_value(serde_json::json!({"kind": "profile", "profile": "dev"}))
                .unwrap();
        assert!(matches!(profile, ConnectionSpec::Profile { .. }));
        // AWS specs keep working with a provider field.
        let with_provider: ConnectionSpec = serde_json::from_value(serde_json::json!({
            "kind": "profile", "provider": "aws", "profile": "dev"
        }))
        .unwrap();
        assert!(matches!(with_provider, ConnectionSpec::Profile { .. }));
        let patch: ConnectionPatch = serde_json::from_value(serde_json::json!({
            "targets": [{"accountId": "123456789012", "accountName": "prod", "roleName": "ReadOnly"}]
        }))
        .unwrap();
        assert_eq!(patch.targets.unwrap()[0].role_name, "ReadOnly");
        assert!(patch.label.is_none() && patch.regions.is_none() && patch.exoscale.is_none());

        let cli: ConnectionSpec = serde_json::from_value(serde_json::json!({
            "kind": "cli", "provider": "gcp", "cliAccount": "me@example.com"
        }))
        .unwrap();
        assert!(
            matches!(cli, ConnectionSpec::Cli { ref provider, cli_account: Some(ref a), .. } if provider == "gcp" && a == "me@example.com")
        );
        let token: ConnectionSpec = serde_json::from_value(serde_json::json!({
            "kind": "token", "provider": "scaleway", "token": "scw-secret-key", "projectId": "p1"
        }))
        .unwrap();
        assert!(!format!("{token:?}").contains("scw-secret-key"));
        let key: ConnectionSpec = serde_json::from_value(serde_json::json!({
            "kind": "apiKey", "provider": "exoscale", "key": "EXOabc", "secret": "exo-secret",
            "user": "alice", "groups": ["devs"]
        }))
        .unwrap();
        assert!(!format!("{key:?}").contains("exo-secret"));
        let patch: ConnectionPatch = serde_json::from_value(serde_json::json!({
            "exoscale": {"user": "bob", "groups": ["system:masters"]}
        }))
        .unwrap();
        assert_eq!(patch.exoscale.unwrap().user, "bob");

        assert!(validate_start_url("http://acme.awsapps.com/start").is_err());
        assert!(validate_start_url("https://user:pw@acme.awsapps.com/start").is_err());
        assert_eq!(
            validate_start_url(" https://d-1234567890.awsapps.com/start ").unwrap(),
            "https://d-1234567890.awsapps.com/start"
        );
    }

    #[test]
    fn validation_of_regions_targets_and_exoscale_settings() {
        assert_eq!(validate_cloud_region("civo", "LON1").unwrap(), "LON1");
        assert!(validate_cloud_region("scaleway", "us-east-1").is_err());
        assert!(validate_cloud_region("vultr", "ams/../x").is_err());
        assert!(validate_cloud_region("linode", "").is_err());

        let mut gcp = new_connection("gcp", ConnectionKind::Cli, "g".into());
        let targets = validate_targets(
            &gcp,
            vec![SsoTarget {
                account_id: "my-project-123".into(),
                account_name: Some("My project".into()),
                role_name: "ignored".into(),
            }],
        )
        .unwrap();
        assert_eq!(targets[0].role_name, "");
        assert!(validate_targets(
            &gcp,
            vec![SsoTarget {
                account_id: "--flag".into(),
                account_name: None,
                role_name: String::new(),
            }]
        )
        .is_err());
        gcp.provider = "azure".into();
        assert!(validate_targets(
            &gcp,
            vec![SsoTarget {
                account_id: "00000000-0000-0000-0000-000000000000".into(),
                account_name: None,
                role_name: String::new(),
            }]
        )
        .is_ok());
        let token = new_connection("vultr", ConnectionKind::Token, "v".into());
        assert!(validate_targets(
            &token,
            vec![SsoTarget {
                account_id: "x".into(),
                account_name: None,
                role_name: String::new(),
            }]
        )
        .is_err());

        let settings = validate_exoscale(ExoscaleSettings {
            user: " alice ".into(),
            groups: vec!["devs".into(), "devs".into(), "system:masters".into()],
        })
        .unwrap();
        assert_eq!(settings.user, "alice");
        assert_eq!(settings.groups, ["devs", "system:masters"]);
        assert!(validate_exoscale(ExoscaleSettings {
            user: "".into(),
            groups: vec![]
        })
        .is_err());
        assert!(clean_secret("a b", "token", "API token").is_err());
        assert_eq!(clean_secret(" t0k ", "token", "API token").unwrap(), "t0k");
        assert!(validate_cli_account(Some("-x".into())).is_err());
        assert_eq!(validate_cli_account(Some(" ".into())).unwrap(), None);
    }
}

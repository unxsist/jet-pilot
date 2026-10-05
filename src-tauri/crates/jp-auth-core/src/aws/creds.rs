//! AWS credentials of a connection, never interactive:
//!
//! - SSO: `GetRoleCredentials` for an account + role with the session's
//!   access token;
//! - profile: aws-config's profile provider (SSO profiles, assume-role
//!   chains, `credential_process`, web identity, static keys). Profiles
//!   with `mfa_serial` use the session [`mfa_sign_in`] created;
//! - keys: access keys from the vault.
//!
//! Temporary credentials are cached in the vault ([`crate::cache`]) until
//! five minutes before they expire, shared by the app and the helper.

use serde::{Deserialize, Serialize};
use zeroize::Zeroize;

use super::config::AwsFiles;
use super::session::{self, SessionState};
use super::{sdk_error, AwsContext, AwsError};
use crate::aws_client_config;
use crate::connections::{keys_secret_id, mfa_session_secret_id, CloudConnection, ConnectionKind};
use crate::request::AwsEksArgs;

/// Cached credentials are used while valid at least this long.
pub const CACHE_MARGIN: i64 = 5 * 60;
/// Session length of MFA role sessions without `duration_seconds`.
const MFA_DEFAULT_DURATION: i32 = 3600;

#[derive(Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AwsCredentials {
    pub access_key_id: String,
    pub secret_access_key: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_token: Option<String>,
    /// Unix seconds; None = long-term keys.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<i64>,
}

impl Drop for AwsCredentials {
    fn drop(&mut self) {
        self.secret_access_key.zeroize();
        self.session_token.zeroize();
    }
}

impl std::fmt::Debug for AwsCredentials {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AwsCredentials")
            .field("access_key_id", &self.access_key_id)
            .field("session_token", &self.session_token.is_some())
            .field("expires_at", &self.expires_at)
            .finish()
    }
}

impl AwsCredentials {
    /// For SDK clients.
    pub fn to_sdk(&self) -> aws_credential_types::Credentials {
        aws_credential_types::Credentials::new(
            self.access_key_id.clone(),
            self.secret_access_key.clone(),
            self.session_token.clone(),
            self.expires_at
                .and_then(|at| u64::try_from(at).ok())
                .map(|at| std::time::UNIX_EPOCH + std::time::Duration::from_secs(at)),
            "jet-pilot",
        )
    }

    fn from_sdk(credentials: &aws_credential_types::Credentials) -> AwsCredentials {
        AwsCredentials {
            access_key_id: credentials.access_key_id().to_string(),
            secret_access_key: credentials.secret_access_key().to_string(),
            session_token: credentials.session_token().map(str::to_string),
            expires_at: credentials
                .expiry()
                .and_then(|at| at.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs() as i64),
        }
    }
}

/// Access keys as stored in the vault (`conn:<id>:aws-keys`).
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredKeys {
    pub access_key_id: String,
    pub secret_access_key: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_token: Option<String>,
}

impl Drop for StoredKeys {
    fn drop(&mut self) {
        self.secret_access_key.zeroize();
        self.session_token.zeroize();
    }
}

pub fn role_cache_id(conn_id: &str, account_id: &str, role: &str) -> String {
    format!("cache:aws:{conn_id}:{account_id}:{role}")
}

pub fn profile_cache_id(conn_id: &str, profile: &str) -> String {
    format!("cache:aws:{conn_id}:profile:{profile}")
}

async fn cached(ctx: &AwsContext, id: String) -> Option<AwsCredentials> {
    let now = super::now();
    ctx.with_store(move |store| crate::cache::get::<AwsCredentials>(store, &id, now, CACHE_MARGIN))
        .await
}

async fn remember(ctx: &AwsContext, id: String, credentials: &AwsCredentials) {
    let Some(expires_at) = credentials.expires_at else {
        return;
    };
    let copy = credentials.clone();
    let now = super::now();
    // Best effort: a vault that can't be written is a cache miss next time.
    let _ = ctx
        .with_store(move |store| crate::cache::put(store, &id, &copy, expires_at, now))
        .await;
}

/// Role credentials of an SSO connection.
pub async fn sso_role(
    ctx: &AwsContext,
    connection: &CloudConnection,
    account_id: &str,
    role: &str,
) -> Result<AwsCredentials, AwsError> {
    let sso = connection.sso.as_ref().ok_or_else(|| {
        AwsError::Invalid("This connection has no IAM Identity Center settings".to_string())
    })?;
    let cache_id = role_cache_id(&connection.id, account_id, role);
    if let Some(credentials) = cached(ctx, cache_id.clone()).await {
        return Ok(credentials);
    }
    let token = session::access_token(ctx, Some(&connection.id), &sso.start_url).await?;
    let credentials =
        super::sso::role_credentials(ctx, &sso.region, &token.access_token, account_id, role)
            .await?;
    remember(ctx, cache_id, &credentials).await;
    Ok(credentials)
}

#[allow(deprecated)]
fn profile_files(ctx: &AwsContext) -> aws_config::profile::profile_file::ProfileFiles {
    use aws_config::profile::profile_file::{ProfileFileKind, ProfileFiles};
    let mut builder = ProfileFiles::builder()
        .include_default_config_file(ctx.aws_config_path().is_none())
        .include_default_credentials_file(ctx.aws_credentials_path().is_none());
    if let Some(path) = ctx.aws_config_path() {
        builder = builder.with_file(ProfileFileKind::Config, path);
    }
    if let Some(path) = ctx.aws_credentials_path() {
        builder = builder.with_file(ProfileFileKind::Credentials, path);
    }
    builder.build()
}

fn provider_config(ctx: &AwsContext, region: &str) -> aws_config::provider_config::ProviderConfig {
    aws_config::provider_config::ProviderConfig::without_region()
        .with_region(Some(aws_config::Region::new(region.to_string())))
        .with_http_client(super::http::http_client())
        .with_sleep_impl(aws_smithy_async::rt::sleep::TokioSleep::new())
        .with_time_source(aws_smithy_async::time::SystemTimeSource::new())
        .with_retry_config(ctx.retry_config())
        .with_timeout_config(ctx.timeout_config())
}

fn profile_error(
    profile: &str,
    error: aws_credential_types::provider::error::CredentialsError,
) -> AwsError {
    use aws_credential_types::provider::error::CredentialsError;
    let text = aws_smithy_types::error::display::DisplayErrorContext(&error).to_string();
    let lower = text.to_ascii_lowercase();
    if lower.contains("sso token") || lower.contains("unauthorizedexception") {
        return AwsError::SignInRequired(format!(
            "Sign in to AWS for profile {profile}: its IAM Identity Center session has expired"
        ));
    }
    match error {
        CredentialsError::ProviderTimedOut(_) => {
            AwsError::Network(format!("Profile {profile}: AWS did not answer in time"))
        }
        CredentialsError::InvalidConfiguration(_) => AwsError::Invalid(crate::redact(&format!(
            "Profile {profile} is not usable: {text}"
        ))),
        _ => AwsError::Service {
            code: None,
            message: crate::redact(&format!("Profile {profile}: {text}")),
        },
    }
}

/// Credentials of a `~/.aws` profile.
pub async fn profile(
    ctx: &AwsContext,
    conn_id: &str,
    profile: &str,
) -> Result<AwsCredentials, AwsError> {
    let files = AwsFiles::load(ctx);
    if !files.has_profile(profile) {
        return Err(AwsError::NotFound(format!(
            "The AWS profile {profile} no longer exists in ~/.aws"
        )));
    }
    if files.mfa_role(profile).is_some() {
        let id = mfa_session_secret_id(conn_id);
        return cached(ctx, id).await.ok_or_else(|| {
            AwsError::MfaRequired(format!(
                "Enter an MFA code for profile {profile} in JET Pilot"
            ))
        });
    }
    let cache_id = profile_cache_id(conn_id, profile);
    if let Some(credentials) = cached(ctx, cache_id.clone()).await {
        return Ok(credentials);
    }
    if let Some(sso) = files.sso(profile) {
        let state = {
            let (ctx, url) = (ctx.clone(), sso.start_url.clone());
            tokio::task::spawn_blocking(move || {
                SessionState::of(session::cached_token(&ctx, &url).as_ref(), super::now())
            })
            .await
            .map_err(|e| AwsError::Invalid(e.to_string()))?
        };
        if !state.signed_in() {
            return Err(AwsError::SignInRequired(format!(
                "Sign in to AWS for profile {profile}: its IAM Identity Center session has expired"
            )));
        }
    }
    let region = files
        .region(profile)
        .unwrap_or_else(|| "us-east-1".to_string());
    let provider = aws_config::profile::ProfileFileCredentialsProvider::builder()
        .configure(&provider_config(ctx, &region))
        .profile_files(profile_files(ctx))
        .profile_name(profile)
        .build();
    use aws_credential_types::provider::ProvideCredentials;
    let credentials = provider
        .provide_credentials()
        .await
        .map_err(|e| profile_error(profile, e))?;
    let credentials = AwsCredentials::from_sdk(&credentials);
    remember(ctx, cache_id, &credentials).await;
    Ok(credentials)
}

/// The access keys of a keys connection.
pub async fn keys(ctx: &AwsContext, conn_id: &str) -> Result<AwsCredentials, AwsError> {
    let id = keys_secret_id(conn_id);
    let value = ctx.with_store(move |store| store.get(&id)).await?;
    let stored: StoredKeys = value
        .and_then(|v| serde_json::from_value(v).ok())
        .ok_or_else(|| {
            AwsError::NotFound(
                "The access keys of this connection are missing. Add the connection again."
                    .to_string(),
            )
        })?;
    Ok(AwsCredentials {
        access_key_id: stored.access_key_id.clone(),
        secret_access_key: stored.secret_access_key.clone(),
        session_token: stored.session_token.clone(),
        expires_at: None,
    })
}

/// Credentials of a connection: SSO with an account + role, a profile
/// (the connection's unless `profile` is given), or access keys.
pub async fn for_connection(
    ctx: &AwsContext,
    connection: &CloudConnection,
    account_role: Option<(&str, &str)>,
    profile_override: Option<&str>,
) -> Result<AwsCredentials, AwsError> {
    match connection.kind {
        ConnectionKind::Sso => {
            let (account, role) = account_role.ok_or_else(|| {
                AwsError::Invalid("An account and role are needed for this connection".to_string())
            })?;
            sso_role(ctx, connection, account, role).await
        }
        ConnectionKind::Profile => {
            let name = profile_override
                .or(connection.profile.as_deref())
                .ok_or_else(|| {
                    AwsError::Invalid("This connection has no AWS profile".to_string())
                })?;
            profile(ctx, &connection.id, name).await
        }
        ConnectionKind::Keys => keys(ctx, &connection.id).await,
        ConnectionKind::Cli | ConnectionKind::Token | ConnectionKind::ApiKey => Err(
            AwsError::Invalid("This is not an AWS connection".to_string()),
        ),
    }
}

/// Credentials for a helper `aws-eks` request.
pub async fn for_eks(ctx: &AwsContext, args: &AwsEksArgs) -> Result<AwsCredentials, AwsError> {
    let connection = {
        let (ctx, id) = (ctx.clone(), args.connection.clone());
        tokio::task::spawn_blocking(move || ctx.connection(&id))
            .await
            .map_err(|e| AwsError::Invalid(e.to_string()))??
    };
    let account_role = args.account.as_deref().zip(args.role.as_deref());
    for_connection(ctx, &connection, account_role, args.profile.as_deref()).await
}

fn sts(ctx: &AwsContext, region: &str, credentials: &AwsCredentials) -> aws_sdk_sts::Client {
    let builder = aws_client_config!(
        aws_sdk_sts::Config::builder(),
        ctx,
        region,
        ctx.endpoints.sts.as_deref()
    )
    .credentials_provider(credentials.to_sdk());
    aws_sdk_sts::Client::from_conf(builder.build())
}

/// `GetCallerIdentity`: (account id, ARN).
pub async fn caller_identity(
    ctx: &AwsContext,
    credentials: &AwsCredentials,
    region: &str,
) -> Result<(String, String), AwsError> {
    let output = sts(ctx, region, credentials)
        .get_caller_identity()
        .send()
        .await
        .map_err(sdk_error)?;
    Ok((
        output.account().unwrap_or_default().to_string(),
        output.arn().unwrap_or_default().to_string(),
    ))
}

/// Assumes the role of an `mfa_serial` profile with a code from the
/// user and caches the session (`conn:<id>:mfa-session`) until it
/// expires. The source profile is resolved non-interactively.
pub async fn mfa_sign_in(
    ctx: &AwsContext,
    conn_id: &str,
    profile_name: &str,
    code: &str,
) -> Result<AwsCredentials, AwsError> {
    let code = code.trim();
    if code.len() < 6 || code.len() > 8 || !code.bytes().all(|b| b.is_ascii_digit()) {
        return Err(AwsError::Invalid(
            "Enter the 6-digit code of your MFA device".to_string(),
        ));
    }
    let files = AwsFiles::load(ctx);
    let role = files
        .mfa_role(profile_name)
        .ok_or_else(|| AwsError::Invalid(format!("Profile {profile_name} does not use MFA")))?;
    if files.mfa_role(&role.source_profile).is_some() {
        return Err(AwsError::Invalid(format!(
            "Profile {profile_name} assumes a role from another MFA profile, which JET Pilot does not support"
        )));
    }
    let source = profile(ctx, conn_id, &role.source_profile).await?;
    let region = files
        .region(profile_name)
        .or_else(|| files.region(&role.source_profile))
        .unwrap_or_else(|| "us-east-1".to_string());
    let session_name = role
        .session_name
        .clone()
        .unwrap_or_else(|| format!("jetpilot-{}", super::now()));
    let output = sts(ctx, &region, &source)
        .assume_role()
        .role_arn(&role.role_arn)
        .role_session_name(session_name)
        .serial_number(&role.mfa_serial)
        .token_code(code)
        .duration_seconds(role.duration_seconds.unwrap_or(MFA_DEFAULT_DURATION))
        .set_external_id(role.external_id.clone())
        .send()
        .await
        .map_err(sdk_error)?;
    let credentials = output
        .credentials()
        .ok_or_else(|| AwsError::Invalid("AWS returned no credentials".to_string()))?;
    let credentials = AwsCredentials {
        access_key_id: credentials.access_key_id().to_string(),
        secret_access_key: credentials.secret_access_key().to_string(),
        session_token: Some(credentials.session_token().to_string()),
        expires_at: Some(credentials.expiration().secs()),
    };
    remember(ctx, mfa_session_secret_id(conn_id), &credentials).await;
    Ok(credentials)
}

/// Until when the MFA session of a connection is valid (unix seconds).
pub fn mfa_session_expiry(ctx: &AwsContext, conn_id: &str) -> Option<i64> {
    let credentials: AwsCredentials =
        crate::cache::get(&ctx.store, &mfa_session_secret_id(conn_id), super::now(), 0)?;
    credentials.expires_at
}

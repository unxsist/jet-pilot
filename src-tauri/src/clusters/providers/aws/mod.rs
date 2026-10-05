//! AWS in the app: IAM Identity Center sign-in (device flow, streamed as
//! `LoginEvent`s), the account/role picker, `~/.aws` profiles, regions,
//! in-process EKS tokens for the broker, and EKS discovery for the catalog.
//! The AWS logic itself is shared with the helper in
//! `jp_auth_core::aws`.

pub mod discovery;
pub mod regions;
#[cfg(test)]
mod tests;

use std::future::Future;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use jp_auth_core::aws::config::AwsFiles;
use jp_auth_core::aws::session::{self, SessionState};
use jp_auth_core::aws::sso::{self, DeviceFlowError, SsoAccount};
use jp_auth_core::aws::{creds, token, AwsContext, AwsError};
use jp_auth_core::connections::{CloudConnection, ConnectionKind, ConnectionStatus};
use jp_auth_core::request::AwsEksArgs;
use tauri::ipc::Channel;
use tracing::{info, warn};

use crate::auth::login::{self, LoginEvent, LoginSink};
use crate::clusters::error::AppError;

/// A sign-in never takes longer (device codes expire after 10 minutes).
const SIGN_IN_LIMIT: Duration = Duration::from_secs(10 * 60);

#[cfg(test)]
static TEST_CONTEXT: std::sync::Mutex<Option<AwsContext>> = std::sync::Mutex::new(None);

/// Points the AWS code at a test context (None = the system).
#[cfg(test)]
pub(crate) fn use_test_context(ctx: Option<AwsContext>) {
    *crate::util::lock(&TEST_CONTEXT) = ctx;
}

/// The AWS environment: the app's vault (with an unlocked passphrase
/// vault's key), the JET Pilot home and the user's `~/.aws`.
pub(crate) fn context() -> AwsContext {
    #[cfg(test)]
    if let Some(ctx) = crate::util::lock(&TEST_CONTEXT).clone() {
        return ctx;
    }
    AwsContext::system(crate::secrets::store())
}

/* ------------------------------------------------------------- minting */

/// An EKS token for a helper `aws-eks` entry, minted in-process.
pub async fn mint_eks(args: &AwsEksArgs) -> Result<(String, SystemTime), AwsError> {
    let ctx = context();
    let credentials = creds::for_eks(&ctx, args).await?;
    let (token, expires_at) = token::eks_token(
        &credentials,
        &args.region,
        &args.cluster,
        SystemTime::now(),
        ctx.endpoints.sts.as_deref(),
    )?;
    Ok((
        token,
        UNIX_EPOCH + Duration::from_secs(expires_at.max(0) as u64),
    ))
}

/* ------------------------------------------------------------- sign-in */

/// What an IAM Identity Center sign-in signs in to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SignInTarget {
    pub connection_id: Option<String>,
    pub label: String,
    pub start_url: String,
    pub region: String,
}

/// The sign-in of a connection: its Identity Center settings, or those of
/// its profile when that is an SSO profile. None for connections that
/// don't sign in (access keys, other profiles).
pub fn sign_in_target(connection_id: &str) -> Option<SignInTarget> {
    let ctx = context();
    let connection = ctx.connection(connection_id).ok()?;
    target_of(&ctx, &connection)
}

fn target_of(ctx: &AwsContext, connection: &CloudConnection) -> Option<SignInTarget> {
    let label = connection.display_name();
    match connection.kind {
        ConnectionKind::Sso => connection.sso.as_ref().map(|sso| SignInTarget {
            connection_id: Some(connection.id.clone()),
            label,
            start_url: sso.start_url.clone(),
            region: sso.region.clone(),
        }),
        ConnectionKind::Profile => {
            let sso = AwsFiles::load(ctx).sso(connection.profile.as_deref()?)?;
            Some(SignInTarget {
                connection_id: Some(connection.id.clone()),
                label,
                region: sso.region.unwrap_or_else(|| connection.home_region()),
                start_url: sso.start_url,
            })
        }
        ConnectionKind::Keys => None,
    }
}

/// How a device flow ended without signing in.
#[derive(Debug, Clone, PartialEq)]
pub enum FlowError {
    Cancelled,
    Failed(String),
}

/// The device flow: `started`, `deviceCode` (its URLs allowed for
/// `auth_login_open_url` through `allow`), then polling until approved;
/// the token goes to the aws CLI cache and the vault. Returns the access
/// token's expiry (unix ms). Ends early when `cancelled` resolves.
pub async fn run_device_flow(
    target: &SignInTarget,
    sink: &LoginSink,
    allow: &(dyn Fn(&str) + Sync),
    cancelled: impl Future<Output = ()>,
) -> Result<Option<i64>, FlowError> {
    let ctx = context();
    sink(LoginEvent::Started {
        command: format!("AWS IAM Identity Center sign-in ({})", target.start_url),
    });
    let conn_id = target.connection_id.as_deref();
    let flow = async {
        let pending = session::begin_sign_in(&ctx, conn_id, &target.region, &target.start_url)
            .await
            .map_err(|e| FlowError::Failed(e.to_string()))?;
        let authorization = &pending.authorization;
        allow(&authorization.verification_uri);
        if let Some(complete) = &authorization.verification_uri_complete {
            allow(complete);
        }
        sink(LoginEvent::DeviceCode {
            user_code: authorization.user_code.clone(),
            verification_uri: authorization.verification_uri.clone(),
            verification_uri_complete: authorization.verification_uri_complete.clone(),
        });
        let sleeper = sso::tokio_sleeper();
        session::complete_sign_in(&ctx, conn_id, &pending, &*sleeper)
            .await
            .map_err(|e| match e {
                DeviceFlowError::Aws(error) => FlowError::Failed(error.to_string()),
                other => FlowError::Failed(other.to_string()),
            })
    };
    let token = tokio::select! {
        result = tokio::time::timeout(SIGN_IN_LIMIT, flow) => match result {
            Ok(result) => result?,
            Err(_) => return Err(FlowError::Failed("The sign-in did not finish within 10 minutes".to_string())),
        },
        _ = cancelled => return Err(FlowError::Cancelled),
    };
    let expires_at = token.expires_at * 1000;
    if let Some(id) = conn_id {
        let _ = super::super::connections::record_status(id, Ok(None));
        forget_entry_statuses();
    }
    Ok(Some(expires_at))
}

/// Signs in to an IAM Identity Center connection (or the SSO session of a
/// profile connection) with the device flow. Events arrive on `on_event`
/// (`started`, `deviceCode`, then `succeeded` / `failed` / `cancelled`);
/// the returned session id works with `auth_login_open_url` and
/// `auth_login_cancel`. Clusters of the connection are refreshed after.
#[tauri::command]
pub async fn aws_sso_sign_in(
    connection_id: String,
    on_event: Channel<LoginEvent>,
) -> Result<String, AppError> {
    let target = {
        let id = connection_id.clone();
        crate::clusters::blocking(move || {
            let ctx = context();
            let connection = ctx.connection(&id).map_err(AppError::from)?;
            target_of(&ctx, &connection).ok_or_else(|| {
                AppError::invalid(
                    "connectionId",
                    "This connection does not sign in with IAM Identity Center.",
                )
            })
        })
        .await?
    };
    let sink: LoginSink = Arc::new(move |event| on_event.send(event).is_ok());
    let native = login::begin_native(("aws-sso".to_string(), connection_id.clone()));
    let id = native.id().to_string();
    info!("AWS sign-in {} for connection {}", id, connection_id);
    tauri::async_runtime::spawn(async move {
        let allow = |url: &str| native.allow_url(url);
        let result = run_device_flow(&target, &sink, &allow, native.cancelled()).await;
        let event = match result {
            Ok(expires_at) => {
                let start_url = target.start_url.clone();
                let pairs = tauri::async_runtime::spawn_blocking(move || {
                    login::contexts_of_aws_sign_in(&connection_id, Some(&start_url))
                })
                .await
                .unwrap_or_default();
                if !pairs.is_empty() {
                    login::resolved(pairs);
                }
                LoginEvent::Succeeded { expires_at }
            }
            Err(FlowError::Cancelled) => LoginEvent::Cancelled,
            Err(FlowError::Failed(message)) => {
                warn!("AWS sign-in failed: {}", message);
                LoginEvent::Failed { message }
            }
        };
        sink(event);
        drop(native);
    });
    Ok(id)
}

/// Signs in to an MFA profile connection with a code from the user's MFA
/// device; the role session is cached until it expires.
#[tauri::command]
pub async fn aws_mfa_sign_in(
    connection_id: String,
    code: String,
) -> Result<CloudConnection, AppError> {
    let ctx = context();
    let connection = {
        let (ctx, id) = (ctx.clone(), connection_id.clone());
        crate::clusters::blocking(move || ctx.connection(&id).map_err(AppError::from)).await?
    };
    let profile = connection
        .profile
        .clone()
        .filter(|_| connection.kind == ConnectionKind::Profile)
        .ok_or_else(|| {
            AppError::invalid(
                "connectionId",
                "This connection does not use an AWS profile.",
            )
        })?;
    creds::mfa_sign_in(&ctx, &connection.id, &profile, &code)
        .await
        .map_err(|e| match e {
            AwsError::Invalid(message) => AppError::invalid("code", message),
            other => AppError::from(other),
        })?;
    let pairs = {
        let id = connection_id.clone();
        tauri::async_runtime::spawn_blocking(move || login::contexts_of_aws_sign_in(&id, None))
            .await
            .unwrap_or_default()
    };
    if !pairs.is_empty() {
        login::resolved(pairs);
    }
    crate::clusters::blocking(move || {
        super::super::connections::record_status(&connection_id, Ok(None))?;
        forget_entry_statuses();
        super::super::connections::get(&connection_id)
    })
    .await
}

/* ------------------------------------------------------------- status */

/// The credential state of a connection, without network calls and
/// without prompts: SSO sessions from the vault / aws CLI cache, SSO
/// profiles from the CLI cache, MFA profiles from their cached session.
/// Returns (status, expires at ms, message).
pub(crate) fn credential_state(
    ctx: &AwsContext,
    connection: &CloudConnection,
) -> (ConnectionStatus, Option<i64>, Option<String>) {
    let now = jp_auth_core::aws::now();
    let session_status = |state: SessionState| match state {
        SessionState::Valid(at) => (ConnectionStatus::SignedIn, Some(at * 1000), None),
        SessionState::Refreshable(_) => (ConnectionStatus::SignedIn, None, None),
        SessionState::Expired(at) => (ConnectionStatus::Expired, Some(at * 1000), None),
        SessionState::Missing => (ConnectionStatus::SignedOut, None, None),
    };
    match connection.kind {
        ConnectionKind::Sso => {
            let Some(sso) = &connection.sso else {
                return (
                    ConnectionStatus::Error,
                    None,
                    Some("The connection has no start URL".into()),
                );
            };
            let token = session::current_token(ctx, Some(&connection.id), &sso.start_url);
            session_status(SessionState::of(token.as_ref(), now))
        }
        ConnectionKind::Profile => {
            let Some(profile) = connection.profile.as_deref() else {
                return (
                    ConnectionStatus::Error,
                    None,
                    Some("The connection has no profile".into()),
                );
            };
            let files = AwsFiles::load(ctx);
            if !files.has_profile(profile) {
                return (
                    ConnectionStatus::Error,
                    None,
                    Some(format!("The profile {profile} no longer exists in ~/.aws")),
                );
            }
            if files.mfa_role(profile).is_some() {
                return match creds::mfa_session_expiry(ctx, &connection.id) {
                    Some(at) if at > now => (ConnectionStatus::SignedIn, Some(at * 1000), None),
                    _ => (
                        ConnectionStatus::SignedOut,
                        None,
                        Some("Enter an MFA code to use this profile".into()),
                    ),
                };
            }
            match files.sso(profile) {
                Some(sso) => session_status(SessionState::of(
                    session::cached_token(ctx, &sso.start_url).as_ref(),
                    now,
                )),
                None => (ConnectionStatus::SignedIn, None, None),
            }
        }
        ConnectionKind::Keys => (ConnectionStatus::SignedIn, None, None),
    }
}

/// The session behind a helper `aws-eks` entry, for the credential status.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum EntrySession {
    /// Valid until (unix seconds).
    Expires(i64),
    /// Valid without a meaningful end (renewed silently, long-term keys).
    Ongoing,
    /// Expired at (unix seconds).
    Expired(i64),
    /// Never signed in / no MFA session.
    Missing,
    /// Not known without minting (other profiles).
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct EntryStatus {
    pub can_sign_in: bool,
    pub sign_in_label: Option<String>,
    pub session: EntrySession,
}

type EntryCache = std::collections::HashMap<String, (std::time::Instant, EntryStatus)>;

/// Entry statuses of the last few seconds (see [`entry_status`]).
static ENTRY_CACHE: std::sync::Mutex<Option<EntryCache>> = std::sync::Mutex::new(None);

/// Forgets cached entry statuses (after a sign-in or a connection change).
pub(crate) fn forget_entry_statuses() {
    *crate::util::lock(&ENTRY_CACHE) = None;
}

/// The status of a helper `aws-eks` entry (no network, no prompts).
/// Cached for a few seconds per connection: the hub asks for many
/// contexts of the same connection at once.
pub(crate) fn entry_status(args: &AwsEksArgs) -> EntryStatus {
    use std::collections::HashMap;
    use std::time::Instant;
    let key = format!(
        "{}\0{}",
        args.connection,
        args.profile.as_deref().unwrap_or_default()
    );
    if let Some((at, status)) = crate::util::lock(&ENTRY_CACHE)
        .get_or_insert_with(HashMap::new)
        .get(&key)
    {
        if at.elapsed() < Duration::from_secs(3) {
            return status.clone();
        }
    }
    let status = compute_entry_status(&context(), args);
    crate::util::lock(&ENTRY_CACHE)
        .get_or_insert_with(HashMap::new)
        .insert(key, (Instant::now(), status.clone()));
    status
}

fn compute_entry_status(ctx: &AwsContext, args: &AwsEksArgs) -> EntryStatus {
    let unknown = EntryStatus {
        can_sign_in: false,
        sign_in_label: None,
        session: EntrySession::Unknown,
    };
    let Ok(connection) = ctx.connection(&args.connection) else {
        return unknown;
    };
    let now = jp_auth_core::aws::now();
    if let Some(target) = target_of(ctx, &connection) {
        let conn_id = (connection.kind == ConnectionKind::Sso).then_some(connection.id.as_str());
        let token =
            session::current_token(ctx, conn_id.or(Some(&connection.id)), &target.start_url);
        let session = match SessionState::of(token.as_ref(), now) {
            SessionState::Valid(at) => EntrySession::Expires(at),
            SessionState::Refreshable(_) => EntrySession::Ongoing,
            SessionState::Expired(at) => EntrySession::Expired(at),
            SessionState::Missing => EntrySession::Missing,
        };
        return EntryStatus {
            can_sign_in: true,
            sign_in_label: Some(format!("Sign in to AWS ({})", target.label)),
            session,
        };
    }
    match connection.kind {
        ConnectionKind::Keys => EntryStatus {
            session: EntrySession::Ongoing,
            ..unknown
        },
        ConnectionKind::Profile => {
            let profile = args
                .profile
                .clone()
                .or(connection.profile.clone())
                .unwrap_or_default();
            if AwsFiles::load(ctx).mfa_role(&profile).is_some() {
                let session = match creds::mfa_session_expiry(ctx, &connection.id) {
                    Some(at) if at > now => EntrySession::Expires(at),
                    _ => EntrySession::Missing,
                };
                return EntryStatus { session, ..unknown };
            }
            unknown
        }
        ConnectionKind::Sso => unknown,
    }
}

/* ------------------------------------------------------------ commands */

/// Profiles of `~/.aws/config` and `~/.aws/credentials` (names, kinds and
/// SSO settings; never values).
#[tauri::command]
pub async fn aws_profiles_list() -> Result<Vec<jp_auth_core::aws::config::ProfileInfo>, AppError> {
    crate::clusters::blocking(|| Ok(AwsFiles::load(&context()).profile_infos())).await
}

/// Regions with EKS.
#[tauri::command]
pub fn aws_regions() -> Vec<String> {
    regions::EKS_REGIONS.iter().map(|r| r.to_string()).collect()
}

/// Accounts and roles the signed-in user of an IAM Identity Center
/// connection can access (renews the session silently; `signInRequired`
/// when it can't).
#[tauri::command]
pub async fn aws_sso_accounts(connection_id: String) -> Result<Vec<SsoAccount>, AppError> {
    let ctx = context();
    let connection = {
        let (ctx, id) = (ctx.clone(), connection_id.clone());
        crate::clusters::blocking(move || ctx.connection(&id).map_err(AppError::from)).await?
    };
    let sso = connection
        .sso
        .clone()
        .filter(|_| connection.kind == ConnectionKind::Sso)
        .ok_or_else(|| {
            AppError::invalid(
                "connectionId",
                "This is not an IAM Identity Center connection.",
            )
        })?;
    let token = session::access_token(&ctx, Some(&connection.id), &sso.start_url).await?;
    Ok(sso::accounts(&ctx, &sso.region, &token.access_token).await?)
}

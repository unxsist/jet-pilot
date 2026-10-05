//! The IAM Identity Center session of a start URL: the access token JET
//! Pilot stored in the vault (`conn:<id>:sso-token`) or the aws CLI cached
//! in `~/.aws/sso/cache` (whichever expires last), renewed silently with
//! its refresh token. Nothing here is interactive: an expired session that
//! can't be renewed is [`AwsError::SignInRequired`].

use std::time::Duration;

use super::cli_cache::{self, SsoToken};
use super::config::AwsFiles;
use super::sso::{self, DeviceAuthorization, DeviceFlowError, Registration, Sleeper};
use super::{AwsContext, AwsError};
use crate::connections::{sso_client_secret_id, sso_token_secret_id};

/// Tokens are renewed when they expire within this.
pub const REFRESH_WINDOW: i64 = 10 * 60;
/// ... and used as they are while they are valid at least this long.
const MIN_VALID: i64 = 60;
/// A stored client registration is reused while valid this long.
const REGISTRATION_MARGIN: i64 = 24 * 3600;
const LOCK_NAME: &str = "aws-sso.lock";
const LOCK_TIMEOUT: Duration = Duration::from_secs(30);

pub const SIGN_IN_MESSAGE: &str =
    "Sign in to AWS in JET Pilot: the IAM Identity Center session has expired";

/// What a session can do right now, without a network call.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SessionState {
    /// Valid until (unix seconds).
    Valid(i64),
    /// Expired or about to, but renewable with its refresh token.
    Refreshable(i64),
    /// Expired (at), not renewable.
    Expired(i64),
    /// Never signed in.
    Missing,
}

impl SessionState {
    pub fn of(token: Option<&SsoToken>, now: i64) -> SessionState {
        match token {
            None => SessionState::Missing,
            Some(token) if token.expires_at - now > REFRESH_WINDOW => {
                SessionState::Valid(token.expires_at)
            }
            Some(token) if token.can_refresh(now) => SessionState::Refreshable(token.expires_at),
            Some(token) if token.expires_at - now > MIN_VALID => {
                SessionState::Valid(token.expires_at)
            }
            Some(token) => SessionState::Expired(token.expires_at),
        }
    }

    /// Usable without signing in.
    pub fn signed_in(self) -> bool {
        matches!(self, SessionState::Valid(_) | SessionState::Refreshable(_))
    }
}

fn vault_token(ctx: &AwsContext, conn_id: &str, start_url: &str) -> Option<SsoToken> {
    let value = ctx.store.get(&sso_token_secret_id(conn_id)).ok()??;
    let token: SsoToken = serde_json::from_value(value).ok()?;
    super::config::same_start_url(&token.start_url, start_url).then_some(token)
}

/// The token that expires last: the vault copy of `conn_id` or any CLI
/// cache entry for `start_url`. Reads files and the vault (blocking).
pub fn current_token(ctx: &AwsContext, conn_id: Option<&str>, start_url: &str) -> Option<SsoToken> {
    let vault = conn_id.and_then(|id| vault_token(ctx, id, start_url));
    let cli = ctx
        .sso_cache_dir()
        .and_then(|dir| cli_cache::read_best(&dir, start_url));
    match (vault, cli) {
        (Some(a), Some(b)) => Some(if b.expires_at > a.expires_at { b } else { a }),
        (a, b) => a.or(b),
    }
}

/// [`current_token`] without the vault (the CLI cache only): for status
/// checks that must not touch the keychain.
pub fn cached_token(ctx: &AwsContext, start_url: &str) -> Option<SsoToken> {
    ctx.sso_cache_dir()
        .and_then(|dir| cli_cache::read_best(&dir, start_url))
}

/// Stores `token` in the CLI cache (every file the aws CLI reads it from)
/// and, with `conn_id`, in the vault. Fails only when neither worked.
pub fn save_token(
    ctx: &AwsContext,
    conn_id: Option<&str>,
    token: &SsoToken,
) -> Result<(), AwsError> {
    let cli = match ctx.sso_cache_dir() {
        Some(dir) => cli_cache::write_all(&dir, &AwsFiles::load(ctx), token)
            .map(|_| ())
            .map_err(|e| AwsError::Invalid(format!("~/.aws/sso/cache can't be written: {e}"))),
        None => Err(AwsError::Invalid(
            "There is no home directory for ~/.aws".to_string(),
        )),
    };
    let vault = match conn_id {
        Some(id) => {
            let value =
                serde_json::to_value(token).map_err(|e| AwsError::Invalid(e.to_string()))?;
            ctx.store
                .put_and_remove(vec![(sso_token_secret_id(id), value)], &[])
                .map_err(AwsError::from)
        }
        None => Err(AwsError::Invalid("no connection".to_string())),
    };
    match (cli, vault) {
        (Ok(()), _) | (_, Ok(())) => Ok(()),
        (Err(cli), Err(_)) if conn_id.is_none() => Err(cli),
        (Err(_), Err(vault)) => Err(vault),
    }
}

/// A token valid for at least a minute (renewed when it expires within
/// [`REFRESH_WINDOW`]), or `SignInRequired`.
pub async fn access_token(
    ctx: &AwsContext,
    conn_id: Option<&str>,
    start_url: &str,
) -> Result<SsoToken, AwsError> {
    let now = super::now();
    let (id, url) = (conn_id.map(str::to_string), start_url.to_string());
    let token = {
        let ctx = ctx.clone();
        let (id, url) = (id.clone(), url.clone());
        tokio::task::spawn_blocking(move || current_token(&ctx, id.as_deref(), &url))
            .await
            .map_err(|e| AwsError::Invalid(e.to_string()))?
    };
    let Some(token) = token else {
        return Err(AwsError::SignInRequired(
            "Sign in to AWS in JET Pilot: there is no IAM Identity Center session yet".to_string(),
        ));
    };
    if token.expires_at - now > REFRESH_WINDOW {
        return Ok(token);
    }
    if !token.can_refresh(now) {
        return if token.expires_at - now > MIN_VALID {
            Ok(token)
        } else {
            Err(AwsError::SignInRequired(SIGN_IN_MESSAGE.to_string()))
        };
    }

    // One refresh at a time across the app and helper runs: another one
    // may have rotated the refresh token meanwhile.
    let lock = {
        let path = ctx.lock_dir.join(LOCK_NAME);
        let dir = ctx.lock_dir.clone();
        tokio::task::spawn_blocking(move || {
            crate::paths::ensure_private_dir(&dir)?;
            crate::fsutil::lock_file(&path, LOCK_TIMEOUT)
        })
        .await
        .map_err(|e| AwsError::Invalid(e.to_string()))?
        .map_err(|e| AwsError::Invalid(format!("The AWS sign-in lock can't be taken: {e}")))?
    };
    let token = {
        let ctx = ctx.clone();
        tokio::task::spawn_blocking(move || current_token(&ctx, id.as_deref(), &url))
            .await
            .map_err(|e| AwsError::Invalid(e.to_string()))?
            .unwrap_or(token)
    };
    let now = super::now();
    if token.expires_at - now > REFRESH_WINDOW || !token.can_refresh(now) {
        drop(lock);
        return if token.expires_at - now > MIN_VALID {
            Ok(token)
        } else {
            Err(AwsError::SignInRequired(SIGN_IN_MESSAGE.to_string()))
        };
    }
    let result = match sso::refresh(ctx, &token).await {
        Ok(grant) => {
            let mut renewed = token.clone();
            renewed.access_token = grant.access_token.clone();
            renewed.expires_at = grant.expires_at;
            if let Some(refresh) = &grant.refresh_token {
                renewed.refresh_token = Some(refresh.clone());
            }
            let saved = {
                let (ctx, renewed, id) =
                    (ctx.clone(), renewed.clone(), conn_id.map(str::to_string));
                tokio::task::spawn_blocking(move || save_token(&ctx, id.as_deref(), &renewed))
                    .await
                    .map_err(|e| AwsError::Invalid(e.to_string()))?
            };
            // A token that couldn't be stored still works for this call.
            let _ = saved;
            Ok(renewed)
        }
        Err(_) if token.expires_at - now > MIN_VALID => Ok(token),
        Err(AwsError::SignInRequired(_)) => {
            Err(AwsError::SignInRequired(SIGN_IN_MESSAGE.to_string()))
        }
        Err(other) => Err(other),
    };
    drop(lock);
    result
}

/// The stored client registration of `conn_id` for this start URL, or a
/// new one (stored best-effort).
pub async fn registration(
    ctx: &AwsContext,
    conn_id: Option<&str>,
    region: &str,
    start_url: &str,
) -> Result<Registration, AwsError> {
    let now = super::now();
    if let Some(id) = conn_id {
        let id = id.to_string();
        let stored = ctx
            .with_store(move |store| store.get(&sso_client_secret_id(&id)).ok().flatten())
            .await
            .and_then(|value| serde_json::from_value::<Registration>(value).ok());
        if let Some(stored) = stored {
            if stored.region == region
                && super::config::same_start_url(&stored.start_url, start_url)
                && stored.expires_at - now > REGISTRATION_MARGIN
            {
                return Ok(stored);
            }
        }
    }
    let registration = sso::register_client(ctx, region, start_url).await?;
    if let Some(id) = conn_id {
        if let Ok(value) = serde_json::to_value(&registration) {
            let id = sso_client_secret_id(id);
            let _ = ctx
                .with_store(move |store| store.put_and_remove(vec![(id, value)], &[]))
                .await;
        }
    }
    Ok(registration)
}

/// A started device sign-in.
#[derive(Debug, Clone)]
pub struct PendingSignIn {
    pub registration: Registration,
    pub authorization: DeviceAuthorization,
    pub start_url: String,
}

/// Registers (or reuses the registration) and starts the device
/// authorization.
pub async fn begin_sign_in(
    ctx: &AwsContext,
    conn_id: Option<&str>,
    region: &str,
    start_url: &str,
) -> Result<PendingSignIn, AwsError> {
    let registration = registration(ctx, conn_id, region, start_url).await?;
    let authorization = sso::start_device_authorization(ctx, &registration, start_url).await?;
    Ok(PendingSignIn {
        registration,
        authorization,
        start_url: start_url.to_string(),
    })
}

/// Polls until the user approves, then stores the token (CLI cache +
/// vault).
pub async fn complete_sign_in(
    ctx: &AwsContext,
    conn_id: Option<&str>,
    pending: &PendingSignIn,
    sleep: &Sleeper,
) -> Result<SsoToken, DeviceFlowError> {
    let grant =
        sso::poll_device_token(ctx, &pending.registration, &pending.authorization, sleep).await?;
    let token = grant.into_sso_token(&pending.registration, &pending.start_url);
    let (ctx, copy, id) = (ctx.clone(), token.clone(), conn_id.map(str::to_string));
    tokio::task::spawn_blocking(move || save_token(&ctx, id.as_deref(), &copy))
        .await
        .map_err(|e| DeviceFlowError::Aws(AwsError::Invalid(e.to_string())))?
        .map_err(DeviceFlowError::Aws)?;
    Ok(token)
}

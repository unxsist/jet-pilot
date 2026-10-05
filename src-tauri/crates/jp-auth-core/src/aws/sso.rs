//! IAM Identity Center: the OIDC service (client registration, device
//! authorization, tokens) and the SSO portal (accounts, roles, role
//! credentials). These calls are unsigned; the portal ones carry the
//! access token.

use std::future::Future;
use std::pin::Pin;
use std::time::Duration;

use futures_util_lite::buffered;
use serde::{Deserialize, Serialize};
use zeroize::Zeroize;

use super::cli_cache::SsoToken;
use super::creds::AwsCredentials;
use super::{sdk_error, AwsContext, AwsError};
use crate::aws_client_config;

/// The client name JET Pilot registers with.
pub const CLIENT_NAME: &str = "JET Pilot";
pub const SCOPES: &[&str] = &["sso:account:access"];
const GRANT_DEVICE: &str = "urn:ietf:params:oauth:grant-type:device_code";
const GRANT_REFRESH: &str = "refresh_token";
/// RFC 8628: polling interval default and slow-down increment.
const DEFAULT_INTERVAL: u64 = 5;
const SLOW_DOWN: u64 = 5;
/// Concurrent `ListAccountRoles` calls.
const ROLE_CONCURRENCY: usize = 8;

fn oidc(ctx: &AwsContext, region: &str) -> aws_sdk_ssooidc::Client {
    let builder = aws_client_config!(
        aws_sdk_ssooidc::Config::builder(),
        ctx,
        region,
        ctx.endpoints.oidc.as_deref()
    );
    aws_sdk_ssooidc::Client::from_conf(builder.build())
}

fn portal(ctx: &AwsContext, region: &str) -> aws_sdk_sso::Client {
    let builder = aws_client_config!(
        aws_sdk_sso::Config::builder(),
        ctx,
        region,
        ctx.endpoints.portal.as_deref()
    );
    aws_sdk_sso::Client::from_conf(builder.build())
}

/// A public OIDC client registered for a start URL.
#[derive(Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Registration {
    pub client_id: String,
    pub client_secret: String,
    /// Unix seconds.
    pub expires_at: i64,
    pub region: String,
    pub start_url: String,
    #[serde(default)]
    pub scopes: Vec<String>,
}

impl Drop for Registration {
    fn drop(&mut self) {
        self.client_secret.zeroize();
    }
}

impl std::fmt::Debug for Registration {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Registration")
            .field("region", &self.region)
            .field("start_url", &self.start_url)
            .field("expires_at", &self.expires_at)
            .finish()
    }
}

/// `RegisterClient` (public client, device code + refresh token grants).
pub async fn register_client(
    ctx: &AwsContext,
    region: &str,
    start_url: &str,
) -> Result<Registration, AwsError> {
    let output = oidc(ctx, region)
        .register_client()
        .client_name(CLIENT_NAME)
        .client_type("public")
        .set_scopes(Some(SCOPES.iter().map(|s| s.to_string()).collect()))
        .grant_types(GRANT_DEVICE)
        .grant_types(GRANT_REFRESH)
        .issuer_url(start_url)
        .send()
        .await
        .map_err(sdk_error)?;
    let (Some(client_id), Some(client_secret)) = (output.client_id(), output.client_secret())
    else {
        return Err(AwsError::Invalid(
            "IAM Identity Center did not register JET Pilot".to_string(),
        ));
    };
    Ok(Registration {
        client_id: client_id.to_string(),
        client_secret: client_secret.to_string(),
        expires_at: output.client_secret_expires_at(),
        region: region.to_string(),
        start_url: start_url.to_string(),
        scopes: SCOPES.iter().map(|s| s.to_string()).collect(),
    })
}

/// A pending device authorization: the user enters `user_code` at
/// `verification_uri` (or opens `verification_uri_complete`).
#[derive(Clone, PartialEq)]
pub struct DeviceAuthorization {
    pub device_code: String,
    pub user_code: String,
    pub verification_uri: String,
    pub verification_uri_complete: Option<String>,
    /// Unix seconds.
    pub expires_at: i64,
    /// Seconds between polls.
    pub interval: u64,
}

impl std::fmt::Debug for DeviceAuthorization {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DeviceAuthorization")
            .field("user_code", &self.user_code)
            .field("verification_uri", &self.verification_uri)
            .field("expires_at", &self.expires_at)
            .field("interval", &self.interval)
            .finish()
    }
}

/// `StartDeviceAuthorization`.
pub async fn start_device_authorization(
    ctx: &AwsContext,
    registration: &Registration,
    start_url: &str,
) -> Result<DeviceAuthorization, AwsError> {
    let output = oidc(ctx, &registration.region)
        .start_device_authorization()
        .client_id(&registration.client_id)
        .client_secret(&registration.client_secret)
        .start_url(start_url)
        .send()
        .await
        .map_err(sdk_error)?;
    let missing = || AwsError::Invalid("IAM Identity Center did not start the sign-in".to_string());
    Ok(DeviceAuthorization {
        device_code: output.device_code().ok_or_else(missing)?.to_string(),
        user_code: output.user_code().ok_or_else(missing)?.to_string(),
        verification_uri: output.verification_uri().ok_or_else(missing)?.to_string(),
        verification_uri_complete: output.verification_uri_complete().map(str::to_string),
        expires_at: super::now() + i64::from(output.expires_in().max(60)),
        interval: u64::try_from(output.interval())
            .ok()
            .filter(|i| *i > 0)
            .unwrap_or(DEFAULT_INTERVAL),
    })
}

/// A token from `CreateToken`.
#[derive(Clone, PartialEq)]
pub struct TokenGrant {
    pub access_token: String,
    /// Unix seconds.
    pub expires_at: i64,
    pub refresh_token: Option<String>,
}

impl Drop for TokenGrant {
    fn drop(&mut self) {
        self.access_token.zeroize();
        self.refresh_token.zeroize();
    }
}

impl std::fmt::Debug for TokenGrant {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TokenGrant")
            .field("expires_at", &self.expires_at)
            .field("refresh_token", &self.refresh_token.is_some())
            .finish()
    }
}

impl TokenGrant {
    /// The token as the CLI caches it (with the registration that can
    /// refresh it).
    pub fn into_sso_token(self, registration: &Registration, start_url: &str) -> SsoToken {
        SsoToken {
            start_url: start_url.to_string(),
            region: registration.region.clone(),
            access_token: self.access_token.clone(),
            expires_at: self.expires_at,
            client_id: Some(registration.client_id.clone()),
            client_secret: Some(registration.client_secret.clone()),
            registration_expires_at: Some(registration.expires_at),
            refresh_token: self.refresh_token.clone(),
        }
    }
}

fn grant(
    output: aws_sdk_ssooidc::operation::create_token::CreateTokenOutput,
) -> Result<TokenGrant, AwsError> {
    let access_token = output
        .access_token()
        .filter(|t| !t.is_empty())
        .ok_or_else(|| {
            AwsError::Invalid("IAM Identity Center returned no access token".to_string())
        })?
        .to_string();
    Ok(TokenGrant {
        access_token,
        expires_at: super::now() + i64::from(output.expires_in().max(0)),
        refresh_token: output
            .refresh_token()
            .filter(|t| !t.is_empty())
            .map(str::to_string),
    })
}

/// How a device flow ended without a token.
#[derive(Debug, Clone, PartialEq)]
pub enum DeviceFlowError {
    /// The code expired before it was approved.
    Expired,
    /// The user denied the request.
    Denied,
    Aws(AwsError),
}

impl std::fmt::Display for DeviceFlowError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            DeviceFlowError::Expired => f.write_str(
                "The sign-in code expired before it was approved. Start the sign-in again.",
            ),
            DeviceFlowError::Denied => f.write_str("The sign-in was denied in the browser."),
            DeviceFlowError::Aws(error) => write!(f, "{error}"),
        }
    }
}

/// Waits between polls; tests pass one that returns immediately.
pub type Sleeper = dyn Fn(Duration) -> Pin<Box<dyn Future<Output = ()> + Send>> + Send + Sync;

/// `tokio::time::sleep`.
pub fn tokio_sleeper() -> Box<Sleeper> {
    Box::new(|duration| Box::pin(tokio::time::sleep(duration)))
}

/// Polls `CreateToken` until the user approves (RFC 8628): pending keeps
/// polling, `SlowDown` adds 5 s to the interval, an expired code or a
/// denial ends it. Cancel by dropping the future.
pub async fn poll_device_token(
    ctx: &AwsContext,
    registration: &Registration,
    authorization: &DeviceAuthorization,
    sleep: &Sleeper,
) -> Result<TokenGrant, DeviceFlowError> {
    let client = oidc(ctx, &registration.region);
    let mut interval = authorization.interval.max(1);
    loop {
        if super::now() > authorization.expires_at {
            return Err(DeviceFlowError::Expired);
        }
        let result = client
            .create_token()
            .client_id(&registration.client_id)
            .client_secret(&registration.client_secret)
            .grant_type(GRANT_DEVICE)
            .device_code(&authorization.device_code)
            .send()
            .await;
        match result {
            Ok(output) => return grant(output).map_err(DeviceFlowError::Aws),
            Err(error) => match sdk_error(error) {
                AwsError::Service {
                    code: Some(code), ..
                } if code == "AuthorizationPendingException" => {}
                AwsError::Service {
                    code: Some(code), ..
                } if code == "SlowDownException" => interval += SLOW_DOWN,
                AwsError::Service {
                    code: Some(code), ..
                } if code == "ExpiredTokenException" => return Err(DeviceFlowError::Expired),
                AwsError::Service {
                    code: Some(code), ..
                } if code == "AccessDeniedException" => return Err(DeviceFlowError::Denied),
                other => return Err(DeviceFlowError::Aws(other)),
            },
        }
        sleep(Duration::from_secs(interval)).await;
    }
}

/// `CreateToken` with the refresh token. A rejected refresh token means
/// signing in again.
pub async fn refresh(ctx: &AwsContext, token: &SsoToken) -> Result<TokenGrant, AwsError> {
    let (Some(client_id), Some(client_secret), Some(refresh_token)) =
        (&token.client_id, &token.client_secret, &token.refresh_token)
    else {
        return Err(AwsError::SignInRequired(
            "The AWS sign-in can't be renewed".to_string(),
        ));
    };
    let result = oidc(ctx, &token.region)
        .create_token()
        .client_id(client_id)
        .client_secret(client_secret)
        .grant_type(GRANT_REFRESH)
        .refresh_token(refresh_token)
        .send()
        .await;
    match result {
        Ok(output) => grant(output),
        Err(error) => match sdk_error(error) {
            AwsError::Service { code, message }
                if code.as_deref().is_some_and(|c| {
                    matches!(
                        c,
                        "InvalidGrantException"
                            | "ExpiredTokenException"
                            | "InvalidClientException"
                            | "UnauthorizedClientException"
                            | "AccessDeniedException"
                    )
                }) =>
            {
                Err(AwsError::SignInRequired(format!(
                    "The AWS sign-in expired ({message})"
                )))
            }
            other => Err(other),
        },
    }
}

fn portal_error(error: AwsError) -> AwsError {
    match error {
        AwsError::Service {
            code: Some(code), ..
        } if code == "UnauthorizedException" => {
            AwsError::SignInRequired("The AWS sign-in expired".to_string())
        }
        other => other,
    }
}

/// `GetRoleCredentials`.
pub async fn role_credentials(
    ctx: &AwsContext,
    region: &str,
    access_token: &str,
    account_id: &str,
    role_name: &str,
) -> Result<AwsCredentials, AwsError> {
    let output = portal(ctx, region)
        .get_role_credentials()
        .access_token(access_token)
        .account_id(account_id)
        .role_name(role_name)
        .send()
        .await
        .map_err(|e| portal_error(sdk_error(e)))?;
    let credentials = output
        .role_credentials()
        .ok_or_else(|| AwsError::Invalid("AWS returned no role credentials".to_string()))?;
    let (Some(key), Some(secret)) = (credentials.access_key_id(), credentials.secret_access_key())
    else {
        return Err(AwsError::Invalid(
            "AWS returned incomplete role credentials".to_string(),
        ));
    };
    Ok(AwsCredentials {
        access_key_id: key.to_string(),
        secret_access_key: secret.to_string(),
        session_token: credentials.session_token().map(str::to_string),
        expires_at: Some(credentials.expiration() / 1000).filter(|at| *at > 0),
    })
}

/// An account the signed-in user can access, with their roles in it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SsoAccount {
    pub account_id: String,
    pub account_name: String,
    pub email: Option<String>,
    pub roles: Vec<String>,
}

/// `ListAccounts` + `ListAccountRoles` (paginated, 8 role listings at a
/// time; throttling is retried with backoff by the SDK).
pub async fn accounts(
    ctx: &AwsContext,
    region: &str,
    access_token: &str,
) -> Result<Vec<SsoAccount>, AwsError> {
    let client = portal(ctx, region);
    let mut accounts = Vec::new();
    let mut next: Option<String> = None;
    loop {
        let page = client
            .list_accounts()
            .access_token(access_token)
            .max_results(100)
            .set_next_token(next.take())
            .send()
            .await
            .map_err(|e| portal_error(sdk_error(e)))?;
        for account in page.account_list() {
            let Some(id) = account.account_id() else {
                continue;
            };
            accounts.push(SsoAccount {
                account_id: id.to_string(),
                account_name: account.account_name().unwrap_or(id).to_string(),
                email: account.email_address().map(str::to_string),
                roles: Vec::new(),
            });
        }
        match page.next_token() {
            Some(token) if !token.is_empty() => next = Some(token.to_string()),
            _ => break,
        }
    }
    let roles = buffered(
        accounts.iter().map(|account| {
            let client = client.clone();
            let id = account.account_id.clone();
            let access_token = access_token.to_string();
            async move { account_roles(&client, &access_token, &id).await }
        }),
        ROLE_CONCURRENCY,
    )
    .await;
    for (account, roles) in accounts.iter_mut().zip(roles) {
        account.roles = roles?;
    }
    accounts.sort_by(|a, b| {
        a.account_name
            .to_lowercase()
            .cmp(&b.account_name.to_lowercase())
    });
    Ok(accounts)
}

async fn account_roles(
    client: &aws_sdk_sso::Client,
    access_token: &str,
    account_id: &str,
) -> Result<Vec<String>, AwsError> {
    let mut roles = Vec::new();
    let mut next: Option<String> = None;
    loop {
        let page = client
            .list_account_roles()
            .access_token(access_token)
            .account_id(account_id)
            .max_results(100)
            .set_next_token(next.take())
            .send()
            .await
            .map_err(|e| portal_error(sdk_error(e)))?;
        roles.extend(
            page.role_list()
                .iter()
                .filter_map(|r| r.role_name().map(str::to_string)),
        );
        match page.next_token() {
            Some(token) if !token.is_empty() => next = Some(token.to_string()),
            _ => break,
        }
    }
    roles.sort();
    roles.dedup();
    Ok(roles)
}

/// A tiny `buffered` (ordered, at most `limit` futures at a time) so the
/// helper needs no `futures` dependency.
mod futures_util_lite {
    use std::future::Future;

    pub async fn buffered<F, T>(futures: impl IntoIterator<Item = F>, limit: usize) -> Vec<T>
    where
        F: Future<Output = T> + Send + 'static,
        T: Send + 'static,
    {
        let semaphore = std::sync::Arc::new(tokio::sync::Semaphore::new(limit.max(1)));
        let handles: Vec<_> = futures
            .into_iter()
            .map(|future| {
                let semaphore = semaphore.clone();
                tokio::spawn(async move {
                    let _permit = semaphore
                        .acquire_owned()
                        .await
                        .expect("semaphore is never closed");
                    future.await
                })
            })
            .collect();
        let mut out = Vec::with_capacity(handles.len());
        for handle in handles {
            match handle.await {
                Ok(value) => out.push(value),
                Err(e) => std::panic::resume_unwind(e.into_panic()),
            }
        }
        out
    }
}

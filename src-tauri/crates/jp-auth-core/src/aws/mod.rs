//! AWS for JET Pilot and the helper (feature `aws`), without the aws CLI:
//!
//! - [`config`]: `~/.aws/config` + `~/.aws/credentials` (profiles,
//!   `sso-session`s), never returning secret values;
//! - [`cli_cache`]: the standard `~/.aws/sso/cache/<sha1>.json` token
//!   files, written byte-compatible with the aws CLI;
//! - [`sso`]: IAM Identity Center OIDC (client registration, device
//!   authorization, tokens) and the SSO portal (accounts, roles, role
//!   credentials);
//! - [`session`]: the SSO session of a connection (vault + CLI cache,
//!   silent refresh with the refresh token, never interactive);
//! - [`creds`]: credentials of a connection (SSO role, profile via
//!   aws-config, access keys, MFA sessions), cached in the vault;
//! - [`token`]: presigned `sts:GetCallerIdentity` EKS tokens.
//!
//! The SDK clients all use [`http::http_client`]: rustls with ring.

pub mod cli_cache;
pub mod config;
pub mod creds;
#[cfg(any(test, feature = "test-util"))]
pub mod fake;
pub mod http;
pub mod session;
pub mod sso;
#[cfg(test)]
mod tests;
pub mod token;

use std::path::PathBuf;
use std::time::Duration;

pub use aws_config;
pub use aws_credential_types;
pub use aws_sdk_sso;
pub use aws_sdk_ssooidc;
pub use aws_sdk_sts;
pub use aws_sigv4;
pub use aws_smithy_async;
pub use aws_smithy_runtime_api;
pub use aws_smithy_types;

use crate::vault::{Store, VaultError};

/// What went wrong talking to AWS. Messages are user-facing and never
/// contain credentials.
#[derive(Debug, Clone, PartialEq)]
pub enum AwsError {
    /// Signing in in JET Pilot is needed: no SSO session, or it expired and
    /// can't be refreshed silently.
    SignInRequired(String),
    /// The profile needs a fresh MFA code.
    MfaRequired(String),
    Vault(VaultError),
    /// The connection or profile does not exist.
    NotFound(String),
    /// AWS answered with an error.
    Service {
        code: Option<String>,
        message: String,
    },
    /// AWS could not be reached (or took too long).
    Network(String),
    Invalid(String),
}

impl std::fmt::Display for AwsError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            AwsError::SignInRequired(message)
            | AwsError::MfaRequired(message)
            | AwsError::NotFound(message)
            | AwsError::Network(message)
            | AwsError::Invalid(message) => f.write_str(message),
            AwsError::Vault(error) => write!(f, "{error}"),
            AwsError::Service { code, message } => match code {
                Some(code) if !message.contains(code.as_str()) => {
                    write!(f, "AWS: {message} ({code})")
                }
                _ => write!(f, "AWS: {message}"),
            },
        }
    }
}

impl std::error::Error for AwsError {}

impl From<VaultError> for AwsError {
    fn from(error: VaultError) -> Self {
        AwsError::Vault(error)
    }
}

impl AwsError {
    pub fn service_code(&self) -> Option<&str> {
        match self {
            AwsError::Service { code, .. } => code.as_deref(),
            _ => None,
        }
    }
}

/// Converts an SDK error, keeping the service error code.
pub(crate) fn sdk_error<E, R>(
    error: aws_smithy_runtime_api::client::result::SdkError<E, R>,
) -> AwsError
where
    E: aws_smithy_types::error::metadata::ProvideErrorMetadata
        + std::error::Error
        + Send
        + Sync
        + 'static,
    R: std::fmt::Debug,
{
    use aws_smithy_runtime_api::client::result::SdkError;
    use aws_smithy_types::error::display::DisplayErrorContext;
    match &error {
        SdkError::ServiceError(service) => {
            let err = service.err();
            let code = err.code().map(str::to_string);
            let message = err
                .message()
                .map(str::to_string)
                .or_else(|| code.clone())
                .unwrap_or_else(|| "the request failed".to_string());
            AwsError::Service {
                code,
                message: crate::redact(&message),
            }
        }
        SdkError::TimeoutError(_) => AwsError::Network("AWS did not answer in time".to_string()),
        _ => AwsError::Network(crate::redact(&format!(
            "AWS could not be reached: {}",
            DisplayErrorContext(&error)
        ))),
    }
}

/// Base URL overrides (tests point the clients at fake servers).
#[derive(Debug, Clone, Default)]
pub struct Endpoints {
    pub oidc: Option<String>,
    pub portal: Option<String>,
    pub sts: Option<String>,
    pub eks: Option<String>,
    pub ec2: Option<String>,
}

/// Everything AWS calls depend on: where things are, the vault, timeouts.
#[derive(Clone)]
pub struct AwsContext {
    pub store: Store,
    /// `connections.json`.
    pub connections_file: PathBuf,
    /// Where cross-process locks go (the JET Pilot home).
    pub lock_dir: PathBuf,
    /// The user's home (`~/.aws/sso/cache`, default `~/.aws/config`).
    pub home: Option<PathBuf>,
    /// `AWS_CONFIG_FILE` / `AWS_SHARED_CREDENTIALS_FILE` (None = default).
    pub config_file: Option<PathBuf>,
    pub credentials_file: Option<PathBuf>,
    pub endpoints: Endpoints,
    /// Per-attempt timeout of an API call.
    pub timeout: Duration,
    pub max_attempts: u32,
    pub initial_backoff: Duration,
}

fn env_path(name: &str) -> Option<PathBuf> {
    std::env::var_os(name)
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
}

impl AwsContext {
    /// The real environment: the system vault (or `store`), the JET Pilot
    /// home and the user's `~/.aws`.
    pub fn system(store: Store) -> AwsContext {
        let home = crate::paths::jet_pilot_home();
        AwsContext {
            store,
            connections_file: home.join(crate::connections::FILE_NAME),
            lock_dir: home,
            home: crate::paths::user_home(),
            config_file: env_path("AWS_CONFIG_FILE"),
            credentials_file: env_path("AWS_SHARED_CREDENTIALS_FILE"),
            endpoints: Endpoints::default(),
            timeout: Duration::from_secs(10),
            max_attempts: 4,
            initial_backoff: Duration::from_millis(500),
        }
    }

    pub fn aws_config_path(&self) -> Option<PathBuf> {
        self.config_file
            .clone()
            .or_else(|| self.home.as_ref().map(|h| h.join(".aws").join("config")))
    }

    pub fn aws_credentials_path(&self) -> Option<PathBuf> {
        self.credentials_file.clone().or_else(|| {
            self.home
                .as_ref()
                .map(|h| h.join(".aws").join("credentials"))
        })
    }

    /// `~/.aws/sso/cache`.
    pub fn sso_cache_dir(&self) -> Option<PathBuf> {
        self.home
            .as_ref()
            .map(|h| h.join(".aws").join("sso").join("cache"))
    }

    pub fn connection(&self, id: &str) -> Result<crate::connections::CloudConnection, AwsError> {
        crate::connections::find(&self.connections_file, id)
            .map_err(|e| {
                AwsError::Invalid(format!("The JET Pilot connections can't be read: {e}"))
            })?
            .ok_or_else(|| {
                AwsError::NotFound(
                    "This AWS connection no longer exists in JET Pilot. Add the cluster again."
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
}

/// Unix seconds now.
pub fn now() -> i64 {
    crate::now_secs()
}

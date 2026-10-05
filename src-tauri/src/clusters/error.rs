//! The error type of the clusters and vault commands. Messages are one
//! user-facing line and never contain secrets; `field` names the input a
//! validation error belongs to.

use jp_auth_core::vault::VaultError;
use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum AppErrorCode {
    /// A passphrase vault needs unlocking (`vault://unlock-required` was
    /// emitted).
    VaultLocked,
    /// No OS keychain: set up a passphrase vault first.
    KeychainUnavailable,
    InvalidInput,
    Conflict,
    NotFound,
    Io,
    Internal,
    /// A cloud connection needs an interactive sign-in first (IAM Identity
    /// Center session expired / never signed in).
    SignInRequired,
    /// An AWS profile with `mfa_serial` needs a fresh MFA code.
    MfaRequired,
    /// The cloud provider answered with an error or could not be reached.
    Provider,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct AppError {
    pub code: AppErrorCode,
    pub message: String,
    pub field: Option<String>,
}

impl AppError {
    pub fn new(code: AppErrorCode, message: impl Into<String>) -> AppError {
        AppError {
            code,
            message: one_line(message.into()),
            field: None,
        }
    }

    pub fn invalid(field: impl Into<String>, message: impl Into<String>) -> AppError {
        AppError::new(AppErrorCode::InvalidInput, message).with_field(field)
    }

    pub fn conflict(message: impl Into<String>) -> AppError {
        AppError::new(AppErrorCode::Conflict, message)
    }

    pub fn not_found(message: impl Into<String>) -> AppError {
        AppError::new(AppErrorCode::NotFound, message)
    }

    pub fn internal(message: impl Into<String>) -> AppError {
        AppError::new(AppErrorCode::Internal, message)
    }

    /// An I/O failure: `what` failed, with the OS reason.
    pub fn io(what: impl std::fmt::Display, error: impl std::fmt::Display) -> AppError {
        AppError::new(AppErrorCode::Io, format!("{what}: {error}"))
    }

    pub fn with_field(mut self, field: impl Into<String>) -> AppError {
        self.field = Some(field.into());
        self
    }
}

/// The first line, trimmed, redacted.
fn one_line(message: String) -> String {
    let line = message
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .unwrap_or_default();
    jp_auth_core::redact(line)
}

impl std::fmt::Display for AppError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for AppError {}

impl From<VaultError> for AppError {
    fn from(error: VaultError) -> AppError {
        let message = error.to_string();
        match error {
            VaultError::Locked => AppError::new(
                AppErrorCode::VaultLocked,
                "The JET Pilot vault is locked. Unlock it with your passphrase to continue.",
            ),
            VaultError::KeychainUnavailable(_) => {
                AppError::new(AppErrorCode::KeychainUnavailable, message)
            }
            VaultError::WrongPassphrase | VaultError::WeakPassphrase => {
                AppError::invalid("passphrase", message)
            }
            VaultError::AlreadyInitialized | VaultError::NotPassphraseProtected => {
                AppError::conflict(message)
            }
            VaultError::NotInitialized => AppError::not_found(message),
            VaultError::Corrupt(_) | VaultError::Io(_) => AppError::new(AppErrorCode::Io, message),
        }
    }
}

impl From<jp_auth_core::aws::AwsError> for AppError {
    fn from(error: jp_auth_core::aws::AwsError) -> AppError {
        use jp_auth_core::aws::AwsError;
        let message = error.to_string();
        match error {
            AwsError::SignInRequired(_) => AppError::new(AppErrorCode::SignInRequired, message),
            AwsError::MfaRequired(_) => AppError::new(AppErrorCode::MfaRequired, message),
            AwsError::Vault(vault) => {
                if vault == VaultError::Locked {
                    crate::clusters::emit(crate::secrets::UNLOCK_REQUIRED_EVENT);
                }
                AppError::from(vault)
            }
            AwsError::NotFound(_) => AppError::not_found(message),
            AwsError::Invalid(_) => AppError::internal(message),
            AwsError::Service { .. } | AwsError::Network(_) => {
                AppError::new(AppErrorCode::Provider, message)
            }
        }
    }
}

/// File errors of the connection / catalog stores.
impl From<std::io::Error> for AppError {
    fn from(error: std::io::Error) -> AppError {
        AppError::io("A JET Pilot file can't be written", error)
    }
}

impl From<tauri::Error> for AppError {
    fn from(error: tauri::Error) -> AppError {
        AppError::internal(error.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serializes_camel_case_codes_and_one_line_messages() {
        let error = AppError::invalid("server", "Use https.\nsecond line token: abc");
        let json = serde_json::to_value(&error).unwrap();
        assert_eq!(
            json,
            serde_json::json!({"code": "invalidInput", "message": "Use https.", "field": "server"})
        );
        let locked: AppError = VaultError::Locked.into();
        assert_eq!(
            serde_json::to_value(&locked).unwrap()["code"],
            "vaultLocked"
        );
        let keychain: AppError = VaultError::KeychainUnavailable("none".into()).into();
        assert_eq!(keychain.code, AppErrorCode::KeychainUnavailable);
        assert_eq!(
            AppError::internal("token: abc").message,
            "token: [REDACTED]"
        );
    }
}

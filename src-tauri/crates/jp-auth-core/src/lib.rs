//! Credential plumbing shared by JET Pilot and `jetpilot-auth`, the small
//! kubectl credential helper that makes clusters added in JET Pilot work in
//! external terminals (kubectl, k9s, ...).
//!
//! - [`paths`]: the JET Pilot home directory (`~/.kube/jet-pilot`).
//! - [`vault`]: the encrypted secrets file and where its key comes from (OS
//!   keychain, or a passphrase with an optional kernel-keyring unlock cache).
//! - [`credentials`]: what the vault stores per cluster.
//! - [`exec_credential`]: the `ExecCredential` document kubectl expects.
//! - [`request`]: the helper's command line.
//! - [`redact`]: masking secrets in human-readable text.
//! - [`connections`]: cloud connections (`connections.json`, no secrets).
//! - [`cache`]: short-lived credentials cached in the vault.
//! - [`aws`] (feature `aws`): IAM Identity Center, `~/.aws` profiles and
//!   EKS tokens, shared by the app and the helper.
//!
//! Nothing here depends on Tauri or kube-rs.

#[cfg(feature = "aws")]
pub mod aws;
pub mod cache;
pub mod connections;
pub mod credentials;
pub mod exec_credential;
pub mod fsutil;
pub mod paths;
pub mod redact;
pub mod request;
pub mod time;
pub mod vault;

pub use redact::redact;
pub use zeroize;

/// The helper's binary name (without `.exe`).
pub const HELPER_NAME: &str = "jetpilot-auth";

/// Environment flag: never use the OS keychain (tests, headless setups).
pub const NO_KEYCHAIN_ENV: &str = "JET_PILOT_NO_KEYCHAIN";
/// Environment flag: never use the Linux kernel keyring unlock cache.
pub const NO_KEYUTILS_ENV: &str = "JET_PILOT_NO_KEYUTILS";
/// The vault passphrase for non-interactive use of the helper (automation,
/// tests). Only consulted when a passphrase vault is otherwise locked.
pub const PASSPHRASE_ENV: &str = "JET_PILOT_VAULT_PASSPHRASE";

/// Whether an environment flag is set to something truthy.
pub fn env_flag(name: &str) -> bool {
    std::env::var_os(name).is_some_and(|value| {
        let value = value.to_string_lossy().trim().to_ascii_lowercase();
        !value.is_empty() && value != "0" && value != "false" && value != "no"
    })
}

/// Seconds since the Unix epoch.
pub fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or_default()
}

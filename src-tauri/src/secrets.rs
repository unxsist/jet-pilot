//! The vault in the app: commands to set up, unlock, lock, re-key and reset
//! it, and the secret access the clusters module (and the credential broker)
//! use. See `jp_auth_core::vault` for the file format and key sources.
//!
//! A keychain-backed vault initializes itself on the first secret write. A
//! passphrase vault's key is kept in memory after `vault_unlock` (and, on
//! Linux, optionally in the kernel keyring for the helper in terminals).
//! An operation that needs a locked vault emits `vault://unlock-required`
//! and fails with `vaultLocked`. No command ever returns a secret.

use std::sync::Mutex;

use jp_auth_core::credentials::{env_secret_id, static_secret_id, EnvSecrets, StaticCredential};
use jp_auth_core::vault::{MasterKey, Vault, VaultEnv, VaultError, VaultStatus};
use jp_auth_core::zeroize::Zeroizing;
use once_cell::sync::Lazy;
use tracing::{info, warn};

use crate::clusters::error::AppError;
use crate::util::lock;

pub const UNLOCK_REQUIRED_EVENT: &str = "vault://unlock-required";

struct State {
    /// Lazily the system vault; tests swap in their own.
    env: Option<VaultEnv>,
    /// The key of an unlocked passphrase vault.
    session: Option<MasterKey>,
}

static STATE: Lazy<Mutex<State>> = Lazy::new(|| {
    Mutex::new(State {
        env: None,
        session: None,
    })
});

fn snapshot() -> (VaultEnv, Option<MasterKey>) {
    let mut state = lock(&STATE);
    let env = state.env.get_or_insert_with(VaultEnv::system).clone();
    (env, state.session.clone())
}

fn set_session(key: Option<MasterKey>) {
    lock(&STATE).session = key;
}

/// Points the vault at a test environment (and forgets any unlock).
#[cfg(test)]
pub(crate) fn use_test_env(env: VaultEnv) {
    let mut state = lock(&STATE);
    state.env = Some(env);
    state.session = None;
}

/// The vault environment in use (tests).
#[cfg(test)]
pub(crate) fn test_env() -> VaultEnv {
    snapshot().0
}

/// Serialises tests that use the process-wide vault.
#[cfg(test)]
pub(crate) static TEST_VAULT_LOCK: Mutex<()> = Mutex::new(());

fn map_error(error: VaultError) -> AppError {
    if error == VaultError::Locked {
        crate::clusters::emit(UNLOCK_REQUIRED_EVENT);
    }
    AppError::from(error)
}

fn open() -> Result<Vault, AppError> {
    let (env, session) = snapshot();
    Vault::open_with(&env, session.as_ref()).map_err(map_error)
}

/* ------------------------------------------------- for other modules */

/// The vault (with the in-app key of an unlocked passphrase vault) for
/// code that opens it itself (the AWS credential paths).
pub(crate) fn store() -> jp_auth_core::vault::Store {
    let (env, session) = snapshot();
    jp_auth_core::vault::Store::new(env, session)
}

/// Stores secrets in one write (initializing a keychain vault if needed).
pub(crate) fn put_many(items: Vec<(String, serde_json::Value)>) -> Result<(), AppError> {
    if items.is_empty() {
        return Ok(());
    }
    open()?.put_many(items).map_err(map_error)
}

/// Removes secrets; a vault that doesn't exist has nothing to remove.
pub(crate) fn remove_many(ids: &[String]) -> Result<usize, AppError> {
    if ids.is_empty() {
        return Ok(0);
    }
    let mut vault = open()?;
    if !vault.is_initialized() {
        return Ok(0);
    }
    vault.remove_many(ids).map_err(map_error)
}

/// One secret, if stored.
pub(crate) fn get(id: &str) -> Result<Option<serde_json::Value>, AppError> {
    Ok(open()?.get(id))
}

/// The token / client certificate of a cluster added in JET Pilot (for
/// minting credentials in-process instead of running the helper).
#[allow(dead_code)]
pub fn static_credential(cluster_id: &str) -> Result<Option<StaticCredential>, AppError> {
    get(&static_secret_id(cluster_id))?
        .map(|value| {
            serde_json::from_value(value).map_err(|_| {
                AppError::internal("The stored credentials of this cluster are not valid.")
            })
        })
        .transpose()
}

/// The secret exec environment of a cluster added in JET Pilot.
#[allow(dead_code)]
pub fn env_secrets(cluster_id: &str) -> Result<Option<EnvSecrets>, AppError> {
    get(&env_secret_id(cluster_id))?
        .map(|value| {
            serde_json::from_value(value).map_err(|_| {
                AppError::internal("The stored environment of this cluster is not valid.")
            })
        })
        .transpose()
}

fn status_now() -> VaultStatus {
    let (env, session) = snapshot();
    Vault::status(&env, session.as_ref())
}

/* ------------------------------------------------------------ commands */

/// Backend, set-up and lock state of the vault. Never prompts.
#[tauri::command]
pub async fn vault_status() -> Result<VaultStatus, AppError> {
    crate::clusters::blocking(|| Ok(status_now())).await
}

/// Sets up a passphrase vault (when there is no keychain) and unlocks it.
#[tauri::command]
pub async fn vault_init_passphrase(passphrase: String) -> Result<VaultStatus, AppError> {
    let passphrase = Zeroizing::new(passphrase);
    crate::clusters::blocking(move || {
        let (env, _) = snapshot();
        let key = Vault::init_passphrase(&env, &passphrase).map_err(AppError::from)?;
        set_session(Some(key));
        info!("Vault set up with a passphrase");
        Ok(status_now())
    })
    .await
}

/// Unlocks a passphrase vault for this session; with `cache_for_terminals`
/// also for the helper in terminals (Linux kernel keyring, 12 hours).
#[tauri::command]
pub async fn vault_unlock(
    passphrase: String,
    cache_for_terminals: bool,
) -> Result<VaultStatus, AppError> {
    let passphrase = Zeroizing::new(passphrase);
    crate::clusters::blocking(move || {
        let (env, _) = snapshot();
        let key = Vault::key_from_passphrase(&env, &passphrase).map_err(AppError::from)?;
        if cache_for_terminals {
            if let Err(reason) = Vault::cache_unlock(&env, &key) {
                warn!("Could not unlock the vault for terminals: {}", reason);
            }
        }
        set_session(Some(key));
        info!("Vault unlocked");
        Ok(status_now())
    })
    .await
}

/// Locks the vault again, here and for terminals.
#[tauri::command]
pub async fn vault_lock() -> Result<VaultStatus, AppError> {
    crate::clusters::blocking(|| {
        let (env, _) = snapshot();
        set_session(None);
        Vault::lock_terminals(&env);
        info!("Vault locked");
        Ok(status_now())
    })
    .await
}

/// Re-encrypts a passphrase vault with a new passphrase (stays unlocked;
/// terminals need to unlock again).
#[tauri::command]
pub async fn vault_change_passphrase(old: String, new: String) -> Result<VaultStatus, AppError> {
    let (old, new) = (Zeroizing::new(old), Zeroizing::new(new));
    crate::clusters::blocking(move || {
        let (env, _) = snapshot();
        let key = Vault::change_passphrase(&env, &old, &new).map_err(|e| match e {
            VaultError::WrongPassphrase => AppError::from(e).with_field("old"),
            VaultError::WeakPassphrase => AppError::from(e).with_field("new"),
            other => AppError::from(other),
        })?;
        set_session(Some(key));
        info!("Vault passphrase changed");
        Ok(status_now())
    })
    .await
}

/// Deletes the vault and its key. Every stored credential is lost (clusters
/// stay in the managed kubeconfig but need to be added again). `confirm`
/// must be `"reset"`.
#[tauri::command]
pub async fn vault_reset(confirm: String) -> Result<VaultStatus, AppError> {
    if confirm != "reset" {
        return Err(AppError::invalid("confirm", "Type \"reset\" to confirm."));
    }
    crate::clusters::blocking(|| {
        let (env, _) = snapshot();
        Vault::reset(&env).map_err(AppError::from)?;
        set_session(None);
        warn!("Vault reset: stored credentials were deleted");
        Ok(status_now())
    })
    .await
}

#[cfg(test)]
pub(crate) mod test_support {
    use std::sync::Arc;

    use jp_auth_core::vault::{KdfParams, MemoryKeychain, MemoryUnlockCache, VaultEnv};

    /// A vault in `dir` with an in-memory keychain (available or not).
    pub fn memory_env(dir: &std::path::Path, keychain: bool) -> (VaultEnv, Arc<MemoryKeychain>) {
        let chain = Arc::new(MemoryKeychain::new());
        chain.set_available(keychain);
        (
            VaultEnv {
                dir: dir.join("vault"),
                keychain: chain.clone(),
                unlock_cache: Arc::new(MemoryUnlockCache::default()),
                kdf: KdfParams::INSECURE_FOR_TESTS,
            },
            chain,
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[tokio::test]
    #[allow(clippy::await_holding_lock)]
    async fn commands_cover_the_passphrase_lifecycle() {
        let _guard = lock(&TEST_VAULT_LOCK);
        let dir = tempfile::tempdir().unwrap();
        let (env, _) = test_support::memory_env(dir.path(), false);
        use_test_env(env);

        let status = vault_status().await.unwrap();
        assert_eq!(serde_json::to_value(&status).unwrap()["backend"], "none");
        // No keychain and no vault: storing asks for a passphrase setup.
        let err = put_many(vec![("a".into(), json!(1))]).unwrap_err();
        assert_eq!(
            err.code,
            crate::clusters::error::AppErrorCode::KeychainUnavailable
        );

        let err = vault_init_passphrase("short".into()).await.unwrap_err();
        assert_eq!(err.field.as_deref(), Some("passphrase"));
        let status = vault_init_passphrase("a long passphrase".into())
            .await
            .unwrap();
        assert!(status.initialized && !status.locked);
        put_many(vec![("cluster:x:static".into(), json!({"token": "t"}))]).unwrap();
        assert_eq!(
            static_credential("x").unwrap().unwrap().token.as_deref(),
            Some("t")
        );

        let status = vault_lock().await.unwrap();
        assert!(status.locked);
        let err = get("cluster:x:static").unwrap_err();
        assert_eq!(err.code, crate::clusters::error::AppErrorCode::VaultLocked);

        let err = vault_unlock("wrong passphrase".into(), false)
            .await
            .unwrap_err();
        assert_eq!(err.field.as_deref(), Some("passphrase"));
        let status = vault_unlock("a long passphrase".into(), true)
            .await
            .unwrap();
        assert!(!status.locked && status.unlock_cached);

        let err = vault_change_passphrase("nope nope nope".into(), "another passphrase".into())
            .await
            .unwrap_err();
        assert_eq!(err.field.as_deref(), Some("old"));
        let status =
            vault_change_passphrase("a long passphrase".into(), "another passphrase".into())
                .await
                .unwrap();
        assert!(!status.locked && !status.unlock_cached);
        assert!(get("cluster:x:static").unwrap().is_some());

        assert_eq!(
            vault_reset("yes".into())
                .await
                .unwrap_err()
                .field
                .as_deref(),
            Some("confirm")
        );
        let status = vault_reset("reset".into()).await.unwrap();
        assert!(!status.initialized);
        assert_eq!(remove_many(&["cluster:x:static".into()]).unwrap(), 0);
    }
}

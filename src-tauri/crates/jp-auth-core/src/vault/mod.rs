//! The vault: secrets of clusters added in JET Pilot, envelope-encrypted in
//! `~/.kube/jet-pilot/vault/secrets.jpv` (see [`format`]).
//!
//! The master key comes from the OS keychain when there is one (the vault
//! then initializes itself on the first write), else from a passphrase the
//! user sets up. A passphrase vault is locked until unlocked: in the app by
//! keeping the key in memory, for terminals through the kernel keyring
//! [`keyutils`] cache.
//!
//! Writes take `vault/secrets.lock`, re-read the file, apply the change and
//! replace the file atomically (0600).

pub mod format;
pub mod keystore;
pub mod keyutils;

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use serde::Serialize;
use sha2::{Digest, Sha256};

pub use format::{Contents, KdfParams, KeySpec, MasterKey, StoredEntry};
pub use keystore::{system_keychain, Keychain, MemoryKeychain, NoKeychain, OsKeychain};
pub use keyutils::{
    system_unlock_cache, MemoryUnlockCache, NoUnlockCache, UnlockCache, UNLOCK_TTL,
};

use crate::fsutil;

pub const FILE_NAME: &str = "secrets.jpv";
const LOCK_NAME: &str = "secrets.lock";
const LOCK_TIMEOUT: Duration = Duration::from_secs(10);
pub const MIN_PASSPHRASE_CHARS: usize = 8;

/// Where the vault lives and where its key may come from.
#[derive(Clone)]
pub struct VaultEnv {
    pub dir: PathBuf,
    pub keychain: Arc<dyn Keychain>,
    pub unlock_cache: Arc<dyn UnlockCache>,
    /// Cost of new passphrase keys (existing vaults use their header's).
    pub kdf: KdfParams,
}

impl VaultEnv {
    /// `~/.kube/jet-pilot/vault`, the OS keychain and the kernel keyring
    /// cache (each subject to its disabling env flag).
    pub fn system() -> VaultEnv {
        VaultEnv {
            dir: crate::paths::vault_dir(),
            keychain: system_keychain(),
            unlock_cache: system_unlock_cache(),
            kdf: KdfParams::DEFAULT,
        }
    }

    pub fn file(&self) -> PathBuf {
        self.dir.join(FILE_NAME)
    }

    fn lock_path(&self) -> PathBuf {
        self.dir.join(LOCK_NAME)
    }

    /// The unlock cache entry of this vault (per vault directory).
    pub fn cache_id(&self) -> String {
        let digest = Sha256::digest(self.dir.to_string_lossy().as_bytes());
        let hex: String = digest[..8].iter().map(|b| format!("{b:02x}")).collect();
        format!("jet-pilot-vault:{hex}")
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum VaultError {
    /// A passphrase vault that hasn't been unlocked.
    Locked,
    /// The OS keychain can't be used (reason).
    KeychainUnavailable(String),
    /// The file is damaged, was modified, or its key is gone.
    Corrupt(String),
    Io(String),
    WrongPassphrase,
    NotInitialized,
    AlreadyInitialized,
    /// A passphrase operation on a keychain vault.
    NotPassphraseProtected,
    /// The new passphrase is too short.
    WeakPassphrase,
}

impl std::fmt::Display for VaultError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            VaultError::Locked => f.write_str("The JET Pilot vault is locked."),
            VaultError::KeychainUnavailable(reason) => {
                write!(f, "The system keychain is not available. {reason}")
            }
            VaultError::Corrupt(reason) => write!(f, "The JET Pilot vault can't be read: {reason}"),
            VaultError::Io(e) => write!(f, "The JET Pilot vault could not be accessed: {e}"),
            VaultError::WrongPassphrase => f.write_str("The passphrase is not correct."),
            VaultError::NotInitialized => {
                f.write_str("The JET Pilot vault has not been set up yet.")
            }
            VaultError::AlreadyInitialized => f.write_str("The JET Pilot vault is already set up."),
            VaultError::NotPassphraseProtected => {
                f.write_str("The JET Pilot vault uses the system keychain, not a passphrase.")
            }
            VaultError::WeakPassphrase => write!(
                f,
                "Use a passphrase of at least {MIN_PASSPHRASE_CHARS} characters."
            ),
        }
    }
}

impl std::error::Error for VaultError {}

impl From<std::io::Error> for VaultError {
    fn from(e: std::io::Error) -> Self {
        VaultError::Io(e.to_string())
    }
}

fn format_error(e: format::FormatError) -> VaultError {
    match e {
        format::FormatError::Malformed(reason) => VaultError::Corrupt(reason),
        format::FormatError::Unsupported(v) => VaultError::Corrupt(format!(
            "it was written by a newer JET Pilot (format version {v})"
        )),
        format::FormatError::Decrypt => {
            VaultError::Corrupt("the file is damaged or was modified".into())
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Backend {
    Keychain,
    Passphrase,
    None,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultStatus {
    /// The backend in use; for a vault that isn't set up yet the one the
    /// first write will use (`keychain` when available, else `none`: a
    /// passphrase must be set up first).
    pub backend: Backend,
    pub initialized: bool,
    /// Secrets can't be read until unlocked (or the keychain returns).
    pub locked: bool,
    pub keychain_available: bool,
    pub keychain_problem: Option<String>,
    /// A passphrase vault is unlocked for terminals (kernel keyring).
    pub unlock_cached: bool,
}

/// Where to open the vault from: its environment plus the in-app key of an
/// unlocked passphrase vault. Cheap to clone; every call opens the file
/// again (other processes write it too).
#[derive(Clone)]
pub struct Store {
    pub env: VaultEnv,
    pub session: Option<MasterKey>,
}

impl Store {
    pub fn new(env: VaultEnv, session: Option<MasterKey>) -> Store {
        Store { env, session }
    }

    /// The system vault without an in-app key.
    pub fn system() -> Store {
        Store::new(VaultEnv::system(), None)
    }

    pub fn open(&self) -> Result<Vault, VaultError> {
        Vault::open_with(&self.env, self.session.as_ref())
    }

    /// One secret, if stored.
    pub fn get(&self, id: &str) -> Result<Option<serde_json::Value>, VaultError> {
        Ok(self.open()?.get(id))
    }

    /// Stores and removes entries with one write.
    pub fn put_and_remove(
        &self,
        items: Vec<(String, serde_json::Value)>,
        remove: &[String],
    ) -> Result<(), VaultError> {
        if items.is_empty() && remove.is_empty() {
            return Ok(());
        }
        let mut vault = self.open()?;
        if items.is_empty() && !vault.is_initialized() {
            return Ok(());
        }
        vault.put_and_remove(items, remove)
    }

    /// The ids of stored entries starting with `prefix`.
    pub fn ids_with_prefix(&self, prefix: &str) -> Result<Vec<String>, VaultError> {
        Ok(self
            .open()?
            .ids()
            .into_iter()
            .filter(|id| id.starts_with(prefix))
            .collect())
    }
}

/// An opened vault: the decrypted entries plus the key to write them back.
pub struct Vault {
    env: VaultEnv,
    state: Option<OpenState>,
}

#[derive(Clone)]
struct OpenState {
    spec: KeySpec,
    key: MasterKey,
    contents: Contents,
}

fn read_sealed(env: &VaultEnv) -> Result<Option<format::Sealed>, VaultError> {
    match std::fs::read_to_string(env.file()) {
        Ok(text) => format::parse(&text).map(Some).map_err(format_error),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.into()),
    }
}

/// The header's key spec, without decrypting anything.
pub fn peek(env: &VaultEnv) -> Result<Option<KeySpec>, VaultError> {
    Ok(read_sealed(env)?.map(|sealed| sealed.header.key))
}

/// The key for `spec` from the keychain, the in-app `session` key or the
/// unlock cache.
fn resolve_key(
    env: &VaultEnv,
    spec: &KeySpec,
    session: Option<&MasterKey>,
) -> Result<MasterKey, VaultError> {
    match spec {
        KeySpec::Keychain { account } => match env.keychain.get(account) {
            Ok(Some(secret)) => MasterKey::from_base64(&secret).ok_or_else(|| {
                VaultError::Corrupt("the key in the system keychain is not valid".into())
            }),
            Ok(None) => Err(VaultError::Corrupt(
                "its key is missing from the system keychain; reset the vault".into(),
            )),
            Err(reason) => Err(VaultError::KeychainUnavailable(reason)),
        },
        KeySpec::Passphrase { .. } => {
            if let Some(key) = session.filter(|key| key.matches(spec)) {
                return Ok(key.clone());
            }
            if let Some(bytes) = env.unlock_cache.get(&env.cache_id()) {
                match MasterKey::from_bytes(&bytes) {
                    Some(key) if key.matches(spec) => return Ok(key),
                    // A key of an older (reset or re-keyed) vault.
                    _ => env.unlock_cache.clear(&env.cache_id()),
                }
            }
            Err(VaultError::Locked)
        }
    }
}

fn open_sealed(sealed: &format::Sealed, key: MasterKey) -> Result<OpenState, VaultError> {
    let contents = format::open(sealed, &key).map_err(format_error)?;
    Ok(OpenState {
        spec: sealed.header.key.clone(),
        key,
        contents,
    })
}

fn write_state(env: &VaultEnv, state: &OpenState) -> Result<(), VaultError> {
    let text = format::seal(&state.key, &state.spec, &state.contents);
    fsutil::write_atomic(&env.file(), text.as_bytes(), 0o600)?;
    Ok(())
}

fn take_lock(env: &VaultEnv) -> Result<fsutil::FileLock, VaultError> {
    crate::paths::ensure_private_dir(&env.dir)?;
    Ok(fsutil::lock_file(&env.lock_path(), LOCK_TIMEOUT)?)
}

impl Vault {
    /// The system vault (see [`VaultEnv::system`]), without an in-app key.
    pub fn open() -> Result<Vault, VaultError> {
        Vault::open_with(&VaultEnv::system(), None)
    }

    /// Opens the vault of `env`. A vault that doesn't exist yet opens empty;
    /// `session` is the key of an unlocked passphrase vault.
    pub fn open_with(env: &VaultEnv, session: Option<&MasterKey>) -> Result<Vault, VaultError> {
        let state = match read_sealed(env)? {
            None => None,
            Some(sealed) => {
                let key = resolve_key(env, &sealed.header.key, session)?;
                Some(open_sealed(&sealed, key)?)
            }
        };
        Ok(Vault {
            env: env.clone(),
            state,
        })
    }

    pub fn is_initialized(&self) -> bool {
        self.state.is_some()
    }

    pub fn get(&self, id: &str) -> Option<serde_json::Value> {
        self.state
            .as_ref()?
            .contents
            .entries
            .get(id)
            .map(|entry| entry.value.clone())
    }

    pub fn contains(&self, id: &str) -> bool {
        self.state
            .as_ref()
            .is_some_and(|s| s.contents.entries.contains_key(id))
    }

    pub fn ids(&self) -> Vec<String> {
        self.state
            .as_ref()
            .map(|s| s.contents.entries.keys().cloned().collect())
            .unwrap_or_default()
    }

    pub fn put(&mut self, id: &str, value: serde_json::Value) -> Result<(), VaultError> {
        self.put_many(vec![(id.to_string(), value)])
    }

    /// Stores several entries with one write. A vault that isn't set up yet
    /// is created with a new key in the OS keychain (`KeychainUnavailable`
    /// when there is none: set up a passphrase first).
    pub fn put_many(&mut self, items: Vec<(String, serde_json::Value)>) -> Result<(), VaultError> {
        let now = crate::now_secs();
        self.update(true, move |entries| {
            for (id, value) in items {
                entries.insert(
                    id,
                    StoredEntry {
                        value,
                        updated_at: now,
                    },
                );
            }
            true
        })
    }

    pub fn remove(&mut self, id: &str) -> Result<bool, VaultError> {
        Ok(self.remove_many(&[id.to_string()])? == 1)
    }

    /// Removes entries; returns how many existed. Never creates a vault.
    pub fn remove_many(&mut self, ids: &[String]) -> Result<usize, VaultError> {
        let mut removed = 0;
        self.update(false, |entries| {
            for id in ids {
                removed += usize::from(entries.remove(id).is_some());
            }
            removed > 0
        })?;
        Ok(removed)
    }

    /// Stores `items` and removes `remove` with one write (initializing a
    /// keychain vault when there is something to store).
    pub fn put_and_remove(
        &mut self,
        items: Vec<(String, serde_json::Value)>,
        remove: &[String],
    ) -> Result<(), VaultError> {
        let now = crate::now_secs();
        let create = !items.is_empty();
        self.update(create, move |entries| {
            let mut changed = false;
            for id in remove {
                changed |= entries.remove(id).is_some();
            }
            for (id, value) in items {
                entries.insert(
                    id,
                    StoredEntry {
                        value,
                        updated_at: now,
                    },
                );
                changed = true;
            }
            changed
        })
    }

    /// Lock, re-read, apply `change` (returns whether anything changed),
    /// write. `create` initializes a missing vault (keychain backend).
    fn update(
        &mut self,
        create: bool,
        change: impl FnOnce(&mut BTreeMap<String, StoredEntry>) -> bool,
    ) -> Result<(), VaultError> {
        let env = self.env.clone();
        let _lock = take_lock(&env)?;
        let mut state = match read_sealed(&env)? {
            Some(sealed) => {
                let known = self
                    .state
                    .as_ref()
                    .filter(|s| s.spec == sealed.header.key)
                    .map(|s| s.key.clone());
                let key = match known {
                    Some(key) => key,
                    None => resolve_key(&env, &sealed.header.key, None)?,
                };
                open_sealed(&sealed, key)?
            }
            None if create => new_keychain_state(&env)?,
            None => {
                self.state = None;
                return Ok(());
            }
        };
        if change(&mut state.contents.entries) || self.state.is_none() {
            write_state(&env, &state)?;
        }
        self.state = Some(state);
        Ok(())
    }

    /// Status of the vault of `env` (`session`: the in-app key, if any).
    /// Never prompts and never decrypts.
    pub fn status(env: &VaultEnv, session: Option<&MasterKey>) -> VaultStatus {
        let probe = env.keychain.probe();
        let keychain_available = probe.is_ok();
        let keychain_problem = probe.err();
        let cached_key = || {
            env.unlock_cache
                .get(&env.cache_id())
                .and_then(|bytes| MasterKey::from_bytes(&bytes))
        };
        let (backend, initialized, locked, unlock_cached) = match peek(env) {
            Ok(None) => (
                if keychain_available {
                    Backend::Keychain
                } else {
                    Backend::None
                },
                false,
                false,
                false,
            ),
            Ok(Some(KeySpec::Keychain { .. })) => {
                (Backend::Keychain, true, !keychain_available, false)
            }
            Ok(Some(spec @ KeySpec::Passphrase { .. })) => {
                let cached = cached_key().is_some_and(|key| key.matches(&spec));
                let session = session.is_some_and(|key| key.matches(&spec));
                (Backend::Passphrase, true, !(session || cached), cached)
            }
            // Unreadable: report it as set up and locked; opening it gives
            // the actual error.
            Err(_) => (Backend::None, true, true, false),
        };
        VaultStatus {
            backend,
            initialized,
            locked,
            keychain_available,
            keychain_problem,
            unlock_cached,
        }
    }

    /// Sets up a passphrase vault (none may exist yet). Returns its key.
    pub fn init_passphrase(env: &VaultEnv, passphrase: &str) -> Result<MasterKey, VaultError> {
        check_passphrase(passphrase)?;
        let _lock = take_lock(env)?;
        if env.file().exists() {
            return Err(VaultError::AlreadyInitialized);
        }
        let (spec, key) = format::new_passphrase_key(passphrase, env.kdf).map_err(format_error)?;
        write_state(
            env,
            &OpenState {
                spec,
                key: key.clone(),
                contents: Contents::default(),
            },
        )?;
        Ok(key)
    }

    /// The key of a passphrase vault (verified to open it).
    pub fn key_from_passphrase(env: &VaultEnv, passphrase: &str) -> Result<MasterKey, VaultError> {
        let sealed = read_sealed(env)?.ok_or(VaultError::NotInitialized)?;
        if !matches!(sealed.header.key, KeySpec::Passphrase { .. }) {
            return Err(VaultError::NotPassphraseProtected);
        }
        let key = match format::key_for_passphrase(&sealed.header.key, passphrase) {
            Ok(key) => key,
            Err(format::FormatError::Decrypt) => return Err(VaultError::WrongPassphrase),
            Err(e) => return Err(format_error(e)),
        };
        format::open(&sealed, &key).map_err(format_error)?;
        Ok(key)
    }

    /// Keeps `key` in the unlock cache for terminals ([`UNLOCK_TTL`]).
    pub fn cache_unlock(env: &VaultEnv, key: &MasterKey) -> Result<(), String> {
        env.unlock_cache
            .put(&env.cache_id(), key.as_bytes(), UNLOCK_TTL)
    }

    /// Forgets the terminal unlock.
    pub fn lock_terminals(env: &VaultEnv) {
        env.unlock_cache.clear(&env.cache_id());
    }

    /// Re-encrypts a passphrase vault under a new passphrase (new salt).
    /// Returns the new key; the terminal unlock is forgotten.
    pub fn change_passphrase(
        env: &VaultEnv,
        old: &str,
        new: &str,
    ) -> Result<MasterKey, VaultError> {
        check_passphrase(new)?;
        let _lock = take_lock(env)?;
        let old_key = Vault::key_from_passphrase(env, old)?;
        let sealed = read_sealed(env)?.ok_or(VaultError::NotInitialized)?;
        let contents = format::open(&sealed, &old_key).map_err(format_error)?;
        let (spec, key) = format::new_passphrase_key(new, env.kdf).map_err(format_error)?;
        write_state(
            env,
            &OpenState {
                spec,
                key: key.clone(),
                contents,
            },
        )?;
        Vault::lock_terminals(env);
        Ok(key)
    }

    /// Deletes the vault, its keychain item and the terminal unlock. Every
    /// stored secret is lost.
    pub fn reset(env: &VaultEnv) -> Result<(), VaultError> {
        let _lock = take_lock(env)?;
        if let Ok(Some(KeySpec::Keychain { account })) = peek(env) {
            let _ = env.keychain.delete(&account);
        }
        match std::fs::remove_file(env.file()) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e.into()),
        }
        Vault::lock_terminals(env);
        Ok(())
    }
}

fn check_passphrase(passphrase: &str) -> Result<(), VaultError> {
    if passphrase.chars().count() < MIN_PASSPHRASE_CHARS {
        Err(VaultError::WeakPassphrase)
    } else {
        Ok(())
    }
}

fn new_keychain_state(env: &VaultEnv) -> Result<OpenState, VaultError> {
    env.keychain
        .probe()
        .map_err(VaultError::KeychainUnavailable)?;
    let key = MasterKey::generate();
    let account = format!("vault-{}", fsutil::random_id());
    env.keychain
        .set(&account, &key.to_base64())
        .map_err(VaultError::KeychainUnavailable)?;
    Ok(OpenState {
        spec: KeySpec::Keychain { account },
        key,
        contents: Contents::default(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    struct Fixture {
        _dir: tempfile::TempDir,
        env: VaultEnv,
        keychain: Arc<MemoryKeychain>,
    }

    fn fixture() -> Fixture {
        let dir = tempfile::tempdir().unwrap();
        let keychain = Arc::new(MemoryKeychain::new());
        let env = VaultEnv {
            dir: dir.path().join("vault"),
            keychain: keychain.clone(),
            unlock_cache: Arc::new(MemoryUnlockCache::default()),
            kdf: KdfParams::INSECURE_FOR_TESTS,
        };
        Fixture {
            _dir: dir,
            env,
            keychain,
        }
    }

    #[test]
    fn keychain_vault_initializes_on_first_write() {
        let f = fixture();
        let status = Vault::status(&f.env, None);
        assert_eq!(status.backend, Backend::Keychain);
        assert!(!status.initialized && !status.locked);

        let mut vault = Vault::open_with(&f.env, None).unwrap();
        assert!(!vault.is_initialized());
        vault
            .put("cluster:a:static", json!({"token": "s3cr3t"}))
            .unwrap();
        assert_eq!(f.keychain.len(), 1);

        let text = std::fs::read_to_string(f.env.file()).unwrap();
        assert!(!text.contains("s3cr3t"));
        assert!(text
            .lines()
            .next()
            .unwrap()
            .contains(r#""type":"keychain""#));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(f.env.file())
                .unwrap()
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o600);
            let mode = std::fs::metadata(&f.env.dir).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o700);
        }

        let reopened = Vault::open_with(&f.env, None).unwrap();
        assert_eq!(
            reopened.get("cluster:a:static"),
            Some(json!({"token": "s3cr3t"}))
        );
        assert_eq!(reopened.get("missing"), None);
        let status = Vault::status(&f.env, None);
        assert!(status.initialized && !status.locked);

        // Concurrent handles see each other's writes (re-read under lock).
        let mut a = Vault::open_with(&f.env, None).unwrap();
        let mut b = Vault::open_with(&f.env, None).unwrap();
        a.put("x", json!(1)).unwrap();
        b.put("y", json!(2)).unwrap();
        let both = Vault::open_with(&f.env, None).unwrap();
        assert_eq!(both.ids(), vec!["cluster:a:static", "x", "y"]);

        assert!(b.remove("x").unwrap());
        assert!(!b.remove("x").unwrap());
        assert!(!Vault::open_with(&f.env, None).unwrap().contains("x"));

        // The keychain going away locks it.
        f.keychain.set_available(false);
        assert!(matches!(
            Vault::open_with(&f.env, None),
            Err(VaultError::KeychainUnavailable(_))
        ));
        let status = Vault::status(&f.env, None);
        assert!(status.locked && !status.keychain_available);
        assert!(status.keychain_problem.is_some());
    }

    #[test]
    fn without_keychain_a_passphrase_is_needed() {
        let f = fixture();
        f.keychain.set_available(false);
        assert_eq!(Vault::status(&f.env, None).backend, Backend::None);
        let mut vault = Vault::open_with(&f.env, None).unwrap();
        assert!(matches!(
            vault.put("a", json!(1)),
            Err(VaultError::KeychainUnavailable(_))
        ));
        assert!(!f.env.file().exists());
        // Removing from a vault that doesn't exist is a no-op.
        assert_eq!(vault.remove_many(&["a".into()]).unwrap(), 0);

        assert_eq!(
            Vault::init_passphrase(&f.env, "short").unwrap_err(),
            VaultError::WeakPassphrase
        );
        let key = Vault::init_passphrase(&f.env, "correct horse battery").unwrap();
        assert_eq!(
            Vault::init_passphrase(&f.env, "correct horse battery").unwrap_err(),
            VaultError::AlreadyInitialized
        );

        // Locked without the key.
        assert!(matches!(
            Vault::open_with(&f.env, None),
            Err(VaultError::Locked)
        ));
        let status = Vault::status(&f.env, None);
        assert_eq!(status.backend, Backend::Passphrase);
        assert!(status.initialized && status.locked && !status.unlock_cached);
        assert!(!Vault::status(&f.env, Some(&key)).locked);

        let mut vault = Vault::open_with(&f.env, Some(&key)).unwrap();
        vault
            .put("cluster:b:env", json!({"AWS_SECRET_ACCESS_KEY": "k"}))
            .unwrap();

        // Wrong passphrase vs right one.
        assert_eq!(
            Vault::key_from_passphrase(&f.env, "wrong passphrase").unwrap_err(),
            VaultError::WrongPassphrase
        );
        let again = Vault::key_from_passphrase(&f.env, "correct horse battery").unwrap();
        let vault = Vault::open_with(&f.env, Some(&again)).unwrap();
        assert_eq!(
            vault.get("cluster:b:env"),
            Some(json!({"AWS_SECRET_ACCESS_KEY": "k"}))
        );
        // A random key doesn't open it.
        assert!(matches!(
            Vault::open_with(&f.env, Some(&MasterKey::generate())),
            Err(VaultError::Locked)
        ));
    }

    #[test]
    fn terminal_unlock_cache() {
        let f = fixture();
        f.keychain.set_available(false);
        let key = Vault::init_passphrase(&f.env, "correct horse battery").unwrap();
        Vault::cache_unlock(&f.env, &key).unwrap();
        assert!(Vault::status(&f.env, None).unlock_cached);
        // Opens without an in-app key.
        Vault::open_with(&f.env, None).unwrap();
        Vault::lock_terminals(&f.env);
        assert!(matches!(
            Vault::open_with(&f.env, None),
            Err(VaultError::Locked)
        ));

        // A stale cached key (vault re-keyed) is dropped.
        f.env
            .unlock_cache
            .put(
                &f.env.cache_id(),
                MasterKey::generate().as_bytes(),
                UNLOCK_TTL,
            )
            .unwrap();
        assert!(matches!(
            Vault::open_with(&f.env, None),
            Err(VaultError::Locked)
        ));
        assert!(f.env.unlock_cache.get(&f.env.cache_id()).is_none());
    }

    #[test]
    fn change_passphrase_and_reset() {
        let f = fixture();
        f.keychain.set_available(false);
        let key = Vault::init_passphrase(&f.env, "first passphrase").unwrap();
        Vault::open_with(&f.env, Some(&key))
            .unwrap()
            .put("a", json!("v"))
            .unwrap();
        Vault::cache_unlock(&f.env, &key).unwrap();

        assert_eq!(
            Vault::change_passphrase(&f.env, "not it at all", "second passphrase").unwrap_err(),
            VaultError::WrongPassphrase
        );
        let new_key =
            Vault::change_passphrase(&f.env, "first passphrase", "second passphrase").unwrap();
        assert!(!Vault::status(&f.env, None).unlock_cached);
        assert!(matches!(
            Vault::open_with(&f.env, Some(&key)),
            Err(VaultError::Locked)
        ));
        assert_eq!(
            Vault::open_with(&f.env, Some(&new_key)).unwrap().get("a"),
            Some(json!("v"))
        );
        assert_eq!(
            Vault::key_from_passphrase(&f.env, "first passphrase").unwrap_err(),
            VaultError::WrongPassphrase
        );

        Vault::reset(&f.env).unwrap();
        assert!(!f.env.file().exists());
        assert!(!Vault::status(&f.env, None).initialized);
        Vault::reset(&f.env).unwrap();
    }

    #[test]
    fn reset_removes_the_keychain_item_and_tampering_is_corrupt() {
        let f = fixture();
        Vault::open_with(&f.env, None)
            .unwrap()
            .put("a", json!(1))
            .unwrap();
        assert_eq!(f.keychain.len(), 1);

        let text = std::fs::read_to_string(f.env.file()).unwrap();
        let (header, body) = text.split_once('\n').unwrap();
        let mut bytes = body.trim().as_bytes().to_vec();
        bytes[5] = if bytes[5] == b'A' { b'B' } else { b'A' };
        std::fs::write(
            f.env.file(),
            format!("{header}\n{}\n", String::from_utf8(bytes).unwrap()),
        )
        .unwrap();
        assert!(matches!(
            Vault::open_with(&f.env, None),
            Err(VaultError::Corrupt(_))
        ));
        // Writing refuses too (never silently replaces a damaged vault).
        let mut vault = Vault {
            env: f.env.clone(),
            state: None,
        };
        assert!(matches!(
            vault.put("b", json!(2)),
            Err(VaultError::Corrupt(_))
        ));

        Vault::reset(&f.env).unwrap();
        assert!(f.keychain.is_empty());

        // A vault whose keychain item vanished.
        Vault::open_with(&f.env, None)
            .unwrap()
            .put("a", json!(1))
            .unwrap();
        let Ok(Some(KeySpec::Keychain { account })) = peek(&f.env) else {
            panic!("expected a keychain vault")
        };
        f.keychain.delete(&account).unwrap();
        assert!(matches!(
            Vault::open_with(&f.env, None),
            Err(VaultError::Corrupt(_))
        ));
    }
}

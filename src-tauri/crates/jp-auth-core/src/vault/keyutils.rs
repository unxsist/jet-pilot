//! The unlock cache of a passphrase vault: after unlocking (in the app with
//! "also unlock for terminals", or `jetpilot-auth unlock`) the derived master
//! key is kept in the Linux kernel's user keyring (`@u`) for 12 hours, so
//! the helper works in every terminal of the same user without asking again.
//!
//! The key is readable by processes of the same user only and expires in
//! the kernel. Other platforms have no cache (their vaults use the OS
//! keychain). `JET_PILOT_NO_KEYUTILS` disables the cache.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use zeroize::Zeroizing;

/// How long an unlock lasts for terminals.
pub const UNLOCK_TTL: Duration = Duration::from_secs(12 * 60 * 60);

pub trait UnlockCache: Send + Sync {
    /// Whether this cache can hold keys at all.
    fn available(&self) -> bool;
    fn get(&self, id: &str) -> Option<Zeroizing<Vec<u8>>>;
    fn put(&self, id: &str, secret: &[u8], ttl: Duration) -> Result<(), String>;
    fn clear(&self, id: &str);
}

/// No cache.
pub struct NoUnlockCache;

impl UnlockCache for NoUnlockCache {
    fn available(&self) -> bool {
        false
    }
    fn get(&self, _id: &str) -> Option<Zeroizing<Vec<u8>>> {
        None
    }
    fn put(&self, _id: &str, _secret: &[u8], _ttl: Duration) -> Result<(), String> {
        Err("There is no unlock cache on this system.".into())
    }
    fn clear(&self, _id: &str) {}
}

/// An in-memory cache for tests (ignores the TTL).
#[derive(Default)]
pub struct MemoryUnlockCache {
    items: Mutex<HashMap<String, Vec<u8>>>,
}

impl UnlockCache for MemoryUnlockCache {
    fn available(&self) -> bool {
        true
    }
    fn get(&self, id: &str) -> Option<Zeroizing<Vec<u8>>> {
        self.items
            .lock()
            .unwrap()
            .get(id)
            .cloned()
            .map(Zeroizing::new)
    }
    fn put(&self, id: &str, secret: &[u8], _ttl: Duration) -> Result<(), String> {
        self.items
            .lock()
            .unwrap()
            .insert(id.to_string(), secret.to_vec());
        Ok(())
    }
    fn clear(&self, id: &str) {
        self.items.lock().unwrap().remove(id);
    }
}

#[cfg(target_os = "linux")]
pub use linux::KernelKeyring;

#[cfg(target_os = "linux")]
mod linux {
    use std::time::Duration;

    use linux_keyutils::{KeyPermissionsBuilder, KeyRing, KeyRingIdentifier, Permission};
    use zeroize::Zeroizing;

    /// The kernel user keyring (`@u`).
    pub struct KernelKeyring;

    fn user_ring() -> Option<KeyRing> {
        KeyRing::from_special_id(KeyRingIdentifier::User, true).ok()
    }

    impl super::UnlockCache for KernelKeyring {
        fn available(&self) -> bool {
            user_ring().is_some()
        }

        fn get(&self, id: &str) -> Option<Zeroizing<Vec<u8>>> {
            let key = user_ring()?.search(id).ok()?;
            key.read_to_vec().ok().map(Zeroizing::new)
        }

        fn put(&self, id: &str, secret: &[u8], ttl: Duration) -> Result<(), String> {
            let ring = user_ring().ok_or("The kernel keyring is not available.")?;
            let key = ring
                .add_key(id, secret)
                .map_err(|e| format!("The kernel keyring refused the key: {e:?}"))?;
            // Readable by this user's processes whether or not they
            // "possess" the user keyring (terminals in other sessions).
            let perms = KeyPermissionsBuilder::builder()
                .posessor(Permission::ALL)
                .user(Permission::ALL)
                .build();
            let configured = key
                .set_perms(perms)
                .and_then(|_| key.set_timeout(ttl.as_secs() as usize));
            if let Err(e) = configured {
                let _ = key.invalidate();
                return Err(format!(
                    "The kernel keyring refused the key settings: {e:?}"
                ));
            }
            Ok(())
        }

        fn clear(&self, id: &str) {
            if let Some(key) = user_ring().and_then(|ring| ring.search(id).ok()) {
                let _ = key.invalidate();
            }
        }
    }
}

/// The unlock cache to use in this process: the kernel keyring on Linux
/// (unless `JET_PILOT_NO_KEYUTILS` is set), else none.
pub fn system_unlock_cache() -> Arc<dyn UnlockCache> {
    #[cfg(target_os = "linux")]
    if !crate::env_flag(crate::NO_KEYUTILS_ENV) {
        return Arc::new(KernelKeyring);
    }
    Arc::new(NoUnlockCache)
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;

    /// Exercises the real kernel keyring when the sandbox allows keyctl.
    #[test]
    fn kernel_keyring_round_trip_when_available() {
        let cache = KernelKeyring;
        if !cache.available() {
            return;
        }
        let id = format!("jet-pilot-test:{}", crate::fsutil::random_id());
        if cache
            .put(&id, b"0123456789abcdef", Duration::from_secs(60))
            .is_err()
        {
            return;
        }
        assert_eq!(
            cache.get(&id).as_deref().map(Vec::as_slice),
            Some(&b"0123456789abcdef"[..])
        );
        cache.clear(&id);
        assert!(cache.get(&id).is_none());
    }
}

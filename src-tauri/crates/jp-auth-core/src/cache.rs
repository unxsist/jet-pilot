//! Short-lived credentials (AWS role credentials, MFA sessions) cached in
//! the vault under `cache:` ids, so the app and every helper run share them
//! until shortly before they expire. Expired entries are pruned on writes.
//! A cache that can't be read or written is simply a miss.

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};

use crate::vault::{Store, VaultError};

pub const PREFIX: &str = "cache:";

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Entry {
    /// Unix seconds.
    expires_at: i64,
    value: serde_json::Value,
}

/// The cached value of `id` when it is still valid for `min_remaining`
/// seconds at `now`.
pub fn get<T: DeserializeOwned>(
    store: &Store,
    id: &str,
    now: i64,
    min_remaining: i64,
) -> Option<T> {
    let raw = store.get(id).ok()??;
    let entry: Entry = serde_json::from_value(raw).ok()?;
    if entry.expires_at - now < min_remaining {
        return None;
    }
    serde_json::from_value(entry.value).ok()
}

/// Caches `value` until `expires_at` (unix seconds) and drops expired
/// cache entries in the same write.
pub fn put<T: Serialize>(
    store: &Store,
    id: &str,
    value: &T,
    expires_at: i64,
    now: i64,
) -> Result<(), VaultError> {
    let value = serde_json::to_value(value).map_err(|e| VaultError::Io(e.to_string()))?;
    let entry = serde_json::to_value(Entry { expires_at, value })
        .map_err(|e| VaultError::Io(e.to_string()))?;
    let vault = store.open()?;
    let expired: Vec<String> = vault
        .ids()
        .into_iter()
        .filter(|other| other.starts_with(PREFIX) && other != id)
        .filter(|other| {
            vault
                .get(other)
                .and_then(|raw| serde_json::from_value::<Entry>(raw).ok())
                .is_none_or(|entry| entry.expires_at <= now)
        })
        .collect();
    drop(vault);
    store.put_and_remove(vec![(id.to_string(), entry)], &expired)
}

/// Forgets cached entries whose id starts with `prefix`.
pub fn remove_prefix(store: &Store, prefix: &str) -> Result<(), VaultError> {
    let ids = store.ids_with_prefix(prefix)?;
    store.put_and_remove(Vec::new(), &ids)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vault::{KdfParams, MemoryKeychain, MemoryUnlockCache, VaultEnv};
    use std::sync::Arc;

    #[test]
    fn caches_until_expiry_and_prunes() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::new(
            VaultEnv {
                dir: dir.path().join("vault"),
                keychain: Arc::new(MemoryKeychain::new()),
                unlock_cache: Arc::new(MemoryUnlockCache::default()),
                kdf: KdfParams::INSECURE_FOR_TESTS,
            },
            None,
        );
        assert_eq!(get::<String>(&store, "cache:a", 100, 0), None);
        put(&store, "cache:a", &"one".to_string(), 1_000, 100).unwrap();
        put(&store, "cache:b", &"two".to_string(), 200, 100).unwrap();
        assert_eq!(
            get::<String>(&store, "cache:a", 100, 300).as_deref(),
            Some("one")
        );
        // Not valid long enough.
        assert_eq!(get::<String>(&store, "cache:a", 800, 300), None);
        // Writing later prunes the expired entry.
        put(&store, "cache:c", &"three".to_string(), 2_000, 500).unwrap();
        let ids = store.ids_with_prefix(PREFIX).unwrap();
        assert_eq!(ids, vec!["cache:a".to_string(), "cache:c".to_string()]);
        remove_prefix(&store, "cache:a").unwrap();
        assert_eq!(
            store.ids_with_prefix(PREFIX).unwrap(),
            vec!["cache:c".to_string()]
        );
    }
}

//! The fake HTTP server ([`crate::fake`]) plus an AWS context pointing
//! every endpoint at it.

use std::sync::Arc;

pub use crate::fake::{FakeRequest, FakeResponse, FakeServer};

/// A context for tests: a vault with an in-memory keychain, `home` and
/// the JET Pilot files under `dir`, every endpoint at `base_url`, quick
/// retries.
pub fn test_context(dir: &std::path::Path, base_url: &str) -> super::AwsContext {
    use crate::vault::{KdfParams, MemoryKeychain, MemoryUnlockCache, Store, VaultEnv};
    let jp = dir.join("jet-pilot");
    super::AwsContext {
        store: Store::new(
            VaultEnv {
                dir: jp.join("vault"),
                keychain: Arc::new(MemoryKeychain::new()),
                unlock_cache: Arc::new(MemoryUnlockCache::default()),
                kdf: KdfParams::INSECURE_FOR_TESTS,
            },
            None,
        ),
        connections_file: jp.join(crate::connections::FILE_NAME),
        lock_dir: jp,
        home: Some(dir.join("home")),
        config_file: None,
        credentials_file: None,
        endpoints: super::Endpoints {
            oidc: Some(base_url.to_string()),
            portal: Some(base_url.to_string()),
            sts: Some(base_url.to_string()),
            eks: Some(base_url.to_string()),
            ec2: Some(base_url.to_string()),
        },
        timeout: std::time::Duration::from_secs(5),
        max_attempts: 3,
        initial_backoff: std::time::Duration::from_millis(1),
    }
}

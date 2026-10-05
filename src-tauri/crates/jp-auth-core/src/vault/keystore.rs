//! Where a keychain-backed vault keeps its master key: one generic password
//! item per vault (service [`SERVICE`], account from the vault header).
//!
//! - macOS: the login keychain. The item is created with the `security`
//!   CLI and `-A` (any application may read it), so the unsigned helper and
//!   app updates with a new code signature don't trigger keychain prompts.
//! - Windows: Credential Manager.
//! - Linux: the Secret Service (GNOME Keyring, KWallet, KeePassXC). Its
//!   availability is probed without prompting: a provider must own or be
//!   activatable as `org.freedesktop.secrets` on the session bus, answered
//!   within 3 s.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use zeroize::Zeroizing;

/// The keychain service name of vault keys.
pub const SERVICE: &str = "app.jet-pilot.vault";
/// Probing the keychain gives up after this long.
pub const PROBE_TIMEOUT: Duration = Duration::from_secs(3);

pub trait Keychain: Send + Sync {
    /// Whether the keychain can be used, without prompting the user.
    /// `Err` carries a one-line, user-facing reason.
    fn probe(&self) -> Result<(), String>;
    /// The secret of `account`; `Ok(None)` when there is no such item.
    fn get(&self, account: &str) -> Result<Option<Zeroizing<String>>, String>;
    /// Creates or replaces the secret of `account`.
    fn set(&self, account: &str, secret: &str) -> Result<(), String>;
    /// Removes `account` (no error when it doesn't exist).
    fn delete(&self, account: &str) -> Result<(), String>;
}

/* --------------------------------------------------------------- OS */

/// The platform keychain via the `keyring` crate.
pub struct OsKeychain {
    probe_cache: Mutex<Option<(Instant, Result<(), String>)>>,
}

impl OsKeychain {
    /// The process-wide instance (shares the probe cache).
    pub fn shared() -> Arc<OsKeychain> {
        static SHARED: OnceLock<Arc<OsKeychain>> = OnceLock::new();
        SHARED
            .get_or_init(|| {
                Arc::new(OsKeychain {
                    probe_cache: Mutex::new(None),
                })
            })
            .clone()
    }

    fn entry(account: &str) -> Result<keyring::Entry, String> {
        keyring::Entry::new(SERVICE, account).map_err(|e| keyring_message(&e))
    }
}

/// A short message for a keyring error (never contains the secret).
fn keyring_message(error: &keyring::Error) -> String {
    match error {
        keyring::Error::NoStorageAccess(_) => {
            "The system keychain could not be accessed.".to_string()
        }
        keyring::Error::PlatformFailure(e) => format!("The system keychain reported an error: {e}"),
        other => format!("The system keychain reported an error: {other}"),
    }
}

impl Keychain for OsKeychain {
    fn probe(&self) -> Result<(), String> {
        // Successes are remembered, failures re-checked after 30 s (a
        // keyring daemon may have been started meanwhile).
        let mut cache = self.probe_cache.lock().unwrap_or_else(|e| e.into_inner());
        if let Some((at, result)) = cache.as_ref() {
            if result.is_ok() || at.elapsed() < Duration::from_secs(30) {
                return result.clone();
            }
        }
        let result = probe_platform();
        *cache = Some((Instant::now(), result.clone()));
        result
    }

    fn get(&self, account: &str) -> Result<Option<Zeroizing<String>>, String> {
        match Self::entry(account)?.get_password() {
            Ok(secret) => Ok(Some(Zeroizing::new(secret))),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(keyring_message(&e)),
        }
    }

    fn set(&self, account: &str, secret: &str) -> Result<(), String> {
        #[cfg(target_os = "macos")]
        {
            let _ = self.delete(account);
            if macos::add_any_app(account, secret).is_ok()
                && self
                    .get(account)
                    .ok()
                    .flatten()
                    .as_deref()
                    .map(String::as_str)
                    == Some(secret)
            {
                return Ok(());
            }
            // Fall back to a regular item (the app itself can still read it).
        }
        Self::entry(account)?
            .set_password(secret)
            .map_err(|e| keyring_message(&e))
    }

    fn delete(&self, account: &str) -> Result<(), String> {
        match Self::entry(account)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(keyring_message(&e)),
        }
    }
}

#[cfg(target_os = "linux")]
fn probe_platform() -> Result<(), String> {
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(linux::probe_secret_service());
    });
    match rx.recv_timeout(PROBE_TIMEOUT) {
        Ok(result) => result,
        Err(_) => Err("The Secret Service did not answer within 3 seconds.".to_string()),
    }
}

#[cfg(not(target_os = "linux"))]
fn probe_platform() -> Result<(), String> {
    Ok(())
}

#[cfg(target_os = "linux")]
mod linux {
    use dbus::blocking::Connection;

    const SECRETS: &str = "org.freedesktop.secrets";

    /// A provider owns `org.freedesktop.secrets` or D-Bus can start one.
    pub fn probe_secret_service() -> Result<(), String> {
        let conn = Connection::new_session()
            .map_err(|_| "No D-Bus session bus, so no Secret Service is available.".to_string())?;
        let proxy = conn.with_proxy(
            "org.freedesktop.DBus",
            "/org/freedesktop/DBus",
            super::PROBE_TIMEOUT,
        );
        let (owned,): (bool,) = proxy
            .method_call("org.freedesktop.DBus", "NameHasOwner", (SECRETS,))
            .map_err(|e| {
                format!(
                    "The session bus did not answer: {}",
                    e.message().unwrap_or("unknown error")
                )
            })?;
        if owned {
            return Ok(());
        }
        let (names,): (Vec<String>,) = proxy
            .method_call("org.freedesktop.DBus", "ListActivatableNames", ())
            .map_err(|e| {
                format!(
                    "The session bus did not answer: {}",
                    e.message().unwrap_or("unknown error")
                )
            })?;
        if names.iter().any(|n| n == SECRETS) {
            Ok(())
        } else {
            Err(
                "No Secret Service provider (GNOME Keyring, KWallet or KeePassXC) is running."
                    .to_string(),
            )
        }
    }
}

#[cfg(target_os = "macos")]
mod macos {
    use std::io::Write;
    use std::process::{Command, Stdio};

    use zeroize::Zeroizing;

    /// `security add-generic-password -A` through `security -i` on stdin, so
    /// the secret never appears in a process listing. Service, account and
    /// secret (base64) contain no spaces or quotes.
    pub fn add_any_app(account: &str, secret: &str) -> Result<(), String> {
        let safe = |s: &str| {
            !s.is_empty()
                && !s
                    .chars()
                    .any(|c| c.is_whitespace() || c == '"' || c == '\'' || c == '\\')
        };
        if !safe(super::SERVICE) || !safe(account) || !safe(secret) {
            return Err("unsupported characters".into());
        }
        let mut child = Command::new("/usr/bin/security")
            .arg("-i")
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| e.to_string())?;
        {
            let mut stdin = child.stdin.take().ok_or("no stdin")?;
            let line = Zeroizing::new(format!(
                "add-generic-password -U -A -s {} -a {} -w {}\n",
                super::SERVICE,
                account,
                secret
            ));
            stdin
                .write_all(line.as_bytes())
                .map_err(|e| e.to_string())?;
        }
        let status = child.wait().map_err(|e| e.to_string())?;
        if status.success() {
            Ok(())
        } else {
            Err(format!("security exited with {status}"))
        }
    }
}

/* ------------------------------------------------------------ others */

/// No keychain (disabled, or unsupported platform).
pub struct NoKeychain {
    pub reason: String,
}

impl Keychain for NoKeychain {
    fn probe(&self) -> Result<(), String> {
        Err(self.reason.clone())
    }
    fn get(&self, _account: &str) -> Result<Option<Zeroizing<String>>, String> {
        Err(self.reason.clone())
    }
    fn set(&self, _account: &str, _secret: &str) -> Result<(), String> {
        Err(self.reason.clone())
    }
    fn delete(&self, _account: &str) -> Result<(), String> {
        Err(self.reason.clone())
    }
}

/// An in-memory keychain for tests.
#[derive(Default)]
pub struct MemoryKeychain {
    items: Mutex<HashMap<String, String>>,
    unavailable: AtomicBool,
}

impl MemoryKeychain {
    pub fn new() -> MemoryKeychain {
        MemoryKeychain::default()
    }

    pub fn set_available(&self, available: bool) {
        self.unavailable.store(!available, Ordering::SeqCst);
    }

    pub fn len(&self) -> usize {
        self.items.lock().unwrap().len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    fn check(&self) -> Result<(), String> {
        if self.unavailable.load(Ordering::SeqCst) {
            Err("The test keychain is unavailable.".into())
        } else {
            Ok(())
        }
    }
}

impl Keychain for MemoryKeychain {
    fn probe(&self) -> Result<(), String> {
        self.check()
    }
    fn get(&self, account: &str) -> Result<Option<Zeroizing<String>>, String> {
        self.check()?;
        Ok(self
            .items
            .lock()
            .unwrap()
            .get(account)
            .cloned()
            .map(Zeroizing::new))
    }
    fn set(&self, account: &str, secret: &str) -> Result<(), String> {
        self.check()?;
        self.items
            .lock()
            .unwrap()
            .insert(account.to_string(), secret.to_string());
        Ok(())
    }
    fn delete(&self, account: &str) -> Result<(), String> {
        self.check()?;
        self.items.lock().unwrap().remove(account);
        Ok(())
    }
}

/// The keychain to use in this process: none when `JET_PILOT_NO_KEYCHAIN`
/// is set, else the OS keychain.
pub fn system_keychain() -> Arc<dyn Keychain> {
    if crate::env_flag(crate::NO_KEYCHAIN_ENV) {
        Arc::new(NoKeychain {
            reason: format!(
                "The system keychain is disabled ({} is set).",
                crate::NO_KEYCHAIN_ENV
            ),
        })
    } else {
        OsKeychain::shared()
    }
}

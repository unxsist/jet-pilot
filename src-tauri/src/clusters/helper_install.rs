//! Installing the `jetpilot-auth` helper that ships next to the app binary
//! into `~/.kube/jet-pilot/bin/`, the stable path managed kubeconfig
//! entries reference (the app itself may live in a read-only, translocated
//! or temporary AppImage mount).
//!
//! At startup (in the background) the bundled helper's SHA-256 is compared
//! with the installed one; when they differ the bytes are written to a new
//! file (`jetpilot-auth.tmp-<random>`, 0755, fsynced) and renamed over the
//! old one, so the new binary is a new inode (macOS caches code signatures
//! per inode) without copied extended attributes (`fs::copy` would carry a
//! quarantine flag). Windows can't replace a running executable: it is
//! renamed to `jetpilot-auth.old-<timestamp>.exe` first and cleaned up on a
//! later start. A newer installed helper (from a newer app that was run
//! before) is never replaced by an older one. `.jetpilot-auth.json` records
//! the installed version and hash.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tracing::{info, warn};

use super::error::AppError;
use jp_auth_core::fsutil;

const MANIFEST: &str = ".jetpilot-auth.json";

/// The app (and so the bundled helper's) version.
pub const APP_VERSION: &str = env!("JET_PILOT_VERSION");

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Manifest {
    version: String,
    sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HelperStatus {
    pub installed: bool,
    pub path: String,
    /// The installed helper's version.
    pub version: Option<String>,
    /// The version shipped with this app, when it ships one.
    pub bundled_version: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum InstallOutcome {
    Installed,
    UpToDate,
    /// A newer helper is installed (version); left alone.
    KeptNewer(String),
    /// This build has no helper next to the app binary (dev builds that
    /// didn't build the `jetpilot-auth` target).
    NotBundled,
}

/// The helper next to the running executable, if present.
pub fn bundled_helper() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let candidate = exe.parent()?.join(jp_auth_core::paths::helper_file_name());
    candidate.is_file().then_some(candidate)
}

fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// `(major, minor, patch, is_release)`: a pre-release sorts before its
/// release. Unparseable versions are `None`.
fn version_key(version: &str) -> Option<(u64, u64, u64, bool)> {
    let version = version.trim().trim_start_matches('v');
    let (core, pre) = match version.split_once('-') {
        Some((core, pre)) => (core, Some(pre)),
        None => (version.split('+').next().unwrap_or(version), None),
    };
    let mut parts = core.split('.').map(|p| p.parse::<u64>().ok());
    Some((
        parts.next()??,
        parts.next()??,
        parts.next()??,
        pre.is_none(),
    ))
}

fn is_newer(installed: &str, bundled: &str) -> bool {
    matches!((version_key(installed), version_key(bundled)), (Some(a), Some(b)) if a > b)
}

fn read_manifest(bin_dir: &Path) -> Option<Manifest> {
    let text = std::fs::read_to_string(bin_dir.join(MANIFEST)).ok()?;
    serde_json::from_str(&text).ok()
}

fn write_manifest(bin_dir: &Path, manifest: &Manifest) -> std::io::Result<()> {
    let text = serde_json::to_string_pretty(manifest).expect("manifest serializes");
    fsutil::write_atomic(&bin_dir.join(MANIFEST), text.as_bytes(), 0o644)
}

/// Removes temp files of interrupted installs and (Windows) replaced
/// executables that are no longer running.
fn clean_leftovers(bin_dir: &Path) {
    let Ok(entries) = std::fs::read_dir(bin_dir) else {
        return;
    };
    let tmp_prefix = format!("{}.tmp-", jp_auth_core::paths::helper_file_name());
    let old_prefix = format!("{}.old-", jp_auth_core::HELPER_NAME);
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with(&tmp_prefix) || name.starts_with(&old_prefix) {
            // Fails while an old helper is still running (Windows): next time.
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

fn write_helper(bin_dir: &Path, target: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    jp_auth_core::paths::ensure_private_dir(bin_dir)?;
    let tmp = fsutil::temp_sibling(target);
    let result = (|| {
        let mut file = fsutil::create_new(&tmp, 0o755)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        #[cfg(windows)]
        if target.exists() {
            // A running .exe can be renamed but not overwritten.
            let old = bin_dir.join(format!(
                "{}.old-{}.exe",
                jp_auth_core::HELPER_NAME,
                jp_auth_core::now_secs()
            ));
            std::fs::rename(target, old)?;
        }
        fsutil::rename_replacing(&tmp, target)?;
        fsutil::sync_parent(target);
        Ok(())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    result
}

/// Installs `bundled` (version `bundled_version`) into `bin_dir` if needed.
pub fn install(
    bundled: Option<&Path>,
    bundled_version: &str,
    bin_dir: &Path,
) -> std::io::Result<InstallOutcome> {
    clean_leftovers(bin_dir);
    let Some(bundled) = bundled else {
        return Ok(InstallOutcome::NotBundled);
    };
    let bytes = std::fs::read(bundled)?;
    let sha = sha256_hex(&bytes);
    let target = bin_dir.join(jp_auth_core::paths::helper_file_name());
    let installed_sha = std::fs::read(&target).ok().map(|b| sha256_hex(&b));
    let manifest = read_manifest(bin_dir);

    if installed_sha.as_deref() == Some(sha.as_str()) {
        let current = Manifest {
            version: bundled_version.to_string(),
            sha256: sha,
        };
        // Keep a newer version label if the same bytes were installed by it.
        if manifest.as_ref().is_none_or(|m| m.sha256 != current.sha256) {
            write_manifest(bin_dir, &current)?;
        }
        return Ok(InstallOutcome::UpToDate);
    }
    if let (Some(manifest), Some(installed_sha)) = (&manifest, &installed_sha) {
        // Only trust the manifest when it describes the installed file.
        if &manifest.sha256 == installed_sha && is_newer(&manifest.version, bundled_version) {
            return Ok(InstallOutcome::KeptNewer(manifest.version.clone()));
        }
    }
    write_helper(bin_dir, &target, &bytes)?;
    write_manifest(
        bin_dir,
        &Manifest {
            version: bundled_version.to_string(),
            sha256: sha,
        },
    )?;
    Ok(InstallOutcome::Installed)
}

/// The installed and bundled helper.
pub fn status(bin_dir: &Path, bundled: Option<&Path>, bundled_version: &str) -> HelperStatus {
    let target = bin_dir.join(jp_auth_core::paths::helper_file_name());
    let installed = target.is_file();
    HelperStatus {
        installed,
        path: target.to_string_lossy().into_owned(),
        version: installed
            .then(|| read_manifest(bin_dir).map(|m| m.version))
            .flatten(),
        bundled_version: bundled.map(|_| bundled_version.to_string()),
    }
}

/// Installs the helper in the background (called from `setup`).
pub fn spawn_startup_install() {
    tauri::async_runtime::spawn_blocking(|| {
        let bin_dir = jp_auth_core::paths::bin_dir();
        match install(bundled_helper().as_deref(), APP_VERSION, &bin_dir) {
            Ok(InstallOutcome::Installed) => info!(
                "Installed the jetpilot-auth helper {} in {}",
                APP_VERSION,
                bin_dir.display()
            ),
            Ok(InstallOutcome::UpToDate) => {}
            Ok(InstallOutcome::KeptNewer(version)) => {
                info!(
                    "Kept the newer jetpilot-auth helper {} (this app ships {})",
                    version, APP_VERSION
                )
            }
            Ok(InstallOutcome::NotBundled) => {
                warn!("This build has no jetpilot-auth helper next to the app")
            }
            Err(e) => warn!("Could not install the jetpilot-auth helper: {}", e),
        }
    });
}

#[tauri::command]
pub async fn helper_status() -> Result<HelperStatus, AppError> {
    super::blocking(|| {
        Ok(status(
            &jp_auth_core::paths::bin_dir(),
            bundled_helper().as_deref(),
            APP_VERSION,
        ))
    })
    .await
}

/// Installs the bundled helper again (e.g. after it was deleted). A newer
/// installed helper is kept.
#[tauri::command]
pub async fn helper_reinstall() -> Result<HelperStatus, AppError> {
    super::blocking(|| {
        let bin_dir = jp_auth_core::paths::bin_dir();
        let bundled = bundled_helper();
        match install(bundled.as_deref(), APP_VERSION, &bin_dir) {
            Ok(InstallOutcome::NotBundled) => Err(AppError::not_found(
                "This build of JET Pilot doesn't include the jetpilot-auth helper.",
            )),
            Ok(_) => Ok(status(&bin_dir, bundled.as_deref(), APP_VERSION)),
            Err(e) => Err(AppError::io("The helper could not be installed", e)),
        }
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn versions_compare_like_semver() {
        assert!(is_newer("1.43.0", "1.42.9"));
        assert!(is_newer("1.42.0", "1.42.0-beta.1"));
        assert!(!is_newer("1.42.0", "1.42.0"));
        assert!(!is_newer("1.41.9", "1.42.0"));
        assert!(!is_newer("garbage", "1.0.0"));
        assert!(is_newer("v2.0.0", "1.99.99"));
    }

    #[test]
    fn installs_atomically_and_never_downgrades() {
        let dir = tempfile::tempdir().unwrap();
        let bundled = dir.path().join("bundled");
        let bin = dir.path().join("home").join("bin");
        std::fs::write(&bundled, b"helper v1").unwrap();
        let target = bin.join(jp_auth_core::paths::helper_file_name());

        assert_eq!(
            install(None, "1.0.0", &bin).unwrap(),
            InstallOutcome::NotBundled
        );
        assert_eq!(
            install(Some(&bundled), "1.0.0", &bin).unwrap(),
            InstallOutcome::Installed
        );
        assert_eq!(std::fs::read(&target).unwrap(), b"helper v1");
        assert_eq!(
            install(Some(&bundled), "1.0.0", &bin).unwrap(),
            InstallOutcome::UpToDate
        );
        let status1 = status(&bin, Some(&bundled), "1.0.0");
        assert!(status1.installed);
        assert_eq!(status1.version.as_deref(), Some("1.0.0"));
        assert_eq!(
            serde_json::to_value(&status1).unwrap()["bundledVersion"],
            "1.0.0"
        );

        #[cfg(unix)]
        let first_inode = {
            use std::os::unix::fs::{MetadataExt, PermissionsExt};
            let meta = std::fs::metadata(&target).unwrap();
            assert_eq!(meta.permissions().mode() & 0o777, 0o755);
            meta.ino()
        };

        // An update replaces the file with a new inode.
        std::fs::write(&bundled, b"helper v2").unwrap();
        assert_eq!(
            install(Some(&bundled), "1.1.0", &bin).unwrap(),
            InstallOutcome::Installed
        );
        assert_eq!(std::fs::read(&target).unwrap(), b"helper v2");
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            assert_ne!(std::fs::metadata(&target).unwrap().ino(), first_inode);
        }

        // An older app keeps the newer helper.
        std::fs::write(&bundled, b"helper v1").unwrap();
        assert_eq!(
            install(Some(&bundled), "1.0.0", &bin).unwrap(),
            InstallOutcome::KeptNewer("1.1.0".into())
        );
        assert_eq!(std::fs::read(&target).unwrap(), b"helper v2");

        // ...unless the installed file was tampered with / replaced.
        std::fs::write(&target, b"something else").unwrap();
        assert_eq!(
            install(Some(&bundled), "1.0.0", &bin).unwrap(),
            InstallOutcome::Installed
        );
        assert_eq!(std::fs::read(&target).unwrap(), b"helper v1");

        // Leftovers of interrupted installs are cleaned up; nothing else.
        let leftover = bin.join(format!(
            "{}.tmp-abc",
            jp_auth_core::paths::helper_file_name()
        ));
        std::fs::write(&leftover, b"partial").unwrap();
        install(Some(&bundled), "1.0.0", &bin).unwrap();
        assert!(!leftover.exists());
        let names: Vec<String> = std::fs::read_dir(&bin)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names.len(), 2, "{names:?}");

        let missing = status(&dir.path().join("nowhere"), None, "1.0.0");
        assert!(
            !missing.installed && missing.version.is_none() && missing.bundled_version.is_none()
        );
    }
}

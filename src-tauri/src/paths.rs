//! The JET Pilot home directory: `~/.kube/jet-pilot/` (Windows:
//! `%USERPROFILE%\.kube\jet-pilot\`), overridable with `JET_PILOT_HOME`.
//!
//! It lives next to the user's kubeconfig on purpose: the managed
//! kubeconfig (`config`), the vault (`vault/`) and the credential helper
//! (`bin/jetpilot-auth`) must be found by external terminals without the app
//! running. It also holds JET Pilot-managed tool downloads:
//! - `tools/<tool>/<version>/` the downloaded (verified) binaries;
//! - `bin/` the activated copies, appended to `PATH` at startup (after the
//!   user's own directories, so tools the user installed always win).
//!
//! Nothing is created at startup; directories are made (owner-only on unix)
//! when a tool is installed. Discovery's `~/.kube/*.yaml` glob is
//! non-recursive, so files in here are never picked up as kubeconfigs.

use std::path::PathBuf;

// The definitions live in jp-auth-core, shared with the jetpilot-auth helper.
pub use jp_auth_core::paths::{ensure_private_dir, kube_dir};
#[cfg(test)]
pub use jp_auth_core::paths::{jet_pilot_home, HOME_ENV};

/// Activated JET Pilot-managed binaries; appended to `PATH` at startup.
pub fn managed_bin_dir() -> PathBuf {
    jp_auth_core::paths::bin_dir()
}

/// Downloaded tools, one directory per tool and version.
pub fn managed_tools_dir() -> PathBuf {
    jp_auth_core::paths::tools_dir()
}

/// Serialises tests that read or set process-wide environment variables
/// (`JET_PILOT_HOME`, `PATH`).
#[cfg(test)]
pub(crate) static TEST_ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn managed_dirs_follow_jet_pilot_home() {
        let _guard = crate::util::lock(&TEST_ENV_LOCK);
        let dir = tempfile::tempdir().unwrap();
        std::env::set_var(HOME_ENV, dir.path());

        assert_eq!(jet_pilot_home(), dir.path());
        assert_eq!(managed_bin_dir(), dir.path().join("bin"));
        assert_eq!(managed_tools_dir(), dir.path().join("tools"));
        // Nothing is created just by asking.
        assert!(!managed_bin_dir().exists());

        std::env::remove_var(HOME_ENV);
    }

    #[test]
    fn private_dir_is_created_owner_only() {
        let dir = tempfile::tempdir().unwrap();
        let nested = dir.path().join("a").join("b");
        ensure_private_dir(&nested).unwrap();
        assert!(nested.is_dir());
        // Idempotent.
        ensure_private_dir(&nested).unwrap();

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            for path in [dir.path().join("a"), nested] {
                let mode = std::fs::metadata(&path).unwrap().permissions().mode();
                assert_eq!(mode & 0o777, 0o700, "{}", path.display());
            }
        }
    }
}

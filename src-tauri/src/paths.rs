//! The JET Pilot home directory: `~/.kube/jet-pilot/` (Windows:
//! `%USERPROFILE%\.kube\jet-pilot\`), overridable with `JET_PILOT_HOME`.
//!
//! It lives next to the user's kubeconfig on purpose: later releases keep a
//! managed kubeconfig, a vault and a credential helper there, which external
//! terminals must find without the app running. For now it only holds
//! JET Pilot-managed tool downloads:
//! - `tools/<tool>/<version>/` the downloaded (verified) binaries;
//! - `bin/` the activated copies, appended to `PATH` at startup (after the
//!   user's own directories, so tools the user installed always win).
//!
//! Nothing is created at startup; directories are made (owner-only on unix)
//! when a tool is installed. Discovery's `~/.kube/*.yaml` glob is
//! non-recursive, so files in here are never picked up as kubeconfigs.

use std::path::{Path, PathBuf};

/// Overrides the home directory (tests, portable setups).
pub const HOME_ENV: &str = "JET_PILOT_HOME";

/// The user's home directory (`$HOME`, `%USERPROFILE%` on Windows), the
/// same resolution kube-rs uses for `~/.kube/config`.
pub fn user_home() -> Option<PathBuf> {
    std::env::home_dir().filter(|home| !home.as_os_str().is_empty())
}

/// `~/.kube`.
pub fn kube_dir() -> Option<PathBuf> {
    user_home().map(|home| home.join(".kube"))
}

/// `$JET_PILOT_HOME`, else `~/.kube/jet-pilot`.
pub fn jet_pilot_home() -> PathBuf {
    resolve_home(std::env::var_os(HOME_ENV).map(PathBuf::from), user_home())
}

fn resolve_home(override_dir: Option<PathBuf>, user_home: Option<PathBuf>) -> PathBuf {
    if let Some(dir) = override_dir.filter(|d| !d.as_os_str().is_empty()) {
        return dir;
    }
    // Without a home directory (never the case in a desktop session) fall
    // back to the temp dir rather than a path relative to the cwd.
    user_home
        .unwrap_or_else(std::env::temp_dir)
        .join(".kube")
        .join("jet-pilot")
}

/// Activated JET Pilot-managed binaries; appended to `PATH` at startup.
pub fn managed_bin_dir() -> PathBuf {
    jet_pilot_home().join("bin")
}

/// Downloaded tools, one directory per tool and version.
pub fn managed_tools_dir() -> PathBuf {
    jet_pilot_home().join("tools")
}

/// Creates `dir` (and missing parents). On unix the directories created here
/// and `dir` itself are owner-only (0700).
pub fn ensure_private_dir(dir: &Path) -> std::io::Result<()> {
    let mut builder = std::fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
        builder.mode(0o700);
        builder.create(dir)?;
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))
    }
    #[cfg(not(unix))]
    {
        builder.create(dir)
    }
}

/// Serialises tests that read or set process-wide environment variables
/// (`JET_PILOT_HOME`, `PATH`).
#[cfg(test)]
pub(crate) static TEST_ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn home_override_wins_and_empty_is_ignored() {
        let home = Some(PathBuf::from("/home/me"));
        assert_eq!(
            resolve_home(Some(PathBuf::from("/tmp/jp")), home.clone()),
            PathBuf::from("/tmp/jp")
        );
        assert_eq!(
            resolve_home(Some(PathBuf::new()), home.clone()),
            Path::new("/home/me").join(".kube").join("jet-pilot")
        );
        assert_eq!(
            resolve_home(None, home),
            Path::new("/home/me").join(".kube").join("jet-pilot")
        );
    }

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

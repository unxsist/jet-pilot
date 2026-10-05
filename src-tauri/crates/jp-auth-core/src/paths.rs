//! The JET Pilot home directory: `~/.kube/jet-pilot/` (Windows:
//! `%USERPROFILE%\.kube\jet-pilot\`), overridable with `JET_PILOT_HOME`.
//!
//! It lives next to the user's kubeconfig on purpose: external terminals
//! must find the managed kubeconfig, the credential helper and the vault
//! without the app running.
//! - `config` the managed kubeconfig (0600);
//! - `bin/` the credential helper and activated tool downloads;
//! - `tools/<tool>/<version>/` downloaded (verified) tools;
//! - `vault/` the encrypted secrets file.
//!
//! Nothing is created just by asking for a path. Directories are made
//! owner-only (0700 on unix) by [`ensure_private_dir`].

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

/// The home directory for an override and a user home (pure, for tests).
pub fn resolve_home(override_dir: Option<PathBuf>, user_home: Option<PathBuf>) -> PathBuf {
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

/// The managed kubeconfig.
pub fn managed_kubeconfig() -> PathBuf {
    jet_pilot_home().join("config")
}

/// The encrypted vault and its lock files.
pub fn vault_dir() -> PathBuf {
    jet_pilot_home().join("vault")
}

/// The credential helper and activated tools; appended to `PATH` at startup.
pub fn bin_dir() -> PathBuf {
    jet_pilot_home().join("bin")
}

/// Downloaded tools, one directory per tool and version.
pub fn tools_dir() -> PathBuf {
    jet_pilot_home().join("tools")
}

/// `jetpilot-auth`, `jetpilot-auth.exe` on Windows.
pub fn helper_file_name() -> String {
    format!("{}{}", crate::HELPER_NAME, std::env::consts::EXE_SUFFIX)
}

/// Where the helper is installed; managed kubeconfig entries point here.
pub fn helper_path() -> PathBuf {
    bin_dir().join(helper_file_name())
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
    fn helper_name_has_the_platform_suffix() {
        let name = helper_file_name();
        assert!(name.starts_with("jetpilot-auth"));
        assert_eq!(name.ends_with(".exe"), cfg!(windows));
    }

    #[test]
    fn private_dir_is_created_owner_only() {
        let dir = tempfile::tempdir().unwrap();
        let nested = dir.path().join("a").join("b");
        ensure_private_dir(&nested).unwrap();
        assert!(nested.is_dir());
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

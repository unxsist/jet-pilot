//! Workload operations that need more than the shell plugin offers.
//!
//! `helm upgrade` / `helm template` / `helm diff upgrade` with edited values:
//! the values (which may contain secrets) are written to an owner-only
//! temporary file that is removed as soon as helm exits, instead of going
//! through a world-readable file picked by the frontend.

use serde::Serialize;
use std::io::Write;
use std::path::PathBuf;
use std::process::Stdio;
use std::time::Duration;
use tokio::process::Command;
use tracing::{info, warn};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

/// `helm upgrade --wait` / `--atomic` can legitimately take a while.
const HELM_TIMEOUT: Duration = Duration::from_secs(15 * 60);
const VALUES_PREFIX: &str = "jet-pilot-values-";

/// Helm subcommands accepted with a values file.
const ALLOWED: &[&[&str]] = &[&["upgrade"], &["template"], &["diff", "upgrade"]];

#[derive(Debug, Serialize, PartialEq)]
pub struct CliOutput {
    /// Exit code; None when killed by a signal.
    pub code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
}

/// Removes the values file when dropped, on every return path.
struct TempValues(PathBuf);

impl Drop for TempValues {
    fn drop(&mut self) {
        if let Err(e) = std::fs::remove_file(&self.0) {
            if e.kind() != std::io::ErrorKind::NotFound {
                warn!("Unable to remove temporary values file: {}", e);
            }
        }
    }
}

fn write_values(dir: &std::path::Path, values: &str) -> Result<TempValues, String> {
    let path = dir.join(format!("{}{}.yaml", VALUES_PREFIX, uuid::Uuid::new_v4()));
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(&path)
        .map_err(|e| format!("Unable to create a temporary values file: {}", e))?;
    let guard = TempValues(path);
    file.write_all(values.as_bytes())
        .and_then(|_| file.flush())
        .map_err(|e| format!("Unable to write the temporary values file: {}", e))?;
    Ok(guard)
}

fn validate_args(args: &[String]) -> Result<(), String> {
    let allowed = ALLOWED.iter().any(|prefix| {
        prefix.len() <= args.len() && prefix.iter().zip(args).all(|(a, b)| *a == b.as_str())
    });
    if !allowed {
        return Err(format!("helm {} is not supported here", args.first().map(String::as_str).unwrap_or("")));
    }
    // The values file is added here; a second one from the caller would
    // be merged silently.
    if args.iter().any(|a| a == "-f" || a == "--values" || a.starts_with("--values=")) {
        return Err("Values are passed separately".to_string());
    }
    Ok(())
}

pub(crate) async fn run_with_values(
    program: &str,
    args: Vec<String>,
    values: String,
    temp_dir: PathBuf,
) -> Result<CliOutput, String> {
    validate_args(&args)?;
    let values_file = write_values(&temp_dir, &values)?;

    let mut cmd = Command::new(program);
    cmd.args(&args)
        .arg(format!("--values={}", values_file.0.display()))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    cmd.creation_flags(0x08000000);

    info!("Running helm {} with edited values", args.first().map(String::as_str).unwrap_or(""));
    let output = tokio::time::timeout(HELM_TIMEOUT, cmd.output())
        .await
        .map_err(|_| "helm timed out after 15 minutes".to_string())?
        .map_err(|e| format!("Unable to run helm: {}", e))?;
    drop(values_file);

    Ok(CliOutput {
        code: output.status.code(),
        stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
    })
}

/// Runs `helm <args> --values <tmp>` with `values` in an owner-only
/// temporary file. Only `upgrade`, `template` and `diff upgrade` are
/// accepted. Returns exit code and output (a non-zero exit is not an error,
/// the frontend shows helm's stderr).
#[tauri::command]
pub async fn run_helm_with_values(args: Vec<String>, values: String) -> Result<CliOutput, String> {
    run_with_values("helm", args, values, std::env::temp_dir()).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(args: &[&str]) -> Vec<String> {
        args.iter().map(|a| a.to_string()).collect()
    }

    #[test]
    fn only_value_taking_subcommands_are_allowed() {
        assert!(validate_args(&s(&["upgrade", "web", "repo/web"])).is_ok());
        assert!(validate_args(&s(&["template", "web", "repo/web"])).is_ok());
        assert!(validate_args(&s(&["diff", "upgrade", "web", "repo/web"])).is_ok());
        assert!(validate_args(&s(&["uninstall", "web"])).is_err());
        assert!(validate_args(&s(&["diff", "rollback"])).is_err());
        assert!(validate_args(&s(&[])).is_err());
        assert!(validate_args(&s(&["upgrade", "web", "-f", "/etc/passwd"])).is_err());
        assert!(validate_args(&s(&["upgrade", "web", "--values=/x"])).is_err());
    }

    #[test]
    fn values_file_is_private_and_removed() {
        let dir = std::env::temp_dir();
        let path = {
            let guard = write_values(&dir, "secret: hunter2\n").unwrap();
            assert_eq!(std::fs::read_to_string(&guard.0).unwrap(), "secret: hunter2\n");
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let mode = std::fs::metadata(&guard.0).unwrap().permissions().mode();
                assert_eq!(mode & 0o777, 0o600);
            }
            guard.0.clone()
        };
        assert!(!path.exists());
    }

    #[cfg(unix)]
    #[test]
    fn helm_gets_the_values_file_and_it_is_cleaned_up() {
        let dir = std::env::temp_dir().join(format!("jet-values-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        // `cat` the values file passed as the last argument.
        let script = dir.join("fake-helm");
        std::fs::write(&script, "#!/bin/sh\nfor last; do :; done\ncat \"${last#--values=}\"\necho done >&2\nexit 3\n").unwrap();
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        }

        let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let output = runtime
            .block_on(run_with_values(
                script.to_str().unwrap(),
                s(&["template", "web", "repo/web"]),
                "a: 1\n".to_string(),
                dir.clone(),
            ))
            .unwrap();
        assert_eq!(output, CliOutput { code: Some(3), stdout: "a: 1\n".into(), stderr: "done\n".into() });

        let leftovers = std::fs::read_dir(&dir)
            .unwrap()
            .filter(|e| e.as_ref().unwrap().file_name().to_string_lossy().starts_with(VALUES_PREFIX))
            .count();
        assert_eq!(leftovers, 0);
        let _ = std::fs::remove_dir_all(&dir);
    }
}

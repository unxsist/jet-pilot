//! Environment import at startup (replaces `fix-path-env`).
//!
//! Apps started from the Dock / a desktop launcher don't see the variables
//! users set in their shell rc files, so `kubectl`, `aws`, `gcloud`, ... are
//! missing from `PATH` and exec credential plugins lose their profile. On
//! unix the user's login shell is run once (`$SHELL -ilc`, 3 s timeout, no
//! terminal) to print its environment between random marker lines, so rc
//! file noise is ignored. Only an allowlist of variables is imported:
//! existing process values win, except `PATH`, which becomes the shell's
//! entries followed by the process entries it lacks.
//!
//! Then, on every platform, the JET Pilot-managed `bin/` directory is
//! appended to `PATH`: tools the user installed always win, managed
//! downloads are the fallback. Terminals, the shell plugin and every
//! spawned kubectl/helm inherit the result.
//!
//! All of this runs in `main()` before Tauri starts any threads (it calls
//! `set_var`). The report (variable names only, never values) is available
//! to the frontend through `env_import_report`.

// The parsing and merging helpers are only used on unix.
#![cfg_attr(not(unix), allow(dead_code))]

use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::Instant;

use serde::Serialize;
use tracing::info;

use crate::paths;

/// How long the login shell may take before it is killed.
#[cfg(unix)]
const SHELL_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(3);

/// The variables taken from the login shell. Anything else (tokens, API
/// keys, ...) stays out of the app's environment.
pub const ALLOWLIST: &[&str] = &[
    "PATH",
    "KUBECONFIG",
    "AWS_PROFILE",
    "AWS_DEFAULT_PROFILE",
    "AWS_REGION",
    "AWS_DEFAULT_REGION",
    "AWS_CONFIG_FILE",
    "AWS_SHARED_CREDENTIALS_FILE",
    "AWS_CA_BUNDLE",
    "CLOUDSDK_CONFIG",
    "CLOUDSDK_ACTIVE_CONFIG_NAME",
    "USE_GKE_GCLOUD_AUTH_PLUGIN",
    "AZURE_CONFIG_DIR",
    "KUBECACHEDIR",
    "HELM_CACHE_HOME",
    "HELM_CONFIG_HOME",
    "HELM_DATA_HOME",
    "http_proxy",
    "https_proxy",
    "no_proxy",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "ALL_PROXY",
    "all_proxy",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "REQUESTS_CA_BUNDLE",
    "XDG_CONFIG_HOME",
];

#[derive(Debug, Clone, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EnvImportReport {
    /// The shell that was run (unix only).
    pub shell: Option<String>,
    /// Names of the variables that were set or changed (never values).
    pub imported: Vec<String>,
    pub duration_ms: u64,
    /// Why the shell environment could not be read; the managed `bin/` is
    /// still added to `PATH`.
    pub error: Option<String>,
    pub managed_bin_dir: String,
}

static REPORT: OnceLock<EnvImportReport> = OnceLock::new();

/// Imports the login shell environment and appends the managed `bin/` to
/// `PATH`. Call once, before any other thread runs.
pub fn import() {
    let started = Instant::now();
    let mut report = EnvImportReport::default();

    #[cfg(unix)]
    {
        let shell = login_shell(std::env::var_os("SHELL").as_deref());
        match unix::read_shell_env(&shell, SHELL_TIMEOUT) {
            Ok(shell_env) => {
                let updates = plan_updates(&shell_env, |name| std::env::var_os(name));
                for (name, value) in &updates {
                    std::env::set_var(name, value);
                }
                report.imported = updates.into_iter().map(|(name, _)| name).collect();
            }
            Err(e) => {
                tracing::warn!(
                    "Could not read the login shell environment ({}): {}",
                    shell,
                    e
                );
                report.error = Some(e);
            }
        }
        report.shell = Some(shell);
    }

    let bin = paths::managed_bin_dir();
    let path = std::env::var_os("PATH").unwrap_or_default();
    if let Some(path) = append_to_path(&path, &bin) {
        std::env::set_var("PATH", path);
    }

    report.managed_bin_dir = bin.to_string_lossy().into_owned();
    report.duration_ms = started.elapsed().as_millis() as u64;
    info!(
        "Environment import: {:?} from {} in {} ms",
        report.imported,
        report.shell.as_deref().unwrap_or("no shell"),
        report.duration_ms
    );
    let _ = REPORT.set(report);
}

/// What the startup environment import did (variable names only).
#[tauri::command]
pub fn env_import_report() -> EnvImportReport {
    REPORT.get().cloned().unwrap_or_else(|| EnvImportReport {
        managed_bin_dir: paths::managed_bin_dir().to_string_lossy().into_owned(),
        ..Default::default()
    })
}

/// `$SHELL`, else the platform's default login shell.
#[cfg(unix)]
fn login_shell(shell: Option<&OsStr>) -> String {
    shell
        .map(|s| s.to_string_lossy().trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| {
            if cfg!(target_os = "macos") {
                "/bin/zsh".to_string()
            } else {
                "/bin/sh".to_string()
            }
        })
}

/// The command line run by the login shell: the environment between two
/// marker lines. `env -0` keeps multi-line values intact; plain `env` is the
/// fallback for an `env` without `-0`. Valid in sh, bash, zsh and fish.
fn env_script(marker: &str) -> String {
    format!(
        "printf '\\n%s\\n' '{marker}'; command env -0 2>/dev/null || command env; printf '\\n%s\\n' '{marker}'"
    )
}

/// The bytes between the first two `\n<marker>\n` lines, if both were printed.
fn extract_block<'a>(output: &'a [u8], marker: &str) -> Option<&'a [u8]> {
    let fence = format!("\n{marker}\n");
    let fence = fence.as_bytes();
    let start = find(output, fence)? + fence.len();
    let end = find(&output[start..], fence)? + start;
    Some(&output[start..end])
}

fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).position(|w| w == needle)
}

/// Parses `env -0` output (or newline-separated `env` output when it
/// contains no NUL) into name/value pairs, in order.
fn parse_env_block(block: &[u8]) -> Vec<(String, OsString)> {
    let separator = if block.contains(&0) { 0 } else { b'\n' };
    block
        .split(|b| *b == separator)
        .filter_map(|entry| {
            let eq = entry.iter().position(|b| *b == b'=')?;
            let name = std::str::from_utf8(&entry[..eq]).ok()?;
            if name.is_empty() {
                return None;
            }
            Some((name.to_string(), bytes_to_os(&entry[eq + 1..])))
        })
        .collect()
}

#[cfg(unix)]
fn bytes_to_os(bytes: &[u8]) -> OsString {
    use std::os::unix::ffi::OsStringExt;
    OsString::from_vec(bytes.to_vec())
}

#[cfg(not(unix))]
fn bytes_to_os(bytes: &[u8]) -> OsString {
    OsString::from(String::from_utf8_lossy(bytes).into_owned())
}

/// The allowlisted variables to set from `shell_env`, given the current
/// process environment (`current`). A process value (non-empty) wins, except
/// for `PATH`, which is merged. Empty shell values are ignored.
fn plan_updates(
    shell_env: &[(String, OsString)],
    current: impl Fn(&str) -> Option<OsString>,
) -> Vec<(String, OsString)> {
    let mut updates = Vec::new();
    for name in ALLOWLIST {
        // `env -0` prints each name once; with the newline fallback a
        // multi-line value could repeat a name, so take the first.
        let Some(value) = shell_env
            .iter()
            .find(|(n, _)| n == name)
            .map(|(_, v)| v)
            .filter(|v| !v.is_empty())
        else {
            continue;
        };
        let existing = current(name).filter(|v| !v.is_empty());
        if *name == "PATH" {
            let merged = merge_path(value, existing.as_deref().unwrap_or_default());
            if existing.as_ref() != Some(&merged) {
                updates.push((name.to_string(), merged));
            }
        } else if existing.is_none() {
            updates.push((name.to_string(), value.clone()));
        }
    }
    updates
}

/// The shell's `PATH` entries, then the process entries it lacks (no empty
/// entries, no duplicates).
fn merge_path(shell: &OsStr, process: &OsStr) -> OsString {
    let mut dirs: Vec<PathBuf> = Vec::new();
    for dir in std::env::split_paths(shell).chain(std::env::split_paths(process)) {
        if !dir.as_os_str().is_empty() && !dirs.contains(&dir) {
            dirs.push(dir);
        }
    }
    std::env::join_paths(dirs).unwrap_or_else(|_| shell.to_os_string())
}

/// `path` with `dir` appended, or None when it is already on it.
fn append_to_path(path: &OsStr, dir: &Path) -> Option<OsString> {
    let mut dirs: Vec<PathBuf> = std::env::split_paths(path)
        .filter(|d| !d.as_os_str().is_empty())
        .collect();
    if dirs.iter().any(|d| d == dir) {
        return None;
    }
    dirs.push(dir.to_path_buf());
    std::env::join_paths(dirs).ok()
}

#[cfg(unix)]
mod unix {
    use std::ffi::OsString;
    use std::io::Read;
    use std::os::unix::process::CommandExt;
    use std::process::{Child, Command, Stdio};
    use std::sync::mpsc::{self, RecvTimeoutError};
    use std::time::{Duration, Instant};

    use super::{env_script, extract_block, parse_env_block};

    /// More than any real environment; a shell printing endlessly is cut off.
    const MAX_OUTPUT: usize = 4 * 1024 * 1024;

    /// Runs `shell -ilc <script>` and returns the environment it printed.
    pub(super) fn read_shell_env(
        shell: &str,
        timeout: Duration,
    ) -> Result<Vec<(String, OsString)>, String> {
        let deadline = Instant::now() + timeout;
        let marker = format!("__JET_PILOT_ENV_{}__", uuid::Uuid::new_v4().simple());

        let mut cmd = Command::new(shell);
        cmd.arg("-ilc")
            .arg(env_script(&marker))
            // oh-my-zsh: never prompt for an update.
            .env("DISABLE_AUTO_UPDATE", "true")
            // Lets rc files skip slow or interactive setup.
            .env("JET_PILOT_RESOLVING_ENVIRONMENT", "1")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        // A new session: the interactive shell gets no controlling terminal
        // (it must not grab the one the app was started from) and leads its
        // own process group, so a hung rc file is killed with its children.
        unsafe {
            cmd.pre_exec(|| {
                if libc::setsid() == -1 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }

        let mut child = cmd
            .spawn()
            .map_err(|e| format!("Unable to start the login shell: {e}"))?;
        let mut stdout = child
            .stdout
            .take()
            .ok_or_else(|| "The login shell has no output pipe".to_string())?;

        // A reader thread, so the deadline holds even when a background
        // process the rc files started keeps the pipe open.
        let (tx, rx) = mpsc::channel::<Vec<u8>>();
        std::thread::spawn(move || {
            let mut buf = [0u8; 16 * 1024];
            loop {
                match stdout.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        if tx.send(buf[..n].to_vec()).is_err() {
                            break;
                        }
                    }
                }
            }
        });

        let mut output = Vec::new();
        let mut complete = false;
        while !complete && output.len() < MAX_OUTPUT {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                break;
            }
            match rx.recv_timeout(remaining) {
                Ok(chunk) => {
                    output.extend_from_slice(&chunk);
                    complete = extract_block(&output, &marker).is_some();
                }
                Err(RecvTimeoutError::Timeout) | Err(RecvTimeoutError::Disconnected) => break,
            }
        }

        // The environment is complete: logout scripts get a moment, a hung
        // shell is killed (with its process group) at the deadline.
        let grace = if complete {
            deadline.min(Instant::now() + Duration::from_millis(250))
        } else {
            deadline
        };
        let status = wait_until(&mut child, grace);
        if status.is_none() {
            kill_group(&mut child);
        }

        match extract_block(&output, &marker) {
            Some(block) => Ok(parse_env_block(block)),
            None if status.is_none() => Err(format!(
                "The login shell did not finish within {} seconds",
                timeout.as_secs_f32()
            )),
            None => Err(format!(
                "The login shell exited without printing its environment ({})",
                status.map(|s| s.to_string()).unwrap_or_default()
            )),
        }
    }

    fn wait_until(child: &mut Child, deadline: Instant) -> Option<std::process::ExitStatus> {
        loop {
            match child.try_wait() {
                Ok(Some(status)) => return Some(status),
                Ok(None) if Instant::now() < deadline => {
                    std::thread::sleep(Duration::from_millis(10))
                }
                _ => return None,
            }
        }
    }

    /// Kills the shell's process group (it is the group leader, see
    /// `setsid`) and reaps the shell. Only called while the shell is not
    /// reaped yet, so its pid can't have been reused.
    fn kill_group(child: &mut Child) {
        if let Ok(pid) = libc::pid_t::try_from(child.id()) {
            unsafe {
                libc::kill(-pid, libc::SIGKILL);
            }
        }
        let _ = child.kill();
        let _ = child.wait();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn os(s: &str) -> OsString {
        OsString::from(s)
    }

    fn joined(dirs: &[&str]) -> OsString {
        std::env::join_paths(dirs).unwrap()
    }

    #[test]
    fn extracts_the_environment_between_markers_ignoring_rc_noise() {
        let marker = "__JET_PILOT_ENV_abc__";
        let output = format!(
            "Welcome back!\nnvm: using node 22{nl}{marker}\nPATH=/usr/bin\0KUBECONFIG=/k\0{nl}{marker}\nbye\n",
            nl = "\n"
        );
        let block = extract_block(output.as_bytes(), marker).unwrap();
        assert_eq!(
            parse_env_block(block),
            vec![
                ("PATH".into(), os("/usr/bin")),
                ("KUBECONFIG".into(), os("/k"))
            ]
        );

        // The second marker never came (timeout / crash).
        let partial = format!("noise\n{marker}\nPATH=/usr/bin\0");
        assert_eq!(extract_block(partial.as_bytes(), marker), None);
        // The marker text inside rc noise without its own line doesn't count.
        assert_eq!(
            extract_block(format!("x{marker}y").as_bytes(), marker),
            None
        );
    }

    #[test]
    fn nul_separated_values_may_span_lines() {
        let block = b"FOO=line one\nPATH=/evil\0PATH=/usr/bin:/bin\0EMPTY=\0=weird\0";
        assert_eq!(
            parse_env_block(block),
            vec![
                ("FOO".into(), os("line one\nPATH=/evil")),
                ("PATH".into(), os("/usr/bin:/bin")),
                ("EMPTY".into(), os("")),
            ]
        );
    }

    #[test]
    fn newline_output_is_the_fallback() {
        let block = b"PATH=/usr/bin\nAWS_PROFILE=dev\nnot a variable\n";
        assert_eq!(
            parse_env_block(block),
            vec![
                ("PATH".into(), os("/usr/bin")),
                ("AWS_PROFILE".into(), os("dev"))
            ]
        );
    }

    #[test]
    fn only_allowlisted_variables_are_imported_and_process_values_win() {
        let shell_env = vec![
            ("KUBECONFIG".to_string(), os("/shell/kubeconfig")),
            ("AWS_PROFILE".to_string(), os("shell-profile")),
            ("AWS_SECRET_ACCESS_KEY".to_string(), os("secret")),
            ("GITHUB_TOKEN".to_string(), os("secret")),
            ("https_proxy".to_string(), os("http://proxy:3128")),
            ("HELM_CACHE_HOME".to_string(), os("")),
        ];
        let process: HashMap<&str, OsString> = HashMap::from([
            ("KUBECONFIG", os("/app/kubeconfig")),
            ("AWS_PROFILE", os("")),
            ("HELM_CACHE_HOME", os("/app/helm")),
        ]);
        let updates = plan_updates(&shell_env, |name| process.get(name).cloned());

        assert_eq!(
            updates,
            vec![
                // An empty process value counts as unset.
                ("AWS_PROFILE".to_string(), os("shell-profile")),
                ("https_proxy".to_string(), os("http://proxy:3128")),
            ]
        );
    }

    #[test]
    fn path_is_merged_shell_first_without_duplicates() {
        let shell_env = vec![(
            "PATH".to_string(),
            joined(&["/opt/homebrew/bin", "/usr/bin", "/usr/bin/", "/bin"]),
        )];
        let process = joined(&["/usr/bin", "/bin", "", "/app/only"]);
        let updates = plan_updates(&shell_env, |name| (name == "PATH").then(|| process.clone()));
        assert_eq!(
            updates,
            vec![(
                "PATH".to_string(),
                joined(&["/opt/homebrew/bin", "/usr/bin", "/bin", "/app/only"])
            )]
        );

        // Nothing new: no update.
        let same = joined(&["/usr/bin", "/bin"]);
        let shell_env = vec![("PATH".to_string(), same.clone())];
        assert!(plan_updates(&shell_env, |_| Some(same.clone())).is_empty());

        // No process PATH at all.
        let shell_env = vec![("PATH".to_string(), joined(&["/usr/bin"]))];
        assert_eq!(
            plan_updates(&shell_env, |_| None),
            vec![("PATH".to_string(), joined(&["/usr/bin"]))]
        );
    }

    #[test]
    fn managed_bin_is_appended_once() {
        let bin = Path::new("/home/me/.kube/jet-pilot/bin");
        assert_eq!(
            append_to_path(&joined(&["/usr/bin", "/bin"]), bin),
            Some(joined(&[
                "/usr/bin",
                "/bin",
                "/home/me/.kube/jet-pilot/bin"
            ]))
        );
        assert_eq!(
            append_to_path(&joined(&["/usr/bin", "/home/me/.kube/jet-pilot/bin"]), bin),
            None
        );
        assert_eq!(
            append_to_path(OsStr::new(""), bin),
            Some(joined(&["/home/me/.kube/jet-pilot/bin"]))
        );
    }

    #[test]
    fn report_serializes_names_in_camel_case() {
        let report = EnvImportReport {
            shell: Some("/bin/zsh".into()),
            imported: vec!["PATH".into()],
            duration_ms: 12,
            error: None,
            managed_bin_dir: "/b".into(),
        };
        let json = serde_json::to_value(report).unwrap();
        assert_eq!(json["durationMs"], 12);
        assert_eq!(json["managedBinDir"], "/b");
        assert_eq!(json["imported"][0], "PATH");
    }

    #[cfg(unix)]
    fn fake_shell(body: &str) -> (tempfile::TempDir, String) {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("fake-shell");
        std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        let path = path.to_string_lossy().into_owned();
        (dir, path)
    }

    /// `$1` is `-ilc`, `$2` the script; rc noise goes around it.
    #[cfg(unix)]
    #[test]
    fn reads_the_environment_from_a_shell() {
        let (_dir, shell) = fake_shell(
            "echo 'rc noise'\nexport KUBECONFIG=/from/shell\n/bin/sh -c \"$2\"\necho 'logout noise'",
        );
        let env = unix::read_shell_env(&shell, std::time::Duration::from_secs(10)).unwrap();
        assert!(env.contains(&("KUBECONFIG".to_string(), os("/from/shell"))));
        assert!(env.contains(&("DISABLE_AUTO_UPDATE".to_string(), os("true"))));
    }

    #[cfg(unix)]
    #[test]
    fn a_hanging_shell_is_killed_at_the_timeout() {
        let dir = tempfile::tempdir().unwrap();
        let pid_file = dir.path().join("pid");
        let (_shell_dir, shell) = fake_shell(&format!(
            "sleep 30 &\necho $! > '{}'\nwait",
            pid_file.display()
        ));
        let started = Instant::now();
        let err = unix::read_shell_env(&shell, std::time::Duration::from_millis(300)).unwrap_err();
        assert!(err.contains("did not finish"), "{err}");
        assert!(started.elapsed() < std::time::Duration::from_secs(5));

        // The rc file's background process went down with the shell.
        #[cfg(target_os = "linux")]
        {
            std::thread::sleep(std::time::Duration::from_millis(100));
            let pid = std::fs::read_to_string(&pid_file).unwrap();
            let stat =
                std::fs::read_to_string(format!("/proc/{}/stat", pid.trim())).unwrap_or_default();
            let state = stat
                .rsplit(')')
                .next()
                .unwrap_or("")
                .split_whitespace()
                .next();
            assert!(
                matches!(state, None | Some("Z") | Some("X")),
                "sleep still runs: {stat}"
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn a_shell_that_cannot_start_is_an_error() {
        assert!(
            unix::read_shell_env("/definitely/not/a/shell", std::time::Duration::from_secs(1))
                .is_err()
        );
    }
}

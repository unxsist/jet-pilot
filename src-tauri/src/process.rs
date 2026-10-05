//! Spawning helper processes (tool version checks, installers) the same way
//! everywhere: no stdin, killed when the owning future is dropped, and no
//! console window on Windows.

use std::ffi::OsStr;
use std::fmt;
use std::process::{Output, Stdio};
use std::time::Duration;

/// `CREATE_NO_WINDOW`: spawning a console-subsystem binary from a GUI app
/// otherwise opens a visible console window (issue #70).
#[cfg(windows)]
pub const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// A command with stdin closed, `kill_on_drop` and (on Windows) no console
/// window (`creation_flags` is inherent on tokio's `Command`). Callers add args/env and usually run it with [`run_with_timeout`].
pub fn command(program: impl AsRef<OsStr>) -> tokio::process::Command {
    let mut cmd = tokio::process::Command::new(program);
    cmd.stdin(Stdio::null()).kill_on_drop(true);
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd
}

#[derive(Debug, Clone, PartialEq)]
pub enum ProcessError {
    /// The program does not exist (or is not executable).
    NotFound,
    /// The process did not finish in time and was killed.
    Timeout,
    Io(String),
}

impl fmt::Display for ProcessError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ProcessError::NotFound => f.write_str("the program was not found"),
            ProcessError::Timeout => f.write_str("the program did not finish in time"),
            ProcessError::Io(e) => f.write_str(e),
        }
    }
}

impl std::error::Error for ProcessError {}

/// Runs `cmd` capturing stdout and stderr. A process still running after
/// `timeout` is killed (`kill_on_drop`) and `Timeout` returned. A non-zero
/// exit is not an error: check `output.status`.
pub async fn run_with_timeout(
    mut cmd: tokio::process::Command,
    timeout: Duration,
) -> Result<Output, ProcessError> {
    cmd.stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let child = cmd.spawn().map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => ProcessError::NotFound,
        _ => ProcessError::Io(e.to_string()),
    })?;
    match tokio::time::timeout(timeout, child.wait_with_output()).await {
        Ok(output) => output.map_err(|e| ProcessError::Io(e.to_string())),
        // Dropping the wait future drops the child, which kills it.
        Err(_) => Err(ProcessError::Timeout),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn missing_program_is_not_found() {
        let result = run_with_timeout(
            command("jet-pilot-definitely-not-a-real-binary"),
            Duration::from_secs(5),
        )
        .await;
        assert_eq!(result.unwrap_err(), ProcessError::NotFound);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn captures_output_and_exit_status() {
        let mut cmd = command("sh");
        cmd.args(["-c", "echo out; echo err >&2; exit 3"]);
        let output = run_with_timeout(cmd, Duration::from_secs(10))
            .await
            .unwrap();
        assert_eq!(output.status.code(), Some(3));
        assert_eq!(String::from_utf8_lossy(&output.stdout), "out\n");
        assert_eq!(String::from_utf8_lossy(&output.stderr), "err\n");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn slow_process_times_out_quickly() {
        let mut cmd = command("sleep");
        cmd.arg("30");
        let started = std::time::Instant::now();
        let result = run_with_timeout(cmd, Duration::from_millis(200)).await;
        assert_eq!(result.unwrap_err(), ProcessError::Timeout);
        assert!(started.elapsed() < Duration::from_secs(5));
    }
}

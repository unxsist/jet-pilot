//! `kubectl port-forward` as the fallback engine.
//!
//! Only used when the cluster (or a proxy in front of it) refuses the
//! WebSocket upgrade native forwarding needs: kubectl handles that by
//! falling back to SPDY, which kube-rs doesn't speak. Such a forward
//! doesn't heal itself; it behaves like forwards always did:
//!
//! - stdout + stderr are classified into ready / error / informational lines
//!   (kubectl reports progress on stdout and per-connection chatter on
//!   stderr, so stderr output alone is not an error: issue #37)
//! - a forward that does not become ready within the start-up timeout fails
//!   with the last kubectl output as error
//! - an unexpected exit is surfaced as an error

use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tauri::Emitter;
use tokio::io::{AsyncBufReadExt, AsyncRead, BufReader};
use tokio::process::{Child, Command};
use tokio::time::Instant;
use tracing::{info, warn};

use super::{machine, ForwardStatus, PortForwardInfo, PortForwardSpec, STARTUP_TIMEOUT};
use crate::auth::center::{self, IssueSource};
use crate::util::lock;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

/// Lines that indicate a genuine problem with the forward.
pub(crate) fn is_error_line(line: &str) -> bool {
    let lower = line.to_lowercase();
    lower.starts_with("error:")
        || lower.starts_with("fatal:")
        || lower.contains("unable to")
        || lower.contains("failed to")
        || lower.contains("connection refused")
        || lower.contains("address already in use")
}

/// The context of a forward, for auth issues: (kubeconfig, context).
type ForwardTarget = Arc<(String, String)>;

/// Reads one kubectl output stream line by line and updates the forward's
/// status. Errors are only fatal while the forward is starting: once ready,
/// kubectl keeps running and reports per-connection failures ("an error
/// occurred forwarding ...") that do not affect other connections.
async fn read_output<R: AsyncRead + Unpin>(
    app: tauri::AppHandle,
    info: Arc<Mutex<PortForwardInfo>>,
    last_output: Arc<Mutex<Option<String>>>,
    target: ForwardTarget,
    stream: R,
) {
    let mut reader = BufReader::new(stream);
    loop {
        let mut line = String::new();
        match reader.read_line(&mut line).await {
            Ok(0) => break,
            Ok(_) => {
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }
                if !trimmed.contains("Handling connection for") {
                    *lock(&last_output) = Some(trimmed.to_string());
                    // Credential problems (expired sign-in, a plugin waiting
                    // for a device code) go to the auth center.
                    center::report_kubectl_failure(&target.0, &target.1, IssueSource::PortForward, trimmed);
                }

                let event = {
                    let mut current = lock(&info);
                    if trimmed.contains("Forwarding from") {
                        if current.status == ForwardStatus::Starting {
                            current.status = ForwardStatus::Ready;
                            Some((machine::EVENT_READY, current.clone()))
                        } else {
                            None
                        }
                    } else if is_error_line(trimmed) {
                        if current.status == ForwardStatus::Starting && current.error.is_none() {
                            tracing::error!("port forward {} error: {}", current.id, trimmed);
                            Some((machine::on_failed(&mut current, trimmed), current.clone()))
                        } else {
                            warn!("port forward {}: {}", current.id, trimmed);
                            None
                        }
                    } else {
                        None
                    }
                };
                if let Some((name, payload)) = event {
                    let _ = app.emit(name, payload);
                }
            }
            Err(e) => {
                warn!("Failed reading port forward output: {}", e);
                break;
            }
        }
    }
}

/// How a kubectl forward ended (stopping it aborts the task instead).
pub enum End {
    /// It failed while starting (already reported).
    Failed,
    /// The process exited.
    Exited,
}

fn command(spec: &PortForwardSpec, local_port: u16) -> Command {
    let mut args: Vec<String> = vec![
        "port-forward".into(),
        "--context".into(),
        spec.context.clone(),
        "--namespace".into(),
        spec.namespace.clone(),
        format!("{}/{}", spec.object_type, spec.object_name),
        format!("{}:{}", local_port, spec.object_port),
        format!("--address={}", spec.address),
    ];
    // Only pass an explicit kubeconfig when the frontend has one. Absent that,
    // kubectl falls back to $KUBECONFIG / ~/.kube/config on its own.
    if !spec.kube_config.is_empty() {
        args.insert(1, spec.kube_config.clone());
        args.insert(1, "--kubeconfig".into());
    }

    let mut command = Command::new("kubectl");
    command.args(&args);
    // If this app process dies, take the forward down with us instead of
    // orphaning a kubectl process.
    command.kill_on_drop(true);
    // Both streams must be piped: tokio inherits stdio by default, which left
    // the ready line (stdout) unread.
    command.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    // Windows: a GUI app spawning a console-subsystem binary allocates a
    // visible console window per call unless suppressed (issue #70).
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    command
}

/// Runs `kubectl port-forward` for the forward until it fails or exits.
/// The child is kept in `child` so it can be killed synchronously on exit.
pub async fn run(
    app: tauri::AppHandle,
    spec: PortForwardSpec,
    info: Arc<Mutex<PortForwardInfo>>,
    child: Arc<Mutex<Option<Child>>>,
) -> End {
    let local_port = lock(&info).local_port;
    let mut process = match command(&spec, local_port).spawn() {
        Ok(process) => process,
        Err(e) => {
            let message = format!("Failed to launch kubectl port-forward. Is kubectl installed and on PATH? ({e})");
            tracing::error!("{message}");
            let payload = {
                let mut current = lock(&info);
                machine::on_failed(&mut current, &message);
                current.clone()
            };
            let _ = app.emit(machine::EVENT_ERROR, payload);
            return End::Failed;
        }
    };
    info!("Port forward {} uses kubectl", lock(&info).id);

    let last_output: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
    let target: ForwardTarget = Arc::new((
        crate::kubernetes::client::resolve_kubeconfig_path(Some(&spec.kube_config)),
        spec.context.clone(),
    ));
    if let Some(stdout) = process.stdout.take() {
        tokio::spawn(read_output(app.clone(), info.clone(), last_output.clone(), target.clone(), stdout));
    }
    if let Some(stderr) = process.stderr.take() {
        tokio::spawn(read_output(app.clone(), info.clone(), last_output.clone(), target.clone(), stderr));
    }
    *lock(&child) = Some(process);

    let started = Instant::now();
    loop {
        if lock(&info).status == ForwardStatus::Error {
            return End::Failed;
        }
        // Never leave the UI waiting forever.
        if started.elapsed() > STARTUP_TIMEOUT && lock(&info).status == ForwardStatus::Starting {
            let detail = lock(&last_output)
                .clone()
                .map(|line| format!(" Last kubectl output: {line}"))
                .unwrap_or_default();
            let message = format!(
                "The forward didn't become ready within {} seconds.{}",
                STARTUP_TIMEOUT.as_secs(),
                detail
            );
            let payload = {
                let mut current = lock(&info);
                machine::on_failed(&mut current, &message);
                current.clone()
            };
            let _ = app.emit(machine::EVENT_ERROR, payload);
            return End::Failed;
        }

        let exited = {
            let mut guard = lock(&child);
            match guard.as_mut().map(|c| c.try_wait()) {
                Some(Ok(Some(status))) => Some(status.code()),
                Some(Ok(None)) => None,
                Some(Err(e)) => {
                    warn!("Failed to poll kubectl port-forward: {}", e);
                    None
                }
                // Taken by a stop.
                None => return End::Exited,
            }
        };
        if let Some(code) = exited {
            if code != Some(0) {
                let message = format!(
                    "kubectl port-forward exited unexpectedly (exit code {})",
                    code.map(|c| c.to_string()).unwrap_or_else(|| "unknown".into())
                );
                let payload = {
                    let mut current = lock(&info);
                    (current.error.is_none()).then(|| {
                        machine::on_failed(&mut current, &message);
                        current.clone()
                    })
                };
                if let Some(payload) = payload {
                    let _ = app.emit(machine::EVENT_ERROR, payload);
                }
            }
            return End::Exited;
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn error_lines_are_classified() {
        assert!(is_error_line("error: unable to forward port"));
        assert!(is_error_line("bind: address already in use"));
        assert!(!is_error_line("Forwarding from 127.0.0.1:8080 -> 80"));
        assert!(!is_error_line("Handling connection for 8080"));
    }
}

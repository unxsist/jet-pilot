//! Real `kubectl port-forward` process management.
//!
//! The old implementation spawned `kubectl port-forward` from the frontend via
//! the shell plugin and treated *any* stderr output as a fatal error. That is
//! wrong: kubectl reports progress ("Forwarding from 127.0.0.1:8080 -> 80" on
//! stdout, per-connection chatter and errors on stderr), so the process was
//! killed the moment it became ready and the UI showed "nothing happens"
//! (issue #37). This module owns the child processes on the Rust side instead:
//!
//! - start/stop via dedicated commands
//! - stdout + stderr piped and classified into ready / error / informational
//!   lines
//! - a forward that does not become ready within `STARTUP_TIMEOUT` is stopped
//!   with the last kubectl output as error
//! - optional TTL that auto-stops a forward after a number of seconds
//! - unexpected process exit is detected and surfaced as an error
//! - lifecycle events emitted to the frontend (`port_forward_started`,
//!   `port_forward_ready`, `port_forward_error`, `port_forward_stopped`)
//! - all children are killed when the app exits

use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::Emitter;
use std::process::Stdio;
use tokio::io::{AsyncBufReadExt, AsyncRead, BufReader};
use tokio::process::{Child, Command};
use tracing::{info, warn};
use uuid::Uuid;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

/// Request payload for `start_port_forward`.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PortForwardSpec {
    pub kube_config: String,
    pub context: String,
    pub namespace: String,
    pub object_type: String,
    pub object_name: String,
    pub object_port: u16,
    pub local_port: u16,
    pub address: String,
    /// Stop the forward automatically after this many seconds. `None` = keep running.
    #[serde(default)]
    pub ttl_seconds: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ForwardStatus {
    Starting,
    Ready,
    Error,
}

/// Snapshot of a running forward, sent to the frontend as event payload and
/// returned by `start_port_forward` / `list_port_forwards`.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PortForwardInfo {
    pub id: String,
    pub context: String,
    pub namespace: String,
    pub object_type: String,
    pub object_name: String,
    pub object_port: u16,
    pub local_port: u16,
    pub address: String,
    pub status: ForwardStatus,
    pub error: Option<String>,
    pub started_at_ms: u64,
    pub expires_at_ms: Option<u64>,
}

/// Payload of the `port_forward_stopped` event.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoppedForward {
    pub id: String,
    /// `user` | `ttl` | `exited`
    pub reason: String,
    pub exit_code: Option<i32>,
}

struct ManagedForward {
    info: Arc<Mutex<PortForwardInfo>>,
    child: Arc<Mutex<Option<Child>>>,
    /// Set once the forward is being intentionally terminated so the monitor
    /// loop knows not to emit events for it.
    stopped: Arc<AtomicBool>,
}

static FORWARDS: Lazy<Mutex<HashMap<String, ManagedForward>>> = Lazy::new(|| Mutex::new(HashMap::new()));

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// How long kubectl may take to report "Forwarding from ..." before the
/// forward is considered failed.
const STARTUP_TIMEOUT: Duration = Duration::from_secs(30);

/// Lines that indicate a genuine problem with the forward.
fn is_error_line(line: &str) -> bool {
    let lower = line.to_lowercase();
    lower.starts_with("error:")
        || lower.starts_with("fatal:")
        || lower.contains("unable to")
        || lower.contains("failed to")
        || lower.contains("connection refused")
        || lower.contains("address already in use")
}

/// Reads one kubectl output stream line by line and updates the forward's
/// status. Errors are only fatal while the forward is starting: once ready,
/// kubectl keeps running and reports per-connection failures ("an error
/// occurred forwarding ...") that do not affect other connections.
async fn read_forward_output<R: AsyncRead + Unpin>(
    app: tauri::AppHandle,
    id: String,
    info: Arc<Mutex<PortForwardInfo>>,
    last_output: Arc<Mutex<Option<String>>>,
    stream: R,
) {
    let mut reader = BufReader::new(stream);
    loop {
        let mut line = String::new();
        match reader.read_line(&mut line).await {
            Ok(0) => break, // EOF: process closed the stream
            Ok(_) => {
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }

                if !trimmed.contains("Handling connection for") {
                    *last_output.lock().unwrap() = Some(trimmed.to_string());
                }

                let event = {
                    let mut current = info.lock().unwrap();
                    if trimmed.contains("Forwarding from") {
                        if current.status == ForwardStatus::Starting {
                            current.status = ForwardStatus::Ready;
                            Some(("port_forward_ready", current.clone()))
                        } else {
                            None
                        }
                    } else if is_error_line(trimmed) {
                        if current.status == ForwardStatus::Starting && current.error.is_none() {
                            current.status = ForwardStatus::Error;
                            current.error = Some(trimmed.to_string());
                            tracing::error!("port forward {} error: {}", id, trimmed);
                            Some(("port_forward_error", current.clone()))
                        } else {
                            warn!("port forward {}: {}", id, trimmed);
                            None
                        }
                    } else {
                        // "Handling connection for ..." and other chatter.
                        None
                    }
                };

                if let Some((name, payload)) = event {
                    let _ = app.emit(name, payload);
                }
            }
            Err(e) => {
                warn!("Failed reading port forward {} output: {}", id, e);
                break;
            }
        }
    }
}

/// Kill a forward and tell the frontend why it stopped. Safe to call when the
/// forward is already gone (e.g. it exited on its own) - it becomes a no-op.
async fn terminate_forward(app: &tauri::AppHandle, id: &str, reason: &str) -> Result<(), String> {
    let removed = FORWARDS.lock().unwrap().remove(id);
    let Some(forward) = removed else {
        return Ok(());
    };

    forward.stopped.store(true, Ordering::Relaxed);

    let child = forward.child.lock().unwrap().take();
    if let Some(mut child) = child {
        let _ = child.kill().await;
        let _ = child.wait().await;
    }

    info!("Port forward {} stopped (reason: {})", id, reason);
    let payload = StoppedForward {
        id: id.to_string(),
        reason: reason.to_string(),
        exit_code: None,
    };
    let _ = app.emit("port_forward_stopped", payload);

    Ok(())
}

/// Spawn `kubectl port-forward` and start tracking it.
#[tauri::command]
pub async fn start_port_forward(
    app: tauri::AppHandle,
    spec: PortForwardSpec,
) -> Result<PortForwardInfo, String> {
    let id = Uuid::new_v4().to_string();
    let started_at_ms = now_ms();
    let expires_at_ms = spec
        .ttl_seconds
        .and_then(|ttl| ttl.checked_mul(1000))
        .map(|ttl_ms| started_at_ms.saturating_add(ttl_ms));

    let mut args: Vec<String> = vec![
        "port-forward".into(),
        "--context".into(),
        spec.context.clone(),
        "--namespace".into(),
        spec.namespace.clone(),
        format!("{}/{}", spec.object_type, spec.object_name),
        format!("{}:{}", spec.local_port, spec.object_port),
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
    // `child.stderr` empty and the ready line (stdout) unread, so forwards
    // never left the "starting" state.
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    // Windows: a GUI app spawning a console-subsystem binary allocates a
    // visible console window per call unless suppressed (issue #70).
    #[cfg(windows)]
    command.creation_flags(0x08000000);

    let mut child = command.spawn().map_err(|e| {
        let message = format!(
            "Failed to launch kubectl port-forward. Is kubectl installed and on PATH? ({e})"
        );
        tracing::error!("{message}");
        message
    })?;

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    let info = PortForwardInfo {
        id: id.clone(),
        context: spec.context.clone(),
        namespace: spec.namespace.clone(),
        object_type: spec.object_type.clone(),
        object_name: spec.object_name.clone(),
        object_port: spec.object_port,
        local_port: spec.local_port,
        address: spec.address.clone(),
        status: ForwardStatus::Starting,
        error: None,
        started_at_ms,
        expires_at_ms,
    };

    let info_shared = Arc::new(Mutex::new(info.clone()));
    let child_shared: Arc<Mutex<Option<Child>>> = Arc::new(Mutex::new(Some(child)));
    let stopped_shared = Arc::new(AtomicBool::new(false));

    FORWARDS.lock().unwrap().insert(
        id.clone(),
        ManagedForward {
            info: info_shared.clone(),
            child: child_shared.clone(),
            stopped: stopped_shared.clone(),
        },
    );

    info!(
        "Started port forward {}: {}/{} {}:{} -> {}:{}",
        id,
        spec.context,
        spec.namespace,
        spec.local_port,
        spec.object_port,
        spec.address,
        spec.object_name
    );

    let _ = app.emit("port_forward_started", info.clone());

    // --- output readers: classify kubectl output into ready / error ---------
    let last_output: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
    if let Some(stdout) = stdout {
        tokio::spawn(read_forward_output(
            app.clone(),
            id.clone(),
            info_shared.clone(),
            last_output.clone(),
            stdout,
        ));
    }
    if let Some(stderr) = stderr {
        tokio::spawn(read_forward_output(
            app.clone(),
            id.clone(),
            info_shared.clone(),
            last_output.clone(),
            stderr,
        ));
    }

    // --- startup timeout: never leave the UI waiting forever --------------
    let startup_app = app.clone();
    let startup_id = id.clone();
    let startup_info = info_shared.clone();
    tokio::spawn(async move {
        tokio::time::sleep(STARTUP_TIMEOUT).await;
        let payload = {
            let mut current = startup_info.lock().unwrap();
            if current.status != ForwardStatus::Starting {
                return;
            }
            let detail = last_output
                .lock()
                .unwrap()
                .clone()
                .map(|line| format!(" Last kubectl output: {line}"))
                .unwrap_or_default();
            current.status = ForwardStatus::Error;
            current.error = Some(format!(
                "Port forward did not become ready within {} seconds.{}",
                STARTUP_TIMEOUT.as_secs(),
                detail
            ));
            current.clone()
        };
        tracing::error!("port forward {} startup timed out", startup_id);
        let _ = startup_app.emit("port_forward_error", payload);
        let _ = terminate_forward(&startup_app, &startup_id, "error").await;
    });

    // --- TTL: auto-stop after the requested duration ----------------------
    if let Some(ttl) = spec.ttl_seconds {
        let ttl_app = app.clone();
        let ttl_id = id.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_secs(ttl)).await;
            if FORWARDS.lock().unwrap().contains_key(&ttl_id) {
                info!("Port forward {} reached its TTL, stopping", ttl_id);
                let _ = terminate_forward(&ttl_app, &ttl_id, "ttl").await;
            }
        });
    }

    // --- Monitor: detect unexpected exit -----------------------------------
    let monitor_app = app.clone();
    let monitor_id = id.clone();
    let monitor_info = info_shared.clone();
    let monitor_child = child_shared.clone();
    let monitor_stopped = stopped_shared.clone();
    tokio::spawn(async move {
        loop {
            if monitor_stopped.load(Ordering::Relaxed) {
                return; // intentionally terminated elsewhere
            }

            let status = {
                let mut guard = monitor_child.lock().unwrap();
                match guard.as_mut() {
                    Some(child) => match child.try_wait() {
                        Ok(Some(status)) => Some(status),
                        Ok(None) => None,
                        Err(e) => {
                            warn!(
                                "Failed to poll port forward {}: {}",
                                monitor_id, e
                            );
                            None
                        }
                    },
                    None => return, // child already taken by terminate_forward
                }
            };

            match status {
                Some(status) => {
                    let exit_code = status.code();
                    let still_registered = FORWARDS.lock().unwrap().contains_key(&monitor_id);
                    if !still_registered || monitor_stopped.load(Ordering::Relaxed) {
                        return;
                    }

                    if exit_code != Some(0) {
                        let mut current = monitor_info.lock().unwrap();
                        if current.error.is_none() {
                            current.status = ForwardStatus::Error;
                            current.error = Some(format!(
                                "kubectl port-forward exited unexpectedly (exit code {})",
                                exit_code
                                    .map(|c| c.to_string())
                                    .unwrap_or_else(|| "unknown".into())
                            ));
                            tracing::error!(
                                "Port forward {} exited with code {:?}",
                                monitor_id,
                                exit_code
                            );
                            let payload = current.clone();
                            let _ = monitor_app.emit("port_forward_error", payload);
                        }
                    }

                    let _ = terminate_forward(&monitor_app, &monitor_id, "exited").await;
                    return;
                }
                None => tokio::time::sleep(Duration::from_millis(250)).await,
            }
        }
    });

    Ok(info)
}

/// Stop a running forward and kill its kubectl process.
#[tauri::command]
pub async fn stop_port_forward(app: tauri::AppHandle, id: String) -> Result<(), String> {
    info!("Stopping port forward {}", id);
    terminate_forward(&app, &id, "user").await
}

/// All currently tracked forwards. Used by the frontend to re-sync state after
/// the webview reloads (dev HMR, etc.).
#[tauri::command]
pub fn list_port_forwards() -> Vec<PortForwardInfo> {
    FORWARDS
        .lock()
        .unwrap()
        .values()
        .map(|forward| forward.info.lock().unwrap().clone())
        .collect()
}

/// Kill every tracked forward. Called on app exit so kubectl children do not
/// survive the app.
pub fn kill_all_port_forwards() {
    let forwards = std::mem::take(&mut *FORWARDS.lock().unwrap());
    for (_, forward) in forwards {
        forward.stopped.store(true, Ordering::Relaxed);
        if let Some(mut child) = forward.child.lock().unwrap().take() {
            // `start_kill` is synchronous; dropping the child afterwards (with
            // kill_on_drop(true)) guarantees the OS process is terminated.
            let _ = child.start_kill();
        }
    }
    info!("Killed all port forwards on exit");
}

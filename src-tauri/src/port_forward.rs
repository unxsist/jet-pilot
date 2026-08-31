//! Real `kubectl port-forward` process management.
//!
//! The old implementation spawned `kubectl port-forward` from the frontend via
//! the shell plugin and treated *any* stderr output as a fatal error. That is
//! wrong: kubectl reports "Forwarding from 127.0.0.1:8080 -> 80" on **stderr**,
//! so the process was killed the moment it became ready and the UI showed
//! "nothing happens" (issue #37). This module owns the child processes on the
//! Rust side instead:
//!
//! - start/stop via dedicated commands
//! - stderr classified into ready / error / informational lines
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
use tokio::io::{AsyncBufReadExt, BufReader};
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

/// Lines kubectl writes to stderr while a port-forward is healthy.
fn is_informational_line(line: &str) -> bool {
    line.contains("Forwarding from") || line.contains("Handling connection for")
}

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

    // --- stderr reader: classify output into ready / error -----------------
    let reader_app = app.clone();
    let reader_id = id.clone();
    let reader_info = info_shared.clone();
    tokio::spawn(async move {
        let Some(stderr) = stderr else {
            warn!("port forward {} has no stderr to read", reader_id);
            return;
        };
        let mut reader = BufReader::new(stderr);
        loop {
            let mut line = String::new();
            match reader.read_line(&mut line).await {
                Ok(0) => break, // EOF: process closed stderr
                Ok(_) => {
                    let trimmed = line.trim();
                    if trimmed.is_empty() {
                        continue;
                    }
                    if is_error_line(trimmed) {
                        let mut current = reader_info.lock().unwrap();
                        if current.error.is_none() {
                            current.status = ForwardStatus::Error;
                            current.error = Some(trimmed.to_string());
                            tracing::error!("port forward {} error: {}", reader_id, trimmed);
                            let payload = current.clone();
                            let _ = reader_app.emit("port_forward_error", payload);
                        }
                    } else if is_informational_line(trimmed) {
                        // "Forwarding from 127.0.0.1:8080 -> 80", "Handling
                        // connection for ..." — normal kubectl chatter.
                        if trimmed.contains("Forwarding from") {
                            let mut current = reader_info.lock().unwrap();
                            if current.status != ForwardStatus::Ready {
                                current.status = ForwardStatus::Ready;
                                let payload = current.clone();
                                let _ = reader_app.emit("port_forward_ready", payload);
                            }
                        }
                    }
                    // Everything else ("Handling connection for ...", etc.)
                    // is informational and ignored.
                }
                Err(e) => {
                    warn!(
                        "Failed reading port forward {} stderr: {}",
                        reader_id, e
                    );
                    break;
                }
            }
        }
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

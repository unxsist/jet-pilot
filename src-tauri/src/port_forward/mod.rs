//! Port forwards, managed on the Rust side.
//!
//! Forwards are native (see `native`): a local listener bridged to the pod
//! over the Kubernetes API with the cached kube client, so credentials, the
//! broker and re-auth work like everywhere else. Service and deployment
//! targets resolve to a ready pod, and when that pod goes away the forward
//! reconnects to another one while the local port stays open.
//!
//! kubectl is only the fallback (see `kubectl`) for clusters that refuse
//! WebSocket port-forwarding.
//!
//! - start / stop / restart via dedicated commands; `list_port_forwards`
//!   re-syncs the front end (and refreshes traffic counters)
//! - optional TTL that auto-stops a forward after a number of seconds
//! - lifecycle events: `port_forward_started`, `port_forward_ready`,
//!   `port_forward_reconnecting`, `port_forward_updated`,
//!   `port_forward_error`, `port_forward_stopped`
//! - a forward that fails while starting is removed (the caller gets the
//!   error); one that fails after it worked stays listed with its error
//! - everything stops when the app exits

pub mod http;
mod kubectl;
mod machine;
mod native;
mod resolve;

use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::Emitter;
use tokio::process::Child;
use tokio::task::JoinHandle;
use tracing::info;
use uuid::Uuid;

use crate::auth::center::{self, IssueSource};
use crate::kubernetes::client::{client_with_context, resolve_kubeconfig_path, with_auth_context};
use crate::util::lock;
use native::{Forward, KubeBackends, Outcome, Traffic};
use resolve::{Resolver, TargetKind};

/// How long a forward may take to become ready before it fails.
const STARTUP_TIMEOUT: Duration = Duration::from_secs(30);

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
    /// The remote port's name ("http"), for display.
    #[serde(default)]
    pub port_name: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ForwardStatus {
    Starting,
    Ready,
    Reconnecting,
    Error,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Engine {
    Native,
    Kubectl,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Reconnect {
    pub at_ms: u64,
    /// Why the previous pod was left ("pod was replaced").
    pub reason: String,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrafficSnapshot {
    pub open_connections: u32,
    pub connections: u64,
    pub bytes_sent: u64,
    pub bytes_received: u64,
}

/// Snapshot of a forward, sent to the frontend as event payload and
/// returned by `start_port_forward` / `list_port_forwards`.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PortForwardInfo {
    pub id: String,
    pub kube_config: String,
    pub context: String,
    pub namespace: String,
    pub object_type: String,
    pub object_name: String,
    pub object_port: u16,
    pub port_name: Option<String>,
    pub local_port: u16,
    pub address: String,
    pub ttl_seconds: Option<u64>,
    pub status: ForwardStatus,
    pub error: Option<String>,
    /// What a starting or reconnecting forward is waiting for.
    pub reason: Option<String>,
    /// The pod the forward currently talks to.
    pub pod: Option<String>,
    pub engine: Engine,
    pub reconnects: u32,
    pub last_reconnect: Option<Reconnect>,
    pub started_at_ms: u64,
    pub expires_at_ms: Option<u64>,
    pub traffic: TrafficSnapshot,
}

/// Payload of the `port_forward_stopped` event.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoppedForward {
    pub id: String,
    /// `user` | `ttl` | `exited` | `error`
    pub reason: String,
    pub exit_code: Option<i32>,
}

struct ManagedForward {
    spec: PortForwardSpec,
    info: Arc<Mutex<PortForwardInfo>>,
    traffic: Arc<Traffic>,
    /// The task running the forward; aborting it closes the listener and
    /// every connection.
    task: Option<JoinHandle<()>>,
    /// The kubectl process of a fallback forward (killed synchronously on
    /// app exit).
    child: Arc<Mutex<Option<Child>>>,
}

static FORWARDS: Lazy<Mutex<HashMap<String, ManagedForward>>> = Lazy::new(|| Mutex::new(HashMap::new()));

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// The current info of a forward (with its traffic counters).
fn snapshot(id: &str) -> Option<PortForwardInfo> {
    lock(&FORWARDS).get(id).map(|forward| {
        let mut info = lock(&forward.info).clone();
        info.traffic = forward.traffic.snapshot();
        info
    })
}

/// Rejects spec values that kubectl would parse as flags (e.g. an object
/// type of `--kubeconfig=...`, which ends up as a positional argument) and
/// empty values where a forward needs one.
fn validate_spec(spec: &PortForwardSpec) -> Result<(), String> {
    let fields = [
        ("kubeconfig", spec.kube_config.as_str(), false),
        ("context", spec.context.as_str(), true),
        ("namespace", spec.namespace.as_str(), false),
        ("object type", spec.object_type.as_str(), true),
        ("object name", spec.object_name.as_str(), true),
        ("address", spec.address.as_str(), true),
    ];
    for (field, value, required) in fields {
        if required && value.is_empty() {
            return Err(format!("Port forward {field} must not be empty"));
        }
        if value.starts_with('-') {
            return Err(format!("Invalid port forward {field}: {value}"));
        }
    }
    if TargetKind::parse(&spec.object_type).is_none() {
        return Err(format!("Can't forward to a {}", spec.object_type));
    }
    if spec.object_port == 0 {
        return Err("Pick a port to forward".into());
    }
    Ok(())
}

fn initial_info(id: &str, spec: &PortForwardSpec, expires_at_ms: Option<u64>) -> PortForwardInfo {
    PortForwardInfo {
        id: id.to_string(),
        kube_config: spec.kube_config.clone(),
        context: spec.context.clone(),
        namespace: spec.namespace.clone(),
        object_type: spec.object_type.clone(),
        object_name: spec.object_name.clone(),
        object_port: spec.object_port,
        port_name: spec.port_name.clone(),
        local_port: spec.local_port,
        address: spec.address.clone(),
        ttl_seconds: spec.ttl_seconds,
        status: ForwardStatus::Starting,
        error: None,
        reason: None,
        pod: None,
        engine: Engine::Native,
        reconnects: 0,
        last_reconnect: None,
        started_at_ms: now_ms(),
        expires_at_ms,
        traffic: TrafficSnapshot::default(),
    }
}

/// Fails a forward before the native machinery ran (bind, client).
fn fail(app: &tauri::AppHandle, info: &Arc<Mutex<PortForwardInfo>>, message: &str) {
    let payload = {
        let mut current = lock(info);
        machine::on_failed(&mut current, message);
        current.clone()
    };
    tracing::error!("Port forward {} failed: {}", payload.id, message);
    let _ = app.emit(machine::EVENT_ERROR, payload);
}

/// Removes a forward and tells the frontend why it stopped. Safe to call
/// when it's already gone. Its task is aborted, which closes the listener
/// and every connection; awaiting it makes sure the port is free again.
async fn terminate(app: &tauri::AppHandle, id: &str, reason: &str) {
    let removed = lock(&FORWARDS).remove(id);
    let Some(mut forward) = removed else {
        return;
    };
    if let Some(mut child) = lock(&forward.child).take() {
        let _ = child.start_kill();
    }
    if let Some(task) = forward.task.take() {
        task.abort();
        let _ = task.await;
    }
    info!("Port forward {} stopped (reason: {})", id, reason);
    let _ = app.emit(
        "port_forward_stopped",
        StoppedForward {
            id: id.to_string(),
            reason: reason.to_string(),
            exit_code: None,
        },
    );
}

/// [`terminate`] from inside the forward's own task: it can't await its
/// own abort, so the removal runs on a task of its own.
fn terminate_later(app: &tauri::AppHandle, id: &str, reason: &'static str) {
    let app = app.clone();
    let id = id.to_string();
    tokio::spawn(async move { terminate(&app, &id, reason).await });
}

/// Runs a forward: native first, kubectl if the cluster refuses WebSocket
/// port-forwarding. Ends when the forward fails (stopping aborts it).
async fn run_forward(
    app: tauri::AppHandle,
    spec: PortForwardSpec,
    info: Arc<Mutex<PortForwardInfo>>,
    traffic: Arc<Traffic>,
    child: Arc<Mutex<Option<Child>>>,
) {
    let id = lock(&info).id.clone();
    let local_port = lock(&info).local_port;
    let listeners = match native::bind(&spec.address, local_port).await {
        Ok(listeners) => listeners,
        Err(message) => {
            fail(&app, &info, &message);
            terminate_later(&app, &id, "error");
            return;
        }
    };
    // Port 0: the port the system picked.
    if let Some(bound) = listeners.first().and_then(|l| l.local_addr().ok()) {
        lock(&info).local_port = bound.port();
    }

    let client = match client_with_context(&spec.context, Some(&spec.kube_config)).await {
        Ok(client) => client,
        Err(err) => {
            let err = with_auth_context(err, &resolve_kubeconfig_path(Some(&spec.kube_config)), &spec.context);
            fail(&app, &info, &err.message);
            terminate_later(&app, &id, "error");
            return;
        }
    };
    let backends = KubeBackends {
        resolver: Resolver {
            client,
            namespace: spec.namespace.clone(),
            kind: TargetKind::parse(&spec.object_type).unwrap_or(TargetKind::Pod),
            name: spec.object_name.clone(),
            remote_port: spec.object_port,
        },
    };
    let emit_app = app.clone();
    let forward = Forward {
        info: info.clone(),
        traffic,
        backends: Arc::new(backends),
        emit: Arc::new(move |event, payload| {
            let _ = emit_app.emit(event, payload);
        }),
    };

    match native::run(forward, listeners, STARTUP_TIMEOUT).await {
        Outcome::Failed { started: false } => terminate_later(&app, &id, "error"),
        // It worked before: it stays listed with its error until it's
        // restarted or removed.
        Outcome::Failed { started: true } => {}
        Outcome::Fallback(reason) => {
            info!("Port forward {id} falls back to kubectl: {reason}");
            let payload = {
                let mut current = lock(&info);
                current.engine = Engine::Kubectl;
                current.reason = None;
                current.clone()
            };
            let _ = app.emit(machine::EVENT_UPDATED, payload);
            match kubectl::run(app.clone(), spec, info, child).await {
                kubectl::End::Failed => terminate_later(&app, &id, "error"),
                kubectl::End::Exited => terminate_later(&app, &id, "exited"),
            }
        }
    }
}

fn spawn_forward(app: &tauri::AppHandle, forward: &ManagedForward) -> JoinHandle<()> {
    tokio::spawn(center::with_source(
        IssueSource::PortForward,
        run_forward(
            app.clone(),
            forward.spec.clone(),
            forward.info.clone(),
            forward.traffic.clone(),
            forward.child.clone(),
        ),
    ))
}

/// Start a forward and begin tracking it.
#[tauri::command]
pub async fn start_port_forward(app: tauri::AppHandle, spec: PortForwardSpec) -> Result<PortForwardInfo, String> {
    validate_spec(&spec)?;

    let id = Uuid::new_v4().to_string();
    let expires_at_ms = spec
        .ttl_seconds
        .and_then(|ttl| ttl.checked_mul(1000))
        .map(|ttl_ms| now_ms().saturating_add(ttl_ms));
    let info = initial_info(&id, &spec, expires_at_ms);

    let mut forward = ManagedForward {
        spec: spec.clone(),
        info: Arc::new(Mutex::new(info.clone())),
        traffic: Arc::new(Traffic::default()),
        task: None,
        child: Arc::new(Mutex::new(None)),
    };
    info!(
        "Starting port forward {}: {}/{} {}/{}:{} -> {}:{}",
        id, spec.context, spec.namespace, spec.object_type, spec.object_name, spec.object_port, spec.address, spec.local_port
    );
    let _ = app.emit("port_forward_started", info.clone());
    forward.task = Some(spawn_forward(&app, &forward));
    lock(&FORWARDS).insert(id.clone(), forward);

    if let Some(ttl) = spec.ttl_seconds {
        let ttl_app = app.clone();
        let ttl_id = id.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_secs(ttl)).await;
            if lock(&FORWARDS).contains_key(&ttl_id) {
                info!("Port forward {} reached its TTL, stopping", ttl_id);
                terminate(&ttl_app, &ttl_id, "ttl").await;
            }
        });
    }

    Ok(info)
}

/// Stop a forward.
#[tauri::command]
pub async fn stop_port_forward(app: tauri::AppHandle, id: String) -> Result<(), String> {
    info!("Stopping port forward {}", id);
    terminate(&app, &id, "user").await;
    Ok(())
}

/// Start a forward again from scratch (same id, spec and local port):
/// after an error, or to pick a pod afresh.
#[tauri::command]
pub async fn restart_port_forward(app: tauri::AppHandle, id: String) -> Result<PortForwardInfo, String> {
    let (old_task, old_child) = {
        let mut forwards = lock(&FORWARDS);
        let forward = forwards.get_mut(&id).ok_or("This forward has stopped")?;
        let child = lock(&forward.child).take();
        (forward.task.take(), child)
    };
    if let Some(mut child) = old_child {
        let _ = child.start_kill();
    }
    // The old listener must be closed before the new one binds the port.
    if let Some(task) = old_task {
        task.abort();
        let _ = task.await;
    }

    let mut forwards = lock(&FORWARDS);
    let forward = forwards.get_mut(&id).ok_or("This forward has stopped")?;
    let info = {
        let mut current = lock(&forward.info);
        let mut fresh = initial_info(&id, &forward.spec, current.expires_at_ms);
        fresh.local_port = current.local_port;
        *current = fresh;
        current.clone()
    };
    forward.traffic = Arc::new(Traffic::default());
    info!("Restarting port forward {}", id);
    let _ = app.emit("port_forward_started", info.clone());
    forward.task = Some(spawn_forward(&app, forward));
    Ok(info)
}

/// All tracked forwards, with fresh traffic counters. Also used to re-sync
/// the frontend after the webview reloads (dev HMR, etc.).
#[tauri::command]
pub fn list_port_forwards() -> Vec<PortForwardInfo> {
    let ids: Vec<String> = lock(&FORWARDS).keys().cloned().collect();
    ids.iter().filter_map(|id| snapshot(id)).collect()
}

/// Which of `ports` are free to listen on at `address` (for suggesting a
/// local port).
#[tauri::command]
pub fn check_local_ports(address: String, ports: Vec<u16>) -> Vec<u16> {
    let host = if address.is_empty() || address.eq_ignore_ascii_case("localhost") {
        "127.0.0.1"
    } else {
        address.as_str()
    };
    ports
        .into_iter()
        .take(64)
        .filter(|port| *port > 0 && std::net::TcpListener::bind((host, *port)).is_ok())
        .collect()
}

/// Stop every forward. Called on app exit so no listener or kubectl child
/// survives the app.
pub fn kill_all_port_forwards() {
    let forwards = std::mem::take(&mut *lock(&FORWARDS));
    for (_, forward) in forwards {
        if let Some(task) = forward.task {
            task.abort();
        }
        if let Some(mut child) = lock(&forward.child).take() {
            // `start_kill` is synchronous; dropping the child afterwards (with
            // kill_on_drop(true)) guarantees the OS process is terminated.
            let _ = child.start_kill();
        }
    }
    info!("Stopped all port forwards on exit");
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    fn spec() -> PortForwardSpec {
        PortForwardSpec {
            kube_config: String::new(),
            context: "ctx".into(),
            namespace: "default".into(),
            object_type: "service".into(),
            object_name: "web".into(),
            object_port: 80,
            local_port: 8080,
            address: "127.0.0.1".into(),
            ttl_seconds: None,
            port_name: Some("http".into()),
        }
    }

    /// A starting forward, for the state machine tests.
    pub(crate) fn info() -> PortForwardInfo {
        initial_info("pf-1", &spec(), None)
    }

    #[test]
    fn validate_spec_rejects_flag_injection_and_unknown_targets() {
        assert!(validate_spec(&spec()).is_ok());

        let mut bad = spec();
        bad.object_type = "--kubeconfig=/tmp/evil".into();
        assert!(validate_spec(&bad).is_err());

        let mut bad = spec();
        bad.context = String::new();
        assert!(validate_spec(&bad).is_err());

        let mut bad = spec();
        bad.object_type = "statefulset".into();
        assert_eq!(validate_spec(&bad).unwrap_err(), "Can't forward to a statefulset");
    }

    #[test]
    fn free_ports_are_reported() {
        let taken = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let busy = taken.local_addr().unwrap().port();
        assert_eq!(check_local_ports("localhost".into(), vec![busy, 0]), Vec::<u16>::new());
        let free = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap().local_addr().unwrap().port();
        assert_eq!(check_local_ports("localhost".into(), vec![free]), vec![free]);
    }
}

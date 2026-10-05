//! Metrics service: polls metrics.k8s.io (pods + nodes) for every active
//! (kubeconfig, context, namespaces) subscription and streams the samples
//! over a Tauri channel, keeping the last `HISTORY_LEN` samples per pod and
//! node in ring buffers (for sparklines / trends).
//!
//! Messages:
//! - `{"type":"status","state":"syncing"|"ready"|"unavailable"|"forbidden"|"unauthorized"|"error","message"?}`
//!   (`unauthorized`: the credentials were rejected or need a sign-in; the
//!   poller is retried with a new client after a sign-in)
//! - `{"type":"sample","timestamp":ms,"pods":[PodMetrics...],"nodes":[NodeMetrics...]}`
//!   (objects tagged with metadata.context / metadata.kubeConfig, like rows)
//! - `{"type":"history","pods":{"ns/name":[[ms,cpuMillicores,memoryBytes],...]},"nodes":{...}}`
//!   sent once on subscribe.
//!
//! Clusters without metrics-server report `unavailable` and are re-checked
//! every minute. Polling stops while the window is hidden (see
//! `watch_set_paused`) and pollers stay warm for 60 s after the last
//! subscriber leaves, like the WatchHub.

use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use k8s_metrics::v1beta1::{NodeMetrics, PodMetrics};
use kube::api::{Api, ListParams};
use kube::Client;
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::async_runtime::JoinHandle;
use tauri::ipc::{Channel, InvokeResponseBody};
use tokio::time::Instant;
use tracing::{debug, warn};

use crate::auth::center::{self, AuthErrorKind, AuthFailure, AuthIssue, IssueSource};
use crate::kubernetes::client::{auth_error_message, client_with_context, exec_command_for_context, resolve_kubeconfig_path};
use crate::util::lock;
use crate::watch::{channel_sink, next_subscription_id, paused_receiver, WatchSink as Sink};

const POLL_INTERVAL: Duration = Duration::from_secs(15);
const UNAVAILABLE_INTERVAL: Duration = Duration::from_secs(60);
const WARM_PERIOD: Duration = Duration::from_secs(60);
pub const HISTORY_LEN: usize = 60;

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct PollerKey {
    kube_config: String,
    context: String,
    /// Sorted namespaces; empty = all namespaces.
    namespaces: Vec<String>,
}

/// (timestamp ms, cpu millicores, memory bytes)
pub type Point = (i64, f64, i64);

#[derive(Default)]
pub struct Rings {
    series: HashMap<String, VecDeque<Point>>,
}

impl Rings {
    /// Appends one sample per key and drops keys that disappeared (deleted
    /// pods / nodes), so the buffers don't grow without bound.
    pub fn record(&mut self, points: impl IntoIterator<Item = (String, Point)>) {
        let mut seen = std::collections::HashSet::new();
        for (key, point) in points {
            let ring = self.series.entry(key.clone()).or_default();
            if ring.back().is_some_and(|last| last.0 == point.0) {
                // Same metrics-server scrape as last time: nothing new.
                seen.insert(key);
                continue;
            }
            if ring.len() == HISTORY_LEN {
                ring.pop_front();
            }
            ring.push_back(point);
            seen.insert(key);
        }
        self.series.retain(|key, _| seen.contains(key));
    }

    pub fn get(&self, key: &str) -> Option<&VecDeque<Point>> {
        self.series.get(key)
    }

    fn to_json(&self) -> Value {
        Value::Object(
            self.series
                .iter()
                .map(|(key, ring)| {
                    let points = ring.iter().map(|(t, c, m)| serde_json::json!([t, c, m])).collect();
                    (key.clone(), Value::Array(points))
                })
                .collect(),
        )
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
enum MetricsState {
    Syncing,
    Ready,
    Unavailable,
    Forbidden,
    Unauthorized,
    Error,
}

/// A metrics request that failed for credential reasons: kind and a safe
/// message (kube-rs' own exec errors are never formatted with `Display`,
/// which includes the plugin's stdout).
fn auth_problem(err: &kube::Error) -> Option<(AuthErrorKind, String)> {
    if let Some(failure) = AuthFailure::of_kube_error(err) {
        return Some((failure.info.kind, failure.message.clone()));
    }
    match err {
        kube::Error::Api(status) if status.code == 401 => Some((
            AuthErrorKind::Unauthorized,
            "The API server rejected the credentials (401 Unauthorized)".to_string(),
        )),
        kube::Error::Auth(auth) => {
            let message = auth_error_message(auth);
            let kind = center::detect_kubectl_auth_failure(&message)
                .filter(|kind| *kind != AuthErrorKind::Unauthorized)
                .unwrap_or(AuthErrorKind::ExecFailed);
            Some((kind, message))
        }
        _ => None,
    }
}

struct PollerState {
    status: (MetricsState, Option<String>),
    last_sample: Option<String>,
    pods: Rings,
    nodes: Rings,
    sinks: HashMap<u64, Sink>,
    idle_generation: u64,
    idle: bool,
}

struct Poller {
    state: Mutex<PollerState>,
    task: Mutex<Option<JoinHandle<()>>>,
}

static POLLERS: Lazy<Mutex<HashMap<PollerKey, Arc<Poller>>>> = Lazy::new(|| Mutex::new(HashMap::new()));
static SUBSCRIPTIONS: Lazy<Mutex<HashMap<u64, PollerKey>>> = Lazy::new(|| Mutex::new(HashMap::new()));
/// Bumped by `metrics_reset` (webview reload): a subscribe that started
/// before it registers nothing (its channel belongs to the old page).
static EPOCH: AtomicU64 = AtomicU64::new(0);

fn status_message(state: MetricsState, message: &Option<String>) -> String {
    serde_json::json!({ "type": "status", "state": state, "message": message }).to_string()
}

fn broadcast(state: &PollerState, message: &str) {
    for sink in state.sinks.values() {
        sink(message.to_string());
    }
}

impl Poller {
    fn set_status(&self, status: MetricsState, message: Option<String>) {
        let mut state = lock(&self.state);
        if state.status.0 != status || state.status.1 != message {
            broadcast(&state, &status_message(status, &message));
            state.status = (status, message);
        }
    }
}

/// Tags a metrics object like a row (context / kubeConfig, apiVersion /
/// kind) so the frontend can join it with pods by context/namespace/name.
fn tag(mut value: Value, kind: &str, key: &PollerKey) -> Value {
    if let Some(obj) = value.as_object_mut() {
        obj.insert("apiVersion".into(), "metrics.k8s.io/v1beta1".into());
        obj.insert("kind".into(), kind.into());
        if let Some(meta) = obj.get_mut("metadata").and_then(Value::as_object_mut) {
            meta.remove("managedFields");
            meta.insert("context".into(), key.context.clone().into());
            meta.insert("kubeConfig".into(), key.kube_config.clone().into());
        }
    }
    value
}

fn point_of(timestamp: &k8s_openapi::apimachinery::pkg::apis::meta::v1::Time, cpu_cores: f64, memory: i64) -> Point {
    (timestamp.0.as_millisecond(), cpu_cores * 1000.0, memory)
}

fn pod_key(meta: &k8s_openapi::apimachinery::pkg::apis::meta::v1::ObjectMeta) -> String {
    format!(
        "{}/{}",
        meta.namespace.as_deref().unwrap_or_default(),
        meta.name.as_deref().unwrap_or_default()
    )
}

async fn list_pod_metrics(client: &Client, namespaces: &[String]) -> Result<Vec<PodMetrics>, kube::Error> {
    if namespaces.is_empty() {
        let api: Api<PodMetrics> = Api::all(client.clone());
        return Ok(api.list(&ListParams::default()).await?.items);
    }
    let lists = futures::future::try_join_all(namespaces.iter().map(|ns| {
        let api: Api<PodMetrics> = Api::namespaced(client.clone(), ns);
        async move { api.list(&ListParams::default()).await.map(|l| l.items) }
    }))
    .await?;
    Ok(lists.into_iter().flatten().collect())
}

/// One poll. Returns the interval until the next one.
async fn poll_once(poller: &Poller, client: &Client, key: &PollerKey) -> Duration {
    let started = std::time::Instant::now();
    let (pods, nodes) = tokio::join!(
        list_pod_metrics(client, &key.namespaces),
        async {
            let api: Api<NodeMetrics> = Api::all(client.clone());
            api.list(&ListParams::default()).await.map(|l| l.items)
        }
    );

    let pods = match pods {
        Ok(pods) => pods,
        Err(err) => {
            if let Some((kind, message)) = auth_problem(&err) {
                debug!("Pod metrics for {} unauthorized: {:?}", key.context, kind);
                center::report(AuthIssue {
                    kube_config: key.kube_config.clone(),
                    context: key.context.clone(),
                    kind,
                    source: IssueSource::Metrics,
                    message: message.clone(),
                    command: exec_command_for_context(Some(&key.kube_config), &key.context),
                });
                poller.set_status(MetricsState::Unauthorized, Some(center::redact(&message)));
                return UNAVAILABLE_INTERVAL;
            }
            let (state, interval) = match &err {
                kube::Error::Api(status) if status.code == 404 || status.code == 503 => {
                    (MetricsState::Unavailable, UNAVAILABLE_INTERVAL)
                }
                kube::Error::Api(status) if status.code == 403 => (MetricsState::Forbidden, UNAVAILABLE_INTERVAL),
                _ => (MetricsState::Error, POLL_INTERVAL),
            };
            debug!("Pod metrics for {} unavailable: {}", key.context, err);
            // A missing metrics API comes back as an unparsable 404 body
            // ("404 page not found"); say what it means instead.
            let message = match state {
                MetricsState::Unavailable => {
                    "The metrics API (metrics.k8s.io) is not available; is metrics-server installed?".to_string()
                }
                MetricsState::Forbidden => match &err {
                    kube::Error::Api(status) => status.message.clone(),
                    _ => err.to_string(),
                },
                _ => err.to_string(),
            };
            poller.set_status(state, Some(message));
            return interval;
        }
    };
    // Node metrics need cluster-wide access; namespace-restricted users
    // still get pod metrics.
    let nodes = nodes.unwrap_or_default();

    let now = chrono::Utc::now().timestamp_millis();
    let pod_points: Vec<(String, Point)> = pods
        .iter()
        .map(|pm| {
            (
                pod_key(&pm.metadata),
                point_of(&pm.timestamp, pm.cpu().unwrap_or(0.0), pm.memory().unwrap_or(0)),
            )
        })
        .collect();
    let node_points: Vec<(String, Point)> = nodes
        .iter()
        .map(|nm| {
            (
                nm.metadata.name.clone().unwrap_or_default(),
                point_of(
                    &nm.timestamp,
                    k8s_metrics::QuantityExt::to_f64(&nm.usage.cpu).unwrap_or(0.0),
                    k8s_metrics::QuantityExt::to_memory(&nm.usage.memory).unwrap_or(0),
                ),
            )
        })
        .collect();

    let pods_json: Vec<Value> = pods
        .into_iter()
        .filter_map(|pm| serde_json::to_value(pm).ok())
        .map(|v| tag(v, "PodMetrics", key))
        .collect();
    let nodes_json: Vec<Value> = nodes
        .into_iter()
        .filter_map(|nm| serde_json::to_value(nm).ok())
        .map(|v| tag(v, "NodeMetrics", key))
        .collect();
    let message = serde_json::json!({
        "type": "sample",
        "timestamp": now,
        "pods": pods_json,
        "nodes": nodes_json,
    })
    .to_string();

    {
        let mut state = lock(&poller.state);
        state.pods.record(pod_points);
        state.nodes.record(node_points);
        broadcast(&state, &message);
        state.last_sample = Some(message);
    }
    poller.set_status(MetricsState::Ready, None);
    debug!("Polled metrics for {} in {:?}", key.context, started.elapsed());
    POLL_INTERVAL
}

async fn run_poller(poller: Arc<Poller>, client: Client, key: PollerKey) {
    let mut paused = paused_receiver();
    let mut next_due = Instant::now();
    loop {
        let is_paused = *paused.borrow();
        tokio::select! {
            _ = tokio::time::sleep_until(next_due), if !is_paused => {
                let interval = poll_once(&poller, &client, &key).await;
                next_due = Instant::now() + interval;
            }
            changed = paused.changed() => {
                if changed.is_err() {
                    break;
                }
            }
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MetricsRequest {
    #[serde(default)]
    kube_config: Option<String>,
    context: String,
    #[serde(default)]
    namespaces: Vec<String>,
}

fn key_for(request: &MetricsRequest) -> PollerKey {
    let mut namespaces: Vec<String> = request.namespaces.clone();
    if namespaces.iter().any(|ns| ns == "all" || ns.is_empty()) {
        namespaces.clear();
    }
    namespaces.sort();
    namespaces.dedup();
    PollerKey {
        kube_config: resolve_kubeconfig_path(request.kube_config.as_deref()),
        context: request.context.clone(),
        namespaces,
    }
}

#[tauri::command]
pub async fn metrics_subscribe(
    request: MetricsRequest,
    on_event: Channel<InvokeResponseBody>,
) -> Result<u64, String> {
    subscribe(request, channel_sink(on_event)).await
}

pub(crate) async fn subscribe(request: MetricsRequest, sink: Sink) -> Result<u64, String> {
    let epoch = EPOCH.load(Ordering::SeqCst);
    let key = key_for(&request);
    let client = center::with_source(IssueSource::Metrics, client_with_context(&key.context, Some(&key.kube_config)))
        .await
        .map_err(|e| e.message)?;
    let id = next_subscription_id();
    attach(&key, id, sink, epoch, |poller| Some(spawn_poller(poller, client, key.clone())))?;
    Ok(id)
}

fn spawn_poller(poller: Arc<Poller>, client: Client, key: PollerKey) -> JoinHandle<()> {
    tauri::async_runtime::spawn(center::with_source(IssueSource::Metrics, run_poller(poller, client, key)))
}

/// Restarts the pollers of the (kubeconfig, context) pairs that failed
/// (unauthorized or erroring) with a fresh client, polling right away
/// (after a sign-in). Returns how many were restarted.
pub(crate) async fn retry_contexts(contexts: &[(String, String)]) -> usize {
    let failed: Vec<(PollerKey, Arc<Poller>)> = lock(&POLLERS)
        .iter()
        .filter(|(key, poller)| {
            contexts
                .iter()
                .any(|(kube_config, context)| &key.kube_config == kube_config && &key.context == context)
                && matches!(lock(&poller.state).status.0, MetricsState::Unauthorized | MetricsState::Error)
        })
        .map(|(key, poller)| (key.clone(), poller.clone()))
        .collect();

    let mut restarted = 0;
    for (key, poller) in failed {
        let client = match center::with_source(IssueSource::Metrics, client_with_context(&key.context, Some(&key.kube_config))).await {
            Ok(client) => client,
            Err(err) => {
                warn!("Not restarting metrics of {}: {}", key.context, err.message);
                continue;
            }
        };
        // Still the registered poller (not evicted meanwhile)?
        let pollers = lock(&POLLERS);
        if !pollers.get(&key).is_some_and(|p| Arc::ptr_eq(p, &poller)) {
            continue;
        }
        let mut task = lock(&poller.task);
        if let Some(old) = task.take() {
            old.abort();
        }
        *task = Some(spawn_poller(poller.clone(), client, key.clone()));
        restarted += 1;
    }
    restarted
}

fn new_poller() -> Arc<Poller> {
    Arc::new(Poller {
        state: Mutex::new(PollerState {
            status: (MetricsState::Syncing, None),
            last_sample: None,
            pods: Rings::default(),
            nodes: Rings::default(),
            sinks: HashMap::new(),
            idle_generation: 0,
            idle: true,
        }),
        task: Mutex::new(None),
    })
}

/// Adds subscriber `id` to the poller of `key`, creating it (and starting
/// its task with `start`) when there is none. Lookup and registration
/// happen under the `POLLERS` lock, which eviction holds while it checks
/// idleness: a poller is never attached to just after it was evicted (it
/// would never deliver).
fn attach(
    key: &PollerKey,
    id: u64,
    sink: Sink,
    epoch: u64,
    start: impl FnOnce(Arc<Poller>) -> Option<JoinHandle<()>>,
) -> Result<Arc<Poller>, String> {
    let mut pollers = lock(&POLLERS);
    // The webview was reloaded while this subscribe was resolving.
    if EPOCH.load(Ordering::SeqCst) != epoch {
        return Err("The subscription was reset".to_string());
    }
    let poller = match pollers.get(key) {
        Some(poller) => poller.clone(),
        None => {
            let poller = new_poller();
            *lock(&poller.task) = start(poller.clone());
            pollers.insert(key.clone(), poller.clone());
            poller
        }
    };
    {
        let mut state = lock(&poller.state);
        sink(status_message(state.status.0, &state.status.1));
        if let Some(sample) = &state.last_sample {
            sink(sample.clone());
            sink(
                serde_json::json!({
                    "type": "history",
                    "pods": state.pods.to_json(),
                    "nodes": state.nodes.to_json(),
                })
                .to_string(),
            );
        }
        state.sinks.insert(id, sink);
        state.idle = false;
    }
    lock(&SUBSCRIPTIONS).insert(id, key.clone());
    Ok(poller)
}

/// Removes subscriber `id`. Returns the key and idle generation of its
/// poller when that has no subscribers left.
fn detach(id: u64) -> Option<(PollerKey, u64)> {
    let key = lock(&SUBSCRIPTIONS).remove(&id)?;
    let pollers = lock(&POLLERS);
    let poller = pollers.get(&key)?;
    let mut state = lock(&poller.state);
    state.sinks.remove(&id);
    if !state.sinks.is_empty() {
        return None;
    }
    state.idle = true;
    state.idle_generation += 1;
    let generation = state.idle_generation;
    drop(state);
    Some((key, generation))
}

/// Evicts the poller of `key` when it has been idle since `generation`.
fn evict_if_idle(key: &PollerKey, generation: u64) -> bool {
    let mut pollers = lock(&POLLERS);
    let evict = pollers.get(key).is_some_and(|p| {
        let state = lock(&p.state);
        state.idle && state.idle_generation == generation
    });
    if !evict {
        return false;
    }
    if let Some(poller) = pollers.remove(key) {
        if let Some(task) = lock(&poller.task).take() {
            task.abort();
        }
        debug!("Evicted idle metrics poller for {}", key.context);
    }
    true
}

#[tauri::command]
pub fn metrics_unsubscribe(id: u64) {
    let Some((key, generation)) = detach(id) else {
        return;
    };
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(WARM_PERIOD).await;
        evict_if_idle(&key, generation);
    });
}

/// Drops all metrics subscriptions (webview reload). Subscribes still
/// resolving (started before the reset) are rejected.
#[tauri::command]
pub fn metrics_reset() {
    let ids: Vec<u64> = {
        let _pollers = lock(&POLLERS);
        EPOCH.fetch_add(1, Ordering::SeqCst);
        lock(&SUBSCRIPTIONS).keys().copied().collect()
    };
    if !ids.is_empty() {
        warn!("Dropping {} stale metrics subscriptions", ids.len());
    }
    for id in ids {
        metrics_unsubscribe(id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rings_keep_the_last_samples_and_drop_vanished_keys() {
        let mut rings = Rings::default();
        for t in 0..(HISTORY_LEN as i64 + 10) {
            rings.record([("ns/a".to_string(), (t, 1.0, 2)), ("ns/b".to_string(), (t, 1.0, 2))]);
        }
        let a = rings.get("ns/a").unwrap();
        assert_eq!(a.len(), HISTORY_LEN);
        assert_eq!(a.front().unwrap().0, 10);
        assert_eq!(a.back().unwrap().0, HISTORY_LEN as i64 + 9);

        rings.record([("ns/a".to_string(), (1000, 1.0, 2))]);
        assert!(rings.get("ns/b").is_none());
    }

    #[test]
    fn repeated_scrapes_are_not_recorded_twice() {
        let mut rings = Rings::default();
        rings.record([("ns/a".to_string(), (5, 1.0, 2))]);
        rings.record([("ns/a".to_string(), (5, 1.0, 2))]);
        assert_eq!(rings.get("ns/a").unwrap().len(), 1);
    }

    #[test]
    fn metrics_are_tagged_like_rows() {
        let key = PollerKey {
            kube_config: "/kc".into(),
            context: "ctx".into(),
            namespaces: vec![],
        };
        let value = tag(
            serde_json::json!({"metadata": {"name": "p", "namespace": "n", "managedFields": []}, "containers": []}),
            "PodMetrics",
            &key,
        );
        assert_eq!(value["metadata"]["context"], "ctx");
        assert_eq!(value["metadata"]["kubeConfig"], "/kc");
        assert_eq!(value["kind"], "PodMetrics");
        assert!(value["metadata"].get("managedFields").is_none());
    }

    fn test_key(context: &str) -> PollerKey {
        PollerKey {
            kube_config: "/kc".into(),
            context: context.into(),
            namespaces: vec![],
        }
    }

    #[test]
    fn attaching_and_evicting_are_atomic() {
        let key = test_key("metrics-attach-test");
        let epoch = EPOCH.load(Ordering::SeqCst);
        let sink: Sink = Arc::new(|_| true);

        let first = attach(&key, 9_001, sink.clone(), epoch, |_| None).unwrap();
        let (_, stale) = detach(9_001).unwrap();
        // Re-used before the warm period's eviction timer fired: the stale
        // timer must not evict the poller the new subscriber is on.
        let again = attach(&key, 9_002, sink.clone(), epoch, |_| None).unwrap();
        assert!(Arc::ptr_eq(&first, &again));
        assert!(!evict_if_idle(&key, stale));
        assert!(lock(&POLLERS).get(&key).is_some_and(|p| Arc::ptr_eq(p, &again)));

        // Evicted: the next subscriber gets a new poller, not the dead one.
        let (_, generation) = detach(9_002).unwrap();
        assert!(evict_if_idle(&key, generation));
        let fresh = attach(&key, 9_003, sink, epoch, |_| None).unwrap();
        assert!(!Arc::ptr_eq(&first, &fresh));
        assert!(lock(&POLLERS).get(&key).is_some_and(|p| Arc::ptr_eq(p, &fresh)));
        assert_eq!(lock(&fresh.state).sinks.len(), 1);
        detach(9_003);
    }

    #[test]
    fn subscribes_that_straddle_a_reset_register_nothing() {
        let key = test_key("metrics-epoch-test");
        // An epoch before the latest reset.
        let stale_epoch = EPOCH.load(Ordering::SeqCst).wrapping_sub(1);
        assert!(attach(&key, 9_100, Arc::new(|_| true), stale_epoch, |_| None).is_err());
        assert!(!lock(&POLLERS).contains_key(&key));
        assert!(!lock(&SUBSCRIPTIONS).contains_key(&9_100));
    }

    #[tokio::test]
    async fn unauthorized_pollers_are_retried_with_a_new_client() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("kubeconfig.yaml");
        std::fs::write(
            &path,
            "apiVersion: v1\nkind: Config\nclusters:\n- name: c\n  cluster:\n    server: http://127.0.0.1:9\ncontexts:\n- name: metrics-retry\n  context:\n    cluster: c\n    user: u\nusers:\n- name: u\n  user:\n    token: t\n",
        )
        .unwrap();
        let kube_config = path.to_string_lossy().into_owned();
        let key = PollerKey {
            kube_config: kube_config.clone(),
            context: "metrics-retry".into(),
            namespaces: vec![],
        };
        let epoch = EPOCH.load(Ordering::SeqCst);
        let poller = attach(&key, 9_200, Arc::new(|_| true), epoch, |_| None).unwrap();
        assert_eq!(retry_contexts(&[(kube_config.clone(), "metrics-retry".into())]).await, 0, "healthy pollers stay");

        poller.set_status(MetricsState::Unauthorized, Some("401".into()));
        assert_eq!(retry_contexts(&[(kube_config, "metrics-retry".into())]).await, 1);
        assert!(lock(&poller.task).is_some());

        let (_, generation) = detach(9_200).unwrap();
        assert!(evict_if_idle(&key, generation));
    }

    #[test]
    fn auth_problems_are_recognised() {
        let status = |code| kube::Error::Api(kube::core::Status::failure("m", "r").with_code(code).boxed());
        assert_eq!(auth_problem(&status(401)).map(|(k, _)| k), Some(AuthErrorKind::Unauthorized));
        assert!(auth_problem(&status(403)).is_none());
        assert!(auth_problem(&status(404)).is_none());
        assert_eq!(
            serde_json::to_value(MetricsState::Unauthorized).unwrap(),
            serde_json::json!("unauthorized")
        );
    }

    #[test]
    fn all_namespaces_share_one_poller_key() {
        let request = |namespaces: &[&str]| MetricsRequest {
            kube_config: None,
            context: "ctx".into(),
            namespaces: namespaces.iter().map(|s| s.to_string()).collect(),
        };
        assert_eq!(key_for(&request(&["all"])), key_for(&request(&[])));
        assert_eq!(key_for(&request(&["b", "a"])), key_for(&request(&["a", "b", "a"])));
    }
}

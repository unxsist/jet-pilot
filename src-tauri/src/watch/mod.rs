//! WatchHub: live, shared Kubernetes object lists for the list views.
//!
//! Instead of every view polling `kubectl get -o json` per context and
//! namespace, the frontend subscribes to a (kubeconfig, context, resource,
//! namespaces) key. The hub runs one kube-runtime watcher per (context,
//! group/version/resource, namespace scope), keeps the objects in memory and
//! streams them over a Tauri channel:
//!
//! - a `snapshot` of all objects when the store is synced (immediately for
//!   warm watchers),
//! - `delta` messages `{added, modified, deleted}` batched every ~150 ms,
//! - `status` messages (syncing / ready / relisting / error / forbidden /
//!   unauthorized / failed).
//!
//! Watchers are ref-counted by subscriptions and kept warm for 60 s after
//! the last subscriber leaves, so navigating back to a list is instant.
//! Resolution works for every kind (incl. CRDs) through discovery and
//! `DynamicObject`s. While the window is hidden, deltas are coalesced and
//! not delivered; they are flushed on resume.

mod batch;
#[cfg(test)]
mod bench;
pub(crate) mod discovery;
mod entry;
mod object;

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures::StreamExt;
use kube::api::{Api, DynamicObject};
use kube::runtime::{watcher, WatchStreamExt};
use kube::Client;
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use tauri::async_runtime::JoinHandle;
use tauri::ipc::{Channel, InvokeResponseBody};
use tokio::time::Instant;
use tracing::{debug, info, warn};

use crate::kubernetes::client::{
    auth_error_message, client_with_context, exec_command_for_context, resolve_kubeconfig_path,
};
use crate::util::lock;
use entry::{Entry, Sink, State, Status};
use object::Tag;

pub use entry::Sink as WatchSink;

/// Deltas are coalesced for this long before being sent.
const BATCH_INTERVAL: Duration = Duration::from_millis(150);
/// Watchers without subscribers stay alive (and up to date) this long.
const WARM_PERIOD: Duration = Duration::from_secs(60);
/// Upper bound of concurrently running watchers. Idle warm watchers are
/// evicted first; beyond that subscribing fails and the frontend falls back
/// to kubectl polling.
const MAX_WATCHERS: usize = 64;

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct WatcherKey {
    kube_config: String,
    context: String,
    group: String,
    version: String,
    plural: String,
    /// None = all namespaces (or a cluster scoped resource).
    namespace: Option<String>,
}

struct Watcher {
    entry: Arc<Entry>,
    task: Option<JoinHandle<()>>,
    /// The task ended in a terminal state (forbidden / unauthorized / ...).
    stopped: Arc<std::sync::atomic::AtomicBool>,
}

#[derive(Default)]
struct HubInner {
    watchers: HashMap<WatcherKey, Watcher>,
    subscriptions: HashMap<u64, Vec<WatcherKey>>,
}

struct Hub {
    inner: Mutex<HubInner>,
    paused: tokio::sync::watch::Sender<bool>,
    next_id: AtomicU64,
}

static HUB: Lazy<Hub> = Lazy::new(|| Hub {
    inner: Mutex::new(HubInner::default()),
    paused: tokio::sync::watch::channel(false).0,
    next_id: AtomicU64::new(1),
});

/// Whether delivery to the frontend is paused (window hidden). Shared with
/// the metrics service.
pub fn paused_receiver() -> tokio::sync::watch::Receiver<bool> {
    HUB.paused.subscribe()
}

pub fn next_subscription_id() -> u64 {
    HUB.next_id.fetch_add(1, Ordering::Relaxed)
}

/// Wraps a Tauri channel as a sink of raw JSON messages (serialized once in
/// Rust, no re-encoding in the IPC layer).
pub fn channel_sink(channel: Channel<InvokeResponseBody>) -> Sink {
    Arc::new(move |message: String| channel.send(InvokeResponseBody::Json(message)).is_ok())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchRequest {
    #[serde(default)]
    kube_config: Option<String>,
    context: String,
    /// Plural resource name as used by kubectl (`pods`, `deployments.apps`,
    /// CRD plurals, ...).
    resource: String,
    #[serde(default)]
    kind: Option<String>,
    /// Namespaces to watch; empty or containing "all" = all namespaces.
    #[serde(default)]
    namespaces: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchSubscription {
    pub(crate) id: u64,
    /// The scopes the subscription receives messages for ("" = all
    /// namespaces / cluster scoped). The list is complete once every scope
    /// reported `ready`.
    pub(crate) scopes: Vec<String>,
    pub(crate) namespaced: bool,
    pub(crate) api_version: String,
    pub(crate) kind: String,
}

/// The namespace scopes to watch for a request.
fn scopes_for(namespaced: bool, namespaces: &[String]) -> Vec<Option<String>> {
    if !namespaced || namespaces.is_empty() || namespaces.iter().any(|ns| ns == "all" || ns.is_empty()) {
        return vec![None];
    }
    let mut scopes: Vec<String> = namespaces.to_vec();
    scopes.sort();
    scopes.dedup();
    scopes.into_iter().map(Some).collect()
}

const BACKOFF_MIN: Duration = Duration::from_millis(500);
const BACKOFF_MAX: Duration = Duration::from_secs(5);

/// Reconnect backoff of the watchers: exponential from 500 ms to 5 s with
/// ±20 % jitter, reset by every successful event. kube-runtime's default
/// (client-go's 800 ms .. 30 s) is meant for controllers; for a UI it left
/// lists stale for ~15 s after a short outage (measured against a restarted
/// API server; VPN reconnects behave the same).
struct WatchBackoff {
    current: Duration,
}

impl WatchBackoff {
    fn new() -> Self {
        WatchBackoff { current: BACKOFF_MIN }
    }
}

impl Iterator for WatchBackoff {
    type Item = Duration;

    fn next(&mut self) -> Option<Duration> {
        use rand::Rng;
        let delay = self.current.mul_f64(rand::thread_rng().gen_range(0.8..1.2));
        self.current = (self.current * 2).min(BACKOFF_MAX);
        Some(delay)
    }
}

impl kube::runtime::utils::Backoff for WatchBackoff {
    fn reset(&mut self) {
        self.current = BACKOFF_MIN;
    }
}

/// Maps a watcher error to the status reported to the frontend.
fn classify(err: &watcher::Error, kube_config: &str, context: &str) -> Status {
    let kube_err = match err {
        watcher::Error::InitialListFailed(e) | watcher::Error::WatchStartFailed(e) | watcher::Error::WatchFailed(e) => e,
        watcher::Error::WatchError(status) => {
            return status_for_api(status.code, &status.reason, &status.message);
        }
        watcher::Error::NoResourceVersion => {
            return Status {
                state: State::Error,
                message: Some(err.to_string()),
                code: None,
                reason: None,
            };
        }
    };

    match kube_err {
        kube::Error::Api(status) => status_for_api(status.code, &status.reason, &status.message),
        kube::Error::Auth(auth) => {
            let message = auth_error_message(auth);
            // Word it like kubectl ("executable aws failed") so the frontend's
            // re-login detection (AWS SSO, kubelogin, ...) recognises it.
            let message = match exec_command_for_context(Some(kube_config), context) {
                Some(command) => format!("executable {command} failed: {message}"),
                None => message,
            };
            Status {
                state: State::Unauthorized,
                message: Some(message),
                code: None,
                reason: Some("ExecAuthFailed".into()),
            }
        }
        other => Status {
            state: State::Error,
            message: Some(other.to_string()),
            code: None,
            reason: None,
        },
    }
}

fn status_for_api(code: u16, reason: &str, message: &str) -> Status {
    let state = match code {
        401 => State::Unauthorized,
        403 => State::Forbidden,
        404 => State::Failed,
        410 => State::Relisting,
        _ => State::Error,
    };
    Status {
        state,
        message: Some(message.to_string()),
        code: Some(code),
        reason: Some(reason.to_string()).filter(|r| !r.is_empty()),
    }
}

/// Drives one entry from its kube-runtime watcher until a terminal error
/// (or until aborted on eviction).
async fn run_watcher(entry: Arc<Entry>, client: Client, namespace: Option<String>, kube_config: String, stopped: Arc<std::sync::atomic::AtomicBool>) {
    let api: Api<DynamicObject> = match &namespace {
        Some(ns) => Api::namespaced_with(client, ns, &entry.ar),
        None => Api::all_with(client, &entry.ar),
    };
    // any_semantic: the initial list may be served from the API server's
    // watch cache instead of etcd (much cheaper for large lists).
    let config = watcher::Config::default().any_semantic();
    let stream = watcher(api, config).backoff(WatchBackoff::new());
    futures::pin_mut!(stream);

    let mut paused = paused_receiver();
    let mut deadline: Option<Instant> = None;
    let started = std::time::Instant::now();
    let mut first_sync = true;

    loop {
        let is_paused = *paused.borrow();
        tokio::select! {
            event = stream.next() => match event {
                None => break,
                Some(Ok(event)) => {
                    if entry.apply(event) {
                        if first_sync {
                            first_sync = false;
                            info!(
                                "Watch {} {} [{}] synced {} objects in {:?}",
                                entry.tag.context, entry.ar.plural, entry.scope,
                                entry.object_count(), started.elapsed()
                            );
                        }
                        if !is_paused {
                            entry.flush();
                            deadline = None;
                        }
                    }
                    if deadline.is_none() && entry.has_pending() {
                        deadline = Some(Instant::now() + BATCH_INTERVAL);
                    }
                }
                Some(Err(err)) => {
                    let status = classify(&err, &kube_config, &entry.tag.context);
                    warn!(
                        "Watch {} {} [{}] error ({:?}): {}",
                        entry.tag.context, entry.ar.plural, entry.scope, status.state, err
                    );
                    let terminal = status.state.is_terminal();
                    entry.set_status(status);
                    if terminal {
                        stopped.store(true, Ordering::SeqCst);
                        break;
                    }
                }
            },
            _ = tokio::time::sleep_until(deadline.unwrap_or_else(Instant::now)), if deadline.is_some() && !is_paused => {
                entry.flush();
                deadline = None;
            }
            changed = paused.changed() => {
                if changed.is_err() {
                    break;
                }
                if !*paused.borrow() && entry.has_pending() {
                    entry.flush();
                    deadline = None;
                }
            }
        }
    }
}

impl Hub {
    /// Evicts idle watchers (oldest first) until there is room for `needed`
    /// more. Returns false when there isn't enough room.
    fn make_room(inner: &mut HubInner, needed: usize) -> bool {
        let excess = (inner.watchers.len() + needed).saturating_sub(MAX_WATCHERS);
        if excess == 0 {
            return true;
        }
        let mut idle: Vec<(WatcherKey, std::time::Instant)> = inner
            .watchers
            .iter()
            .filter_map(|(key, w)| w.entry.lock().idle_since.map(|since| (key.clone(), since)))
            .collect();
        if idle.len() < excess {
            return false;
        }
        idle.sort_by_key(|(_, since)| *since);
        for (key, _) in idle.into_iter().take(excess) {
            if let Some(watcher) = inner.watchers.remove(&key) {
                if let Some(task) = watcher.task {
                    task.abort();
                }
            }
        }
        true
    }

    fn start(watcher: &mut Watcher, key: &WatcherKey, client: Client) {
        if let Some(task) = watcher.task.take() {
            task.abort();
        }
        watcher.stopped.store(false, Ordering::SeqCst);
        watcher.entry.set_status(Status::new(State::Syncing));
        watcher.task = Some(tauri::async_runtime::spawn(run_watcher(
            watcher.entry.clone(),
            client,
            key.namespace.clone(),
            key.kube_config.clone(),
            watcher.stopped.clone(),
        )));
    }

    fn release(&self, id: u64) {
        let keys = lock(&self.inner).subscriptions.remove(&id).unwrap_or_default();
        for key in keys {
            let generation = {
                let inner = lock(&self.inner);
                let Some(watcher) = inner.watchers.get(&key) else { continue };
                if watcher.entry.remove_sink(id) > 0 {
                    continue;
                }
                let generation = watcher.entry.lock().idle_generation;
                generation
            };
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(WARM_PERIOD).await;
                HUB.evict_if_idle(&key, generation);
            });
        }
    }

    fn evict_if_idle(&self, key: &WatcherKey, generation: u64) {
        let mut inner = lock(&self.inner);
        let idle = inner.watchers.get(key).is_some_and(|w| {
            let state = w.entry.lock();
            state.idle_since.is_some() && state.idle_generation == generation
        });
        if idle {
            if let Some(watcher) = inner.watchers.remove(key) {
                debug!("Evicting idle watch {:?}", key);
                if let Some(task) = watcher.task {
                    task.abort();
                }
            }
        }
    }
}

/// Subscribes to a live list. Messages arrive on `on_event` (see module
/// docs); the returned id is passed to `watch_unsubscribe`.
#[tauri::command]
pub async fn watch_subscribe(
    request: WatchRequest,
    on_event: Channel<InvokeResponseBody>,
) -> Result<WatchSubscription, String> {
    subscribe(request, channel_sink(on_event)).await
}

pub(crate) async fn subscribe(request: WatchRequest, sink: Sink) -> Result<WatchSubscription, String> {
    // "" / None = the selected kubeconfig: resolved, so the same cluster
    // never runs two sets of watchers and rows carry the real path.
    let kube_config = resolve_kubeconfig_path(request.kube_config.as_deref());
    let client = client_with_context(&request.context, Some(&kube_config))
        .await
        .map_err(|e| e.message)?;
    let resolved = discovery::resolve(
        &client,
        (kube_config.clone(), request.context.clone()),
        &request.resource,
        request.kind.as_deref(),
    )
    .await?;
    if !resolved.watchable {
        return Err(format!("{} can't be watched", resolved.ar.plural));
    }

    let scopes = scopes_for(resolved.namespaced, &request.namespaces);
    let tag = Tag {
        context: request.context.clone(),
        kube_config: kube_config.clone(),
    };
    let id = next_subscription_id();
    let keys: Vec<WatcherKey> = scopes
        .iter()
        .map(|namespace| WatcherKey {
            kube_config: kube_config.clone(),
            context: request.context.clone(),
            group: resolved.ar.group.clone(),
            version: resolved.ar.version.clone(),
            plural: resolved.ar.plural.clone(),
            namespace: namespace.clone(),
        })
        .collect();

    {
        let mut inner = lock(&HUB.inner);
        let missing = keys.iter().filter(|k| !inner.watchers.contains_key(*k)).count();
        if !Hub::make_room(&mut inner, missing) {
            return Err(format!(
                "Too many concurrent watches (limit {MAX_WATCHERS}); falling back to polling"
            ));
        }

        for key in &keys {
            let watcher = inner.watchers.entry(key.clone()).or_insert_with(|| Watcher {
                entry: Arc::new(Entry::new(
                    resolved.ar.clone(),
                    tag.clone(),
                    key.namespace.clone().unwrap_or_default(),
                )),
                task: None,
                stopped: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            });

            // New, or stopped by a terminal error (e.g. forbidden or expired
            // credentials before a re-login): (re)start.
            let needs_start = watcher.task.is_none() || watcher.stopped.load(Ordering::SeqCst);
            if needs_start {
                Hub::start(watcher, key, client.clone());
            }
            watcher.entry.add_sink(id, sink.clone());
        }
        inner.subscriptions.insert(id, keys);
    }

    debug!(
        "watch_subscribe #{} {} {} {:?}",
        id, request.context, resolved.ar.plural, scopes
    );
    Ok(WatchSubscription {
        id,
        scopes: scopes.into_iter().map(Option::unwrap_or_default).collect(),
        namespaced: resolved.namespaced,
        api_version: resolved.ar.api_version.clone(),
        kind: resolved.ar.kind.clone(),
    })
}

#[tauri::command]
pub fn watch_unsubscribe(id: u64) {
    HUB.release(id);
}

/// Restarts the watchers of a subscription (the "Retry" button): a
/// watcher waiting in backoff reconnects right away.
#[tauri::command]
pub async fn watch_restart(id: u64) -> Result<(), String> {
    let keys = lock(&HUB.inner).subscriptions.get(&id).cloned().unwrap_or_default();
    for key in keys {
        let client = client_with_context(&key.context, Some(&key.kube_config))
            .await
            .map_err(|e| e.message)?;
        let mut inner = lock(&HUB.inner);
        if let Some(watcher) = inner.watchers.get_mut(&key) {
            if watcher.entry.status().state != State::Ready {
                Hub::start(watcher, &key, client);
            }
        }
    }
    Ok(())
}

/// Drops every subscription (e.g. after a webview reload, whose channels
/// are gone). Watchers stay warm for their usual period.
#[tauri::command]
pub fn watch_reset() {
    let ids: Vec<u64> = lock(&HUB.inner).subscriptions.keys().copied().collect();
    for id in ids {
        HUB.release(id);
    }
}

/// Pauses (window hidden) or resumes delivery of deltas to the frontend.
/// Watchers keep their stores current while paused; pending changes are
/// coalesced and flushed on resume.
#[tauri::command]
pub fn watch_set_paused(paused: bool) {
    HUB.paused.send_replace(paused);
}

/// The full cached object (as JSON) for `uid`, from any running watcher.
#[tauri::command]
pub fn watch_get(uid: String) -> Result<tauri::ipc::Response, String> {
    let inner = lock(&HUB.inner);
    inner
        .watchers
        .values()
        .find_map(|w| w.entry.get(&uid))
        .map(|obj| tauri::ipc::Response::new(InvokeResponseBody::Json(obj.json.to_string())))
        .ok_or_else(|| format!("Object {uid} is not cached"))
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchStats {
    watchers: usize,
    subscriptions: usize,
    objects: usize,
    idle: usize,
    paused: bool,
}

/// Counters for diagnostics / benchmarks.
#[tauri::command]
pub fn watch_stats() -> WatchStats {
    let inner = lock(&HUB.inner);
    WatchStats {
        watchers: inner.watchers.len(),
        subscriptions: inner.subscriptions.len(),
        objects: inner.watchers.values().map(|w| w.entry.object_count()).sum(),
        idle: inner.watchers.values().filter(|w| w.entry.sink_count() == 0).count(),
        paused: *HUB.paused.borrow(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn all_namespaces_and_cluster_scope_use_one_watcher() {
        assert_eq!(scopes_for(true, &[]), vec![None]);
        assert_eq!(scopes_for(true, &["all".into()]), vec![None]);
        assert_eq!(scopes_for(true, &["a".into(), "all".into()]), vec![None]);
        assert_eq!(scopes_for(false, &["a".into(), "b".into()]), vec![None]);
    }

    #[test]
    fn backoff_grows_to_five_seconds_and_resets() {
        use kube::runtime::utils::Backoff;
        let mut backoff = WatchBackoff::new();
        let delays: Vec<Duration> = (&mut backoff).take(6).collect();
        assert!(delays[0] >= Duration::from_millis(400) && delays[0] <= Duration::from_millis(600));
        assert!(delays[5] >= Duration::from_secs(4) && delays[5] <= Duration::from_secs(6));
        backoff.reset();
        assert!(backoff.next().unwrap() <= Duration::from_millis(600));
    }

    #[test]
    fn namespaces_get_one_watcher_each_deduplicated() {
        assert_eq!(
            scopes_for(true, &["b".into(), "a".into(), "b".into()]),
            vec![Some("a".to_string()), Some("b".to_string())]
        );
    }

    #[test]
    fn api_errors_map_to_states() {
        assert_eq!(status_for_api(403, "Forbidden", "nope").state, State::Forbidden);
        assert_eq!(status_for_api(401, "Unauthorized", "").state, State::Unauthorized);
        assert_eq!(status_for_api(410, "Expired", "").state, State::Relisting);
        assert_eq!(status_for_api(500, "", "boom").state, State::Error);
        assert_eq!(status_for_api(500, "", "boom").reason, None);
        assert!(State::Forbidden.is_terminal());
        assert!(!State::Relisting.is_terminal());
        assert!(!State::Error.is_terminal());
    }

    fn key(ns: &str) -> WatcherKey {
        WatcherKey {
            kube_config: "kc".into(),
            context: "ctx".into(),
            group: "".into(),
            version: "v1".into(),
            plural: "pods".into(),
            namespace: Some(ns.into()),
        }
    }

    fn idle_watcher(idle: bool) -> Watcher {
        let entry = Arc::new(Entry::new(
            object::tests::pod_resource(),
            object::tests::tag(),
            "ns".into(),
        ));
        if !idle {
            entry.add_sink(1, Arc::new(|_| true));
        }
        Watcher {
            entry,
            task: None,
            stopped: Arc::new(std::sync::atomic::AtomicBool::new(false)),
        }
    }

    #[test]
    fn make_room_evicts_only_idle_watchers() {
        let mut inner = HubInner::default();
        for i in 0..MAX_WATCHERS {
            inner.watchers.insert(key(&format!("busy{i}")), idle_watcher(false));
        }
        assert!(!Hub::make_room(&mut inner, 1));

        inner.watchers.remove(&key("busy0"));
        inner.watchers.insert(key("idle"), idle_watcher(true));
        assert!(Hub::make_room(&mut inner, 1));
        assert!(!inner.watchers.contains_key(&key("idle")));
        assert_eq!(inner.watchers.len(), MAX_WATCHERS - 1);
    }

    #[test]
    fn eviction_respects_reuse_during_the_warm_period() {
        let key = WatcherKey {
            context: "eviction-test".into(),
            ..key("ns")
        };
        let watcher = idle_watcher(false);
        let entry = watcher.entry.clone();
        lock(&HUB.inner).watchers.insert(key.clone(), watcher);

        entry.remove_sink(1);
        let stale_generation = entry.lock().idle_generation;
        // Re-used and released again before the first timer fired.
        entry.add_sink(2, Arc::new(|_| true));
        entry.remove_sink(2);

        HUB.evict_if_idle(&key, stale_generation);
        assert!(lock(&HUB.inner).watchers.contains_key(&key), "stale timer must not evict");

        let generation = entry.lock().idle_generation;
        entry.add_sink(3, Arc::new(|_| true));
        HUB.evict_if_idle(&key, generation);
        assert!(lock(&HUB.inner).watchers.contains_key(&key), "in-use watcher must not be evicted");

        entry.remove_sink(3);
        let generation = entry.lock().idle_generation;
        HUB.evict_if_idle(&key, generation);
        assert!(!lock(&HUB.inner).watchers.contains_key(&key));
    }
}

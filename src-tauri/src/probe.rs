//! Cluster status for the clusters hub: is a context reachable, which
//! Kubernetes version does it run, how many nodes does it have.
//!
//! - `cluster_status_cached` returns the last known status of contexts
//!   instantly. Statuses are kept in memory and persisted (debounced,
//!   atomically) to `<app cache dir>/cluster-status.json`, newest per
//!   (kubeconfig, context), at most 1000.
//! - `cluster_probe` checks contexts in the background and streams a
//!   `result` per context, then `done`. A check is `GET /version` (plus an
//!   optional node count) through the regular cached client.
//!
//! Probing never starts an interactive login: contexts whose auth is not
//! statically known to be non-interactive (see `auth::classify`) are
//! reported as `skipped` without building a client, because kube-rs runs the
//! exec credential plugin while creating it. Only an explicit request
//! (`include_interactive`) checks them anyway.
//!
//! At most 8 checks run at once across batches, and a context is never
//! checked twice concurrently: a second request waits for the running check
//! and reuses its result.

use std::collections::HashMap;
use std::error::Error as StdError;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use futures::future::{BoxFuture, Shared};
use futures::{FutureExt, StreamExt};
use k8s_openapi::api::core::v1::Node;
use kube::api::{Api, ListParams};
use kube::config::{AuthInfo, Kubeconfig};
use kube::Client;
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tauri::Manager;
use tokio::sync::{watch, Semaphore};
use tracing::{debug, info, warn};

use crate::auth::classify::{classify_auth, command_basename, InteractiveClass};
use crate::kubeconfig_discovery::read_error_message;
use crate::kubernetes::client::{
    auth_error_message, client_with_context, read_kubeconfig, resolve_kubeconfig_path,
    SerializableKubeError,
};
use crate::util::lock;

/// Checks running at once, across batches.
const MAX_CONCURRENT_PROBES: usize = 8;
/// Building a client (incl. running an exec credential plugin).
const CLIENT_TIMEOUT: Duration = Duration::from_secs(10);
/// `GET /version` and the node count, each.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(5);
/// Cached statuses kept (and persisted).
const MAX_CACHED: usize = 1000;
/// Cache writes are coalesced for this long.
const SAVE_DEBOUNCE: Duration = Duration::from_secs(2);
const CACHE_FILE: &str = "cluster-status.json";
const CACHE_VERSION: u32 = 1;
/// User-facing messages are one line of at most this many characters.
const MAX_MESSAGE_CHARS: usize = 160;

const SKIPPED_INTERACTIVE: &str = "Sign-in needed to check this cluster";
const SKIPPED_UNKNOWN: &str = "Not checked automatically: unknown sign-in method";

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextRef {
    /// The kubeconfig file the context lives in; "" = the selected one (else
    /// kube's default resolution).
    #[serde(default)]
    pub kube_config: String,
    pub context: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Reachability {
    Reachable,
    Unreachable,
    Unauthorized,
    Forbidden,
    /// Not checked: the context needs an interactive sign-in (or its auth
    /// method is unknown).
    Skipped,
    Error,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClusterStatus {
    pub kube_config: String,
    pub context: String,
    pub reachability: Reachability,
    /// `gitVersion` of the API server, e.g. `v1.31.2`.
    pub server_version: Option<String>,
    pub node_count: Option<u64>,
    /// Round trip of `GET /version` (any HTTP answer).
    pub latency_ms: Option<u64>,
    /// Unix ms.
    pub checked_at: i64,
    /// Unix ms of the last check that found the cluster reachable.
    pub last_ok_at: Option<i64>,
    pub interactive: InteractiveClass,
    /// Basename of the exec credential plugin, if any (no args, no env).
    pub auth_command: Option<String>,
    /// Short (one line, at most 160 chars), user-facing; never secrets.
    pub message: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ProbeEvent {
    Result { status: ClusterStatus },
    Done,
}

/* ------------------------------------------------------------------ cache */

/// Newest status per (kubeconfig, context), at most `MAX_CACHED`.
#[derive(Debug, Default)]
struct StatusStore {
    entries: HashMap<(String, String), ClusterStatus>,
}

impl StatusStore {
    fn get(&self, kube_config: &str, context: &str) -> Option<&ClusterStatus> {
        self.entries
            .get(&(kube_config.to_string(), context.to_string()))
    }

    /// Keeps `status` unless a newer one is stored; evicts the oldest when
    /// over capacity.
    fn insert(&mut self, status: ClusterStatus) {
        let key = (status.kube_config.clone(), status.context.clone());
        if self
            .entries
            .get(&key)
            .is_some_and(|existing| existing.checked_at > status.checked_at)
        {
            return;
        }
        self.entries.insert(key, status);
        while self.entries.len() > MAX_CACHED {
            let oldest = self
                .entries
                .iter()
                .min_by_key(|(_, s)| s.checked_at)
                .map(|(key, _)| key.clone());
            match oldest {
                Some(key) => self.entries.remove(&key),
                None => break,
            };
        }
    }

    fn statuses(&self) -> Vec<ClusterStatus> {
        let mut statuses: Vec<ClusterStatus> = self.entries.values().cloned().collect();
        statuses.sort_by(|a, b| (&a.kube_config, &a.context).cmp(&(&b.kube_config, &b.context)));
        statuses
    }
}

#[derive(Default)]
struct Cache {
    store: StatusStore,
    /// Where the cache is persisted; None until a command resolved the app
    /// cache dir (and in tests).
    path: Option<PathBuf>,
    loaded: bool,
    dirty: bool,
    save_scheduled: bool,
}

static CACHE: Lazy<Mutex<Cache>> = Lazy::new(|| Mutex::new(Cache::default()));
/// Serialises writers of the cache file (the debounced task and the exit
/// flush), so an older snapshot never replaces a newer one.
static SAVE_LOCK: Mutex<()> = Mutex::new(());

#[derive(Serialize, Deserialize)]
struct CacheFile<T> {
    version: u32,
    statuses: Vec<T>,
}

/// Statuses persisted at `path`. Unreadable files and entries (e.g. from a
/// newer version) are skipped.
fn load_file(path: &Path) -> Vec<ClusterStatus> {
    let Ok(bytes) = std::fs::read(path) else {
        return Vec::new();
    };
    match serde_json::from_slice::<CacheFile<serde_json::Value>>(&bytes) {
        Ok(file) if file.version == CACHE_VERSION => file
            .statuses
            .into_iter()
            .filter_map(|value| serde_json::from_value(value).ok())
            .collect(),
        Ok(file) => {
            warn!("Ignoring cluster status cache version {}", file.version);
            Vec::new()
        }
        Err(e) => {
            warn!("Ignoring unreadable cluster status cache: {}", e);
            Vec::new()
        }
    }
}

/// Writes `statuses` to `path` atomically (temp file + rename).
fn save_file(path: &Path, statuses: Vec<ClusterStatus>) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let json = serde_json::to_vec(&CacheFile {
        version: CACHE_VERSION,
        statuses,
    })?;
    let tmp = path.with_extension("json.tmp");
    {
        let mut file = std::fs::File::create(&tmp)?;
        file.write_all(&json)?;
        file.sync_all()?;
    }
    std::fs::rename(&tmp, path).inspect_err(|_| {
        let _ = std::fs::remove_file(&tmp);
    })
}

/// Loads the persisted cache on first use. Statuses recorded in the
/// meantime win when they are newer.
fn ensure_loaded(app: &tauri::AppHandle) {
    if lock(&CACHE).loaded {
        return;
    }
    let path = match app.path().app_cache_dir() {
        Ok(dir) => dir.join(CACHE_FILE),
        Err(e) => {
            warn!("No app cache dir for the cluster status cache: {}", e);
            lock(&CACHE).loaded = true;
            return;
        }
    };
    let statuses = load_file(&path);
    let mut cache = lock(&CACHE);
    if cache.loaded {
        return;
    }
    debug!("Loaded {} cached cluster statuses", statuses.len());
    for status in statuses {
        cache.store.insert(status);
    }
    cache.path = Some(path);
    cache.loaded = true;
    if cache.dirty {
        drop(cache);
        schedule_save();
    }
}

/// Stores `status`, carrying `last_ok_at` over from the previous status
/// unless this check succeeded. Returns the stored status.
fn record(mut status: ClusterStatus) -> ClusterStatus {
    {
        let mut cache = lock(&CACHE);
        let previous = cache
            .store
            .get(&status.kube_config, &status.context)
            .and_then(|s| s.last_ok_at);
        status.last_ok_at = if status.reachability == Reachability::Reachable {
            Some(status.checked_at)
        } else {
            previous
        };
        cache.store.insert(status.clone());
        cache.dirty = true;
    }
    schedule_save();
    status
}

fn schedule_save() {
    {
        let mut cache = lock(&CACHE);
        if cache.path.is_none() || cache.save_scheduled {
            return;
        }
        cache.save_scheduled = true;
    }
    tauri::async_runtime::spawn(async {
        tokio::time::sleep(SAVE_DEBOUNCE).await;
        lock(&CACHE).save_scheduled = false;
        let _ = tauri::async_runtime::spawn_blocking(flush_status_cache).await;
    });
}

/// Writes pending cache changes now (debounced writes call this; also on
/// app exit).
pub fn flush_status_cache() {
    let _guard = lock(&SAVE_LOCK);
    let (path, statuses) = {
        let mut cache = lock(&CACHE);
        let Some(path) = cache.path.clone().filter(|_| cache.dirty) else {
            return;
        };
        cache.dirty = false;
        (path, cache.store.statuses())
    };
    if let Err(e) = save_file(&path, statuses) {
        warn!("Failed to write the cluster status cache: {}", e);
        lock(&CACHE).dirty = true;
    }
}

/// The last known status of each of `contexts` that has one, in request
/// order.
#[tauri::command]
pub async fn cluster_status_cached(
    app: tauri::AppHandle,
    contexts: Vec<ContextRef>,
) -> Vec<ClusterStatus> {
    ensure_loaded(&app);
    let cache = lock(&CACHE);
    contexts
        .iter()
        .filter_map(|c| cache.store.get(&c.kube_config, &c.context).cloned())
        .collect()
}

/* ------------------------------------------------------------------ probe */

#[derive(Debug, Clone, Copy)]
struct Timeouts {
    client: Duration,
    request: Duration,
}

impl Default for Timeouts {
    fn default() -> Self {
        Timeouts {
            client: CLIENT_TIMEOUT,
            request: REQUEST_TIMEOUT,
        }
    }
}

#[derive(Debug, Clone, Copy, Default)]
struct ProbeOptions {
    include_nodes: bool,
    include_interactive: bool,
    timeouts: Timeouts,
}

/// A context that passed the gate.
#[derive(Debug, Clone)]
struct ProbeJob {
    target: ContextRef,
    /// `target.kube_config` resolved (see `resolve_kubeconfig_path`).
    kube_config_path: String,
    interactive: InteractiveClass,
    auth_command: Option<String>,
}

impl ProbeJob {
    fn status(&self, reachability: Reachability, message: Option<String>) -> ClusterStatus {
        base_status(&self.target, reachability, self.interactive, self.auth_command.clone(), message)
    }
}

enum Planned {
    /// Known without contacting the cluster (skipped, broken kubeconfig).
    Finished(ClusterStatus),
    Probe(ProbeJob),
}

fn base_status(
    target: &ContextRef,
    reachability: Reachability,
    interactive: InteractiveClass,
    auth_command: Option<String>,
    message: Option<String>,
) -> ClusterStatus {
    ClusterStatus {
        kube_config: target.kube_config.clone(),
        context: target.context.clone(),
        reachability,
        server_version: None,
        node_count: None,
        latency_ms: None,
        checked_at: now_ms(),
        last_ok_at: None,
        interactive,
        auth_command,
        message,
    }
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// The user of `context` like kube-rs resolves it: a missing or unknown user
/// means no credentials. None when the context doesn't exist.
fn auth_info_of(config: &Kubeconfig, context: &str) -> Option<AuthInfo> {
    let context = config
        .contexts
        .iter()
        .find(|c| c.name == context)?
        .context
        .as_ref()?;
    Some(
        context
            .user
            .as_ref()
            .and_then(|user| config.auth_infos.iter().find(|a| &a.name == user))
            .and_then(|a| a.auth_info.clone())
            .unwrap_or_default(),
    )
}

/// Classifies every target and applies the gate. Reads each kubeconfig
/// once. Blocking (file reads).
fn plan(targets: Vec<ContextRef>, include_interactive: bool) -> Vec<Planned> {
    let mut configs: HashMap<String, Result<Kubeconfig, String>> = HashMap::new();
    targets
        .into_iter()
        .map(|target| {
            let path = resolve_kubeconfig_path(Some(&target.kube_config));
            let config = configs.entry(path.clone()).or_insert_with(|| {
                read_kubeconfig(Some(&path)).map_err(|e| read_error_message(&e))
            });
            let config = match config {
                Ok(config) => config,
                Err(message) => {
                    return Planned::Finished(base_status(
                        &target,
                        Reachability::Error,
                        InteractiveClass::Unknown,
                        None,
                        Some(short_message(message)),
                    ))
                }
            };
            let Some(auth) = auth_info_of(config, &target.context) else {
                return Planned::Finished(base_status(
                    &target,
                    Reachability::Error,
                    InteractiveClass::Unknown,
                    None,
                    Some("The context is not defined in this kubeconfig".to_string()),
                ));
            };
            let interactive = classify_auth(&auth);
            let auth_command = auth
                .exec
                .as_ref()
                .and_then(|exec| exec.command.as_deref())
                .map(command_basename)
                .filter(|name| !name.is_empty());
            let skip_message = match interactive {
                InteractiveClass::NonInteractive => None,
                InteractiveClass::Interactive => Some(SKIPPED_INTERACTIVE),
                InteractiveClass::Unknown => Some(SKIPPED_UNKNOWN),
            };
            match skip_message {
                Some(message) if !include_interactive => Planned::Finished(base_status(
                    &target,
                    Reachability::Skipped,
                    interactive,
                    auth_command,
                    Some(message.to_string()),
                )),
                _ => Planned::Probe(ProbeJob {
                    target,
                    kube_config_path: path,
                    interactive,
                    auth_command,
                }),
            }
        })
        .collect()
}

/// The cached client of `context`, built on the blocking pool: kube-rs runs
/// exec credential plugins synchronously while creating a client, which
/// must neither stall a runtime worker nor outlive the timeout around it.
async fn client_for(context: String, kube_config: String) -> Result<Client, SerializableKubeError> {
    let handle = tokio::runtime::Handle::current();
    tauri::async_runtime::spawn_blocking(move || {
        handle.block_on(client_with_context(&context, Some(&kube_config)))
    })
    .await
    .map_err(|e| SerializableKubeError {
        message: e.to_string(),
        code: None,
        reason: None,
        details: None,
        auth: None,
    })?
}

/// Checks one context. Never records anything.
async fn probe(job: &ProbeJob, include_nodes: bool, timeouts: Timeouts) -> ClusterStatus {
    let client = match tokio::time::timeout(
        timeouts.client,
        client_for(job.target.context.clone(), job.kube_config_path.clone()),
    )
    .await
    {
        Ok(Ok(client)) => client,
        Ok(Err(err)) => {
            let (reachability, message) = client_error(&err);
            return job.status(reachability, Some(message));
        }
        Err(_) => {
            let message = match &job.auth_command {
                Some(command) => format!(
                    "The credential plugin {command} did not finish within {}",
                    duration_label(timeouts.client)
                ),
                None => format!("Timed out after {} preparing the connection", duration_label(timeouts.client)),
            };
            return job.status(Reachability::Error, Some(short_message(&message)));
        }
    };

    let started = Instant::now();
    let version = tokio::time::timeout(timeouts.request, client.apiserver_version()).await;
    let latency = Some(started.elapsed().as_millis() as u64);
    let mut status = match version {
        Ok(Ok(info)) => {
            let mut status = job.status(Reachability::Reachable, None);
            status.server_version = Some(info.git_version).filter(|v| !v.is_empty());
            status.latency_ms = latency;
            status
        }
        Ok(Err(err)) => {
            let (reachability, message) = request_error(&err);
            let mut status = job.status(reachability, Some(message));
            // An HTTP answer still tells how far away the server is.
            if matches!(err, kube::Error::Api(_)) {
                status.latency_ms = latency;
            }
            status
        }
        Err(_) => job.status(
            Reachability::Unreachable,
            Some(format!("Timed out after {}", duration_label(timeouts.request))),
        ),
    };

    if include_nodes && status.reachability == Reachability::Reachable {
        status.node_count = count_nodes(client, timeouts.request).await;
    }
    status.checked_at = now_ms();
    status
}

/// Number of nodes from a one-item (metadata only) list. Any failure (often
/// forbidden) just means unknown.
async fn count_nodes(client: Client, timeout: Duration) -> Option<u64> {
    let api: Api<Node> = Api::all(client);
    let list = tokio::time::timeout(timeout, api.list_metadata(&ListParams::default().limit(1)))
        .await
        .ok()?
        .inspect_err(|e| debug!("Counting nodes failed: {}", e))
        .ok()?;
    node_count(
        list.items.len(),
        list.metadata.remaining_item_count,
        list.metadata.continue_.as_deref(),
    )
}

/// `items` returned plus the server's count of the remaining ones. Without
/// that count, a list with a continue token has an unknown size.
fn node_count(items: usize, remaining: Option<i64>, continue_token: Option<&str>) -> Option<u64> {
    match remaining {
        Some(remaining) => Some(items as u64 + remaining.max(0) as u64),
        None if continue_token.is_some_and(|t| !t.is_empty()) => None,
        None => Some(items as u64),
    }
}

/* ------------------------------------------------------------ error mapping */

/// A user-facing message: the first non-empty line, at most 160 chars.
fn short_message(message: &str) -> String {
    let line = message
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or_default();
    if line.chars().count() <= MAX_MESSAGE_CHARS {
        return line.to_string();
    }
    let mut short: String = line.chars().take(MAX_MESSAGE_CHARS - 1).collect();
    short.push('…');
    short
}

fn duration_label(duration: Duration) -> String {
    if duration >= Duration::from_secs(1) {
        format!("{} s", duration.as_secs())
    } else {
        format!("{} ms", duration.as_millis())
    }
}

/// Maps a failure to build the client. Exec plugin failures were already
/// reduced to a safe message by `auth_error_message`.
fn client_error(err: &SerializableKubeError) -> (Reachability, String) {
    let reachability = match err.reason.as_deref() {
        Some("ExecAuthFailed") => Reachability::Unauthorized,
        // Credential broker failures (sign-in needed, expired, ...).
        _ if err.auth.is_some() => Reachability::Unauthorized,
        _ => Reachability::Error,
    };
    (reachability, short_message(&err.message))
}

/// Maps a failed request. Auth errors are never formatted with `Display`:
/// it includes the exec plugin's stdout, i.e. the credential.
fn request_error(err: &kube::Error) -> (Reachability, String) {
    match err {
        kube::Error::Api(status) => api_error(status.code, &status.reason, &status.message),
        kube::Error::Auth(auth) => (Reachability::Unauthorized, short_message(&auth_error_message(auth))),
        kube::Error::HyperError(e) => (Reachability::Unreachable, transport_message(e)),
        kube::Error::Service(e) => (Reachability::Unreachable, transport_message(e.as_ref())),
        kube::Error::SerdeError(_) => (
            Reachability::Error,
            "The server did not answer like a Kubernetes API server".to_string(),
        ),
        other => (Reachability::Error, short_message(&other.to_string())),
    }
}

/// kube-rs' reason for an error response that wasn't a `Status` (its
/// message is then the raw body, e.g. an HTML page of a proxy).
const UNPARSED_REASON: &str = "Failed to parse error data";

fn api_error(code: u16, reason: &str, message: &str) -> (Reachability, String) {
    let detail = if reason == UNPARSED_REASON {
        String::new()
    } else {
        short_message(message)
    };
    match code {
        401 => (
            Reachability::Unauthorized,
            "The cluster rejected the credentials (401 Unauthorized)".to_string(),
        ),
        403 if detail.is_empty() => (
            Reachability::Forbidden,
            "The cluster denied access (403 Forbidden)".to_string(),
        ),
        403 => (Reachability::Forbidden, detail),
        _ if detail.is_empty() => (Reachability::Error, format!("The server answered HTTP {code}")),
        _ => (Reachability::Error, short_message(&format!("HTTP {code}: {detail}"))),
    }
}

/// A short reason for a connection-level failure, from the error chain.
fn transport_message(err: &(dyn StdError + 'static)) -> String {
    let mut chain: Vec<&(dyn StdError + 'static)> = Vec::new();
    let mut current = Some(err);
    while let Some(e) = current {
        chain.push(e);
        current = e.source();
    }

    let mut tls_io = false;
    for e in &chain {
        if let Some(io) = e.downcast_ref::<std::io::Error>() {
            use std::io::ErrorKind;
            match io.kind() {
                ErrorKind::ConnectionRefused => return "Connection refused".to_string(),
                ErrorKind::TimedOut => return "Connection timed out".to_string(),
                ErrorKind::HostUnreachable | ErrorKind::NetworkUnreachable => {
                    return "Network unreachable".to_string()
                }
                // tokio-rustls reports handshake failures as invalid data.
                ErrorKind::InvalidData => tls_io = true,
                _ => {}
            }
        }
    }

    let messages: Vec<String> = chain.iter().map(|e| e.to_string()).collect();
    let all = messages.join(" | ").to_ascii_lowercase();
    let innermost = messages
        .iter()
        .rev()
        .find(|m| !m.trim().is_empty())
        .cloned()
        .unwrap_or_else(|| "Connection failed".to_string());

    if all.contains("dns error") || all.contains("failed to lookup address") || all.contains("no such host") {
        "Host not found (DNS lookup failed)".to_string()
    } else if tls_io
        || ["certificate", "tls", "handshake", "corrupt message"]
            .iter()
            .any(|needle| all.contains(needle))
    {
        short_message(&format!("TLS: {innermost}"))
    } else {
        short_message(&innermost)
    }
}

/* -------------------------------------------------------------- batches */

static SEMAPHORE: Semaphore = Semaphore::const_new(MAX_CONCURRENT_PROBES);
static NEXT_ID: AtomicU64 = AtomicU64::new(1);
/// Cancellation of running batches.
static BATCHES: Lazy<Mutex<HashMap<u64, watch::Sender<bool>>>> = Lazy::new(|| Mutex::new(HashMap::new()));

type SharedProbe = Shared<BoxFuture<'static, ClusterStatus>>;
/// Running checks per context, with the id of the check.
static IN_FLIGHT: Lazy<Mutex<HashMap<ContextRef, (u64, SharedProbe)>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

/// Removes a finished check from `IN_FLIGHT` (also when it panicked).
struct InFlightGuard {
    target: ContextRef,
    id: u64,
}

impl Drop for InFlightGuard {
    fn drop(&mut self) {
        let mut in_flight = lock(&IN_FLIGHT);
        if in_flight.get(&self.target).is_some_and(|(id, _)| *id == self.id) {
            in_flight.remove(&self.target);
        }
    }
}

/// Checks and records `job`, or waits for the check of the same context
/// that is already running and returns its result.
async fn probe_once(job: ProbeJob, options: ProbeOptions) -> ClusterStatus {
    let shared = {
        let mut in_flight = lock(&IN_FLIGHT);
        match in_flight.get(&job.target) {
            Some((_, shared)) => shared.clone(),
            None => {
                let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
                let fallback = job.status(Reachability::Error, Some("The check failed unexpectedly".to_string()));
                let target = job.target.clone();
                // Spawned so it completes (and is recorded) even when every
                // waiter goes away.
                let task = tauri::async_runtime::spawn(async move {
                    let _guard = InFlightGuard {
                        target: job.target.clone(),
                        id,
                    };
                    let status = record(probe(&job, options.include_nodes, options.timeouts).await);
                    debug!(
                        "Checked context {}: {:?} {}",
                        status.context,
                        status.reachability,
                        status.message.as_deref().unwrap_or_default()
                    );
                    status
                });
                let shared = async move { task.await.unwrap_or(fallback) }.boxed().shared();
                in_flight.insert(target, (id, shared.clone()));
                shared
            }
        }
    };
    shared.await
}

/// Resolves when the batch is cancelled (never when the sender is gone).
async fn cancelled(mut cancel: watch::Receiver<bool>) {
    if cancel.wait_for(|cancelled| *cancelled).await.is_err() {
        std::future::pending::<()>().await;
    }
}

/// Runs a batch: results of skipped / broken contexts first, then each
/// check as it completes, then `Done`. After a cancel, contexts that
/// haven't started are dropped; running checks still report.
async fn run_batch(
    targets: Vec<ContextRef>,
    options: ProbeOptions,
    cancel: watch::Sender<bool>,
    emit: Arc<dyn Fn(ProbeEvent) -> bool + Send + Sync>,
) {
    // A closed channel (the page is gone) cancels the rest.
    let send = |event: ProbeEvent| {
        if !emit(event) {
            cancel.send_replace(true);
        }
    };

    let count = targets.len();
    let include_interactive = options.include_interactive;
    let planned = tauri::async_runtime::spawn_blocking(move || plan(targets, include_interactive))
        .await
        .unwrap_or_default();

    let mut jobs = Vec::new();
    for planned in planned {
        match planned {
            Planned::Finished(status) => {
                let status = record(status);
                if !*cancel.borrow() {
                    send(ProbeEvent::Result { status });
                }
            }
            Planned::Probe(job) => jobs.push(job),
        }
    }
    debug!("Probe batch: {} of {} contexts to check", jobs.len(), count);

    futures::stream::iter(jobs)
        .for_each_concurrent(None, |job| {
            let cancel_rx = cancel.subscribe();
            let send = &send;
            async move {
                let permit = tokio::select! {
                    permit = SEMAPHORE.acquire() => permit,
                    _ = cancelled(cancel_rx.clone()) => return,
                };
                if *cancel_rx.borrow() {
                    return;
                }
                let status = probe_once(job, options).await;
                drop(permit);
                send(ProbeEvent::Result { status });
            }
        })
        .await;
    send(ProbeEvent::Done);
}

/// Starts checking `contexts` (see the module docs); results arrive on
/// `on_event`. Returns the batch id for `cluster_probe_cancel`.
#[tauri::command]
pub async fn cluster_probe(
    app: tauri::AppHandle,
    contexts: Vec<ContextRef>,
    include_nodes: Option<bool>,
    include_interactive: Option<bool>,
    on_event: Channel<ProbeEvent>,
) -> Result<u64, String> {
    ensure_loaded(&app);
    let options = ProbeOptions {
        include_nodes: include_nodes == Some(true),
        include_interactive: include_interactive == Some(true),
        timeouts: Timeouts::default(),
    };
    let emit = Arc::new(move |event: ProbeEvent| on_event.send(event).is_ok());
    Ok(start_batch(contexts, options, emit))
}

fn start_batch(
    contexts: Vec<ContextRef>,
    options: ProbeOptions,
    emit: Arc<dyn Fn(ProbeEvent) -> bool + Send + Sync>,
) -> u64 {
    let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
    let (cancel, _) = watch::channel(false);
    lock(&BATCHES).insert(id, cancel.clone());
    info!(
        "Probe batch {} started for {} contexts (nodes: {}, interactive: {})",
        id,
        contexts.len(),
        options.include_nodes,
        options.include_interactive
    );
    tauri::async_runtime::spawn(async move {
        run_batch(contexts, options, cancel, emit).await;
        lock(&BATCHES).remove(&id);
        debug!("Probe batch {} done", id);
    });
    id
}

/// Stops a batch: contexts that haven't started are not checked; `Done`
/// follows once the running checks finished.
#[tauri::command]
pub fn cluster_probe_cancel(batch_id: u64) {
    if let Some(cancel) = lock(&BATCHES).get(&batch_id) {
        debug!("Cancelling probe batch {}", batch_id);
        cancel.send_replace(true);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    fn target(kube_config: &Path, context: &str) -> ContextRef {
        ContextRef {
            kube_config: kube_config.to_string_lossy().into_owned(),
            context: context.to_string(),
        }
    }

    fn status(kube_config: &str, context: &str, checked_at: i64) -> ClusterStatus {
        ClusterStatus {
            kube_config: kube_config.into(),
            context: context.into(),
            reachability: Reachability::Reachable,
            server_version: Some("v1.31.2".into()),
            node_count: Some(3),
            latency_ms: Some(12),
            checked_at,
            last_ok_at: Some(checked_at),
            interactive: InteractiveClass::NonInteractive,
            auth_command: Some("aws".into()),
            message: None,
        }
    }

    fn fast() -> ProbeOptions {
        ProbeOptions {
            include_nodes: true,
            include_interactive: false,
            timeouts: Timeouts {
                client: Duration::from_secs(5),
                request: Duration::from_millis(400),
            },
        }
    }

    /// Runs a batch to completion and returns its events.
    fn run(targets: Vec<ContextRef>, options: ProbeOptions) -> Vec<ProbeEvent> {
        let events = Arc::new(Mutex::new(Vec::new()));
        let sink = events.clone();
        let emit = Arc::new(move |event: ProbeEvent| {
            lock(&sink).push(event);
            true
        });
        tauri::async_runtime::block_on(run_batch(targets, options, watch::channel(false).0, emit));
        let events = lock(&events).clone();
        events
    }

    fn results(events: &[ProbeEvent]) -> Vec<ClusterStatus> {
        assert_eq!(events.last(), Some(&ProbeEvent::Done), "{events:?}");
        events
            .iter()
            .filter_map(|e| match e {
                ProbeEvent::Result { status } => Some(status.clone()),
                ProbeEvent::Done => None,
            })
            .collect()
    }

    fn write_kubeconfig(dir: &Path, server: &str, users: &str, contexts: &[(&str, &str)]) -> PathBuf {
        let mut yaml = format!(
            "apiVersion: v1\nkind: Config\nclusters:\n- name: c\n  cluster:\n    server: {server}\ncontexts:\n"
        );
        for (name, user) in contexts {
            yaml.push_str(&format!("- name: {name}\n  context:\n    cluster: c\n    user: {user}\n"));
        }
        yaml.push_str("users:\n");
        yaml.push_str(users);
        let path = dir.join("kubeconfig.yaml");
        std::fs::write(&path, yaml).unwrap();
        path
    }

    const TOKEN_USER: &str = "- name: token\n  user:\n    token: probe-secret-token\n";

    /// A tiny HTTP/1.1 API server. `respond` maps a request path to
    /// (status, body); every request is counted per path.
    struct FakeApi {
        url: String,
        requests: Arc<Mutex<Vec<String>>>,
    }

    impl FakeApi {
        fn start(
            delay: Duration,
            respond: impl Fn(&str) -> (u16, String) + Send + Sync + 'static,
        ) -> FakeApi {
            let respond = Arc::new(respond);
            let requests = Arc::new(Mutex::new(Vec::new()));
            let seen = requests.clone();
            let listener = tauri::async_runtime::block_on(TcpListener::bind("127.0.0.1:0")).unwrap();
            let url = format!("http://{}", listener.local_addr().unwrap());
            tauri::async_runtime::spawn(async move {
                loop {
                    let Ok((mut socket, _)) = listener.accept().await else { return };
                    let respond = respond.clone();
                    let seen = seen.clone();
                    tauri::async_runtime::spawn(async move {
                        let mut buffer = Vec::new();
                        let mut chunk = [0u8; 4096];
                        loop {
                            // A TLS ClientHello: answer in plain HTTP.
                            if buffer.first() == Some(&0x16) {
                                let _ = socket.write_all(b"HTTP/1.1 400 Bad Request\r\n\r\n").await;
                                return;
                            }
                            let Some(end) = buffer.windows(4).position(|w| w == b"\r\n\r\n") else {
                                match socket.read(&mut chunk).await {
                                    Ok(0) | Err(_) => return,
                                    Ok(n) => buffer.extend_from_slice(&chunk[..n]),
                                }
                                continue;
                            };
                            let head = String::from_utf8_lossy(&buffer[..end]).into_owned();
                            buffer.drain(..end + 4);
                            let path = head.split_whitespace().nth(1).unwrap_or("").to_string();
                            lock(&seen).push(path.clone());
                            tokio::time::sleep(delay).await;
                            let (code, body) = respond(&path);
                            let response = format!(
                                "HTTP/1.1 {code} X\r\ncontent-type: application/json\r\ncontent-length: {}\r\n\r\n{body}",
                                body.len()
                            );
                            if socket.write_all(response.as_bytes()).await.is_err() {
                                return;
                            }
                        }
                    });
                }
            });
            FakeApi { url, requests }
        }

        fn count(&self, prefix: &str) -> usize {
            lock(&self.requests).iter().filter(|p| p.starts_with(prefix)).count()
        }
    }

    fn healthy_api(path: &str) -> (u16, String) {
        if path.starts_with("/version") {
            (200, r#"{"major":"1","minor":"31","gitVersion":"v1.31.2","gitCommit":"","gitTreeState":"","buildDate":"","goVersion":"","compiler":"","platform":""}"#.into())
        } else if path.starts_with("/api/v1/nodes") {
            (200, r#"{"apiVersion":"meta.k8s.io/v1","kind":"PartialObjectMetadataList","metadata":{"continue":"abc","remainingItemCount":4},"items":[{"apiVersion":"meta.k8s.io/v1","kind":"PartialObjectMetadata","metadata":{"name":"n1"}}]}"#.into())
        } else {
            (404, r#"{"kind":"Status","apiVersion":"v1","status":"Failure","message":"not found","reason":"NotFound","code":404}"#.into())
        }
    }

    /* ---------------------------------------------------------- pure parts */

    #[test]
    fn api_errors_map_to_reachability() {
        use kube::core::Status;
        let api = |code: u16, reason: &str, message: &str| {
            kube::Error::Api(Status::failure(message, reason).with_code(code).boxed())
        };

        let (r, m) = request_error(&api(401, "Unauthorized", "Unauthorized"));
        assert_eq!(r, Reachability::Unauthorized);
        assert!(m.contains("401"), "{m}");

        let forbidden = r#"forbidden: User "system:anonymous" cannot get path "/version""#;
        assert_eq!(
            request_error(&api(403, "Forbidden", forbidden)),
            (Reachability::Forbidden, forbidden.to_string())
        );
        // Raw (non-Status) bodies are never shown.
        let (r, m) = request_error(&api(403, UNPARSED_REASON, "<html><body>denied</body></html>"));
        assert_eq!(r, Reachability::Forbidden);
        assert!(!m.contains("html"), "{m}");
        let (r, m) = request_error(&api(502, UNPARSED_REASON, "<html>\nBad gateway</html>"));
        assert_eq!(r, Reachability::Error);
        assert_eq!(m, "The server answered HTTP 502");
        assert_eq!(
            request_error(&api(500, "InternalError", "etcd is down\nmore")),
            (Reachability::Error, "HTTP 500: etcd is down".to_string())
        );
    }

    #[test]
    fn auth_errors_are_unauthorized_without_credentials() {
        #[cfg(unix)]
        use std::os::unix::process::ExitStatusExt;
        #[cfg(windows)]
        use std::os::windows::process::ExitStatusExt;
        let (r, _) = request_error(&kube::Error::Auth(kube::client::AuthError::ExecPluginFailed));
        assert_eq!(r, Reachability::Unauthorized);

        let output = std::process::Output {
            status: std::process::ExitStatus::from_raw(1),
            stdout: br#"{"kind":"ExecCredential","status":{"token":"leaked-token"}}"#.to_vec(),
            stderr: b"Token has expired and refresh failed\nsecond line".to_vec(),
        };
        let err = kube::Error::Auth(kube::client::AuthError::AuthExecRun {
            cmd: "aws".into(),
            status: output.status,
            out: output,
        });
        let (r, m) = request_error(&err);
        assert_eq!(r, Reachability::Unauthorized);
        assert!(!m.contains("leaked-token"), "{m}");
        assert!(m.contains("Token has expired"), "{m}");
        assert!(!m.contains('\n'));

        let (r, m) = client_error(&SerializableKubeError {
            message: "The Kubernetes exec credential plugin failed: expired\n\nComplete the login".into(),
            code: None,
            reason: Some("ExecAuthFailed".into()),
            details: None,
            auth: None,
        });
        assert_eq!(r, Reachability::Unauthorized);
        assert_eq!(m, "The Kubernetes exec credential plugin failed: expired");
        let (r, _) = client_error(&SerializableKubeError {
            message: "Not a valid kubeconfig".into(),
            code: None,
            reason: None,
            details: None,
            auth: None,
        });
        assert_eq!(r, Reachability::Error);
    }

    /// An error wrapping another, like hyper-util's connect errors.
    #[derive(Debug)]
    struct Wrapped(&'static str, Box<dyn StdError + Send + Sync>);
    impl std::fmt::Display for Wrapped {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            f.write_str(self.0)
        }
    }
    impl StdError for Wrapped {
        fn source(&self) -> Option<&(dyn StdError + 'static)> {
            Some(self.1.as_ref())
        }
    }

    #[test]
    fn transport_errors_are_unreachable_with_a_short_reason() {
        use std::io::{Error as IoError, ErrorKind};
        let service = |e: Box<dyn StdError + Send + Sync>| kube::Error::Service(e);
        let io = |kind: ErrorKind, msg: &str| Box::new(IoError::new(kind, msg.to_string()));

        let cases: Vec<(kube::Error, &str)> = vec![
            (
                service(Box::new(Wrapped("client error (Connect)", io(ErrorKind::ConnectionRefused, "os error 111")))),
                "Connection refused",
            ),
            (service(io(ErrorKind::TimedOut, "deadline")), "Connection timed out"),
            (
                service(Box::new(Wrapped(
                    "client error (Connect)",
                    Box::new(Wrapped("dns error", io(ErrorKind::Other, "failed to lookup address information"))),
                ))),
                "Host not found (DNS lookup failed)",
            ),
            (
                service(Box::new(Wrapped(
                    "client error (Connect)",
                    io(ErrorKind::InvalidData, "invalid peer certificate: UnknownIssuer"),
                ))),
                "TLS: invalid peer certificate: UnknownIssuer",
            ),
            (service(Box::new(Wrapped("connection closed before message completed", io(ErrorKind::Other, "")))), "connection closed before message completed"),
        ];
        for (err, expected) in cases {
            assert_eq!(request_error(&err), (Reachability::Unreachable, expected.to_string()));
        }

        let serde = serde_json::from_str::<u8>("x").unwrap_err();
        assert_eq!(request_error(&kube::Error::SerdeError(serde)).0, Reachability::Error);
    }

    #[test]
    fn messages_are_one_short_line() {
        assert_eq!(short_message("\n  first  \nsecond"), "first");
        assert_eq!(short_message(""), "");
        let long = "x".repeat(500);
        let short = short_message(&long);
        assert_eq!(short.chars().count(), MAX_MESSAGE_CHARS);
        assert!(short.ends_with('…'));
        let exact = "é".repeat(MAX_MESSAGE_CHARS);
        assert_eq!(short_message(&exact), exact);
        assert_eq!(duration_label(Duration::from_secs(5)), "5 s");
        assert_eq!(duration_label(Duration::from_millis(400)), "400 ms");
    }

    #[test]
    fn node_count_adds_the_remaining_items() {
        assert_eq!(node_count(1, Some(4), Some("abc")), Some(5));
        assert_eq!(node_count(1, None, None), Some(1));
        assert_eq!(node_count(1, None, Some("")), Some(1));
        assert_eq!(node_count(0, None, None), Some(0));
        // The server couldn't count (e.g. a selector): unknown.
        assert_eq!(node_count(1, None, Some("abc")), None);
        assert_eq!(node_count(1, Some(-1), None), Some(1));
    }

    #[test]
    fn events_serialize_with_a_type_tag() {
        let event = ProbeEvent::Result {
            status: status("/kc", "ctx", 5),
        };
        let json = serde_json::to_value(&event).unwrap();
        assert_eq!(json["type"], "result");
        assert_eq!(json["status"]["kubeConfig"], "/kc");
        assert_eq!(json["status"]["reachability"], "reachable");
        assert_eq!(json["status"]["serverVersion"], "v1.31.2");
        assert_eq!(json["status"]["lastOkAt"], 5);
        assert_eq!(json["status"]["interactive"], "nonInteractive");
        assert_eq!(json["status"]["authCommand"], "aws");
        assert_eq!(serde_json::to_value(ProbeEvent::Done).unwrap(), serde_json::json!({"type": "done"}));

        let target: ContextRef = serde_json::from_str(r#"{"context":"c"}"#).unwrap();
        assert_eq!(target.kube_config, "");
    }

    /* ---------------------------------------------------------------- cache */

    #[test]
    fn store_keeps_the_newest_status_and_caps_its_size() {
        let mut store = StatusStore::default();
        store.insert(status("/kc", "a", 10));
        store.insert(status("/kc", "a", 5));
        assert_eq!(store.get("/kc", "a").unwrap().checked_at, 10);
        store.insert(status("/kc", "a", 20));
        assert_eq!(store.get("/kc", "a").unwrap().checked_at, 20);
        assert!(store.get("/other", "a").is_none());

        for i in 0..(MAX_CACHED as i64 + 5) {
            store.insert(status("/many", &format!("ctx-{i}"), 100 + i));
        }
        assert_eq!(store.entries.len(), MAX_CACHED);
        // The oldest ones went first.
        assert!(store.get("/kc", "a").is_none());
        assert!(store.get("/many", "ctx-4").is_none());
        assert!(store.get("/many", "ctx-5").is_some());
    }

    #[test]
    fn cache_file_round_trip() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nested").join(CACHE_FILE);
        assert!(load_file(&path).is_empty());

        let mut unreachable = status("/kc", "b", 7);
        unreachable.reachability = Reachability::Unreachable;
        unreachable.message = Some("Connection refused".into());
        unreachable.server_version = None;
        let statuses = vec![status("/kc", "a", 5), unreachable];
        save_file(&path, statuses.clone()).unwrap();
        assert_eq!(load_file(&path), statuses);
        // Atomic: no temp file left behind.
        let names: Vec<_> = std::fs::read_dir(path.parent().unwrap())
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        assert_eq!(names, vec![std::ffi::OsString::from(CACHE_FILE)]);

        // Overwrites.
        save_file(&path, vec![status("/kc", "c", 9)]).unwrap();
        assert_eq!(load_file(&path).len(), 1);

        // Broken files, other versions and unknown entries are ignored.
        std::fs::write(&path, "{ not json").unwrap();
        assert!(load_file(&path).is_empty());
        std::fs::write(&path, r#"{"version":99,"statuses":[]}"#).unwrap();
        assert!(load_file(&path).is_empty());
        let mut json = serde_json::to_value(CacheFile {
            version: CACHE_VERSION,
            statuses: vec![status("/kc", "a", 5)],
        })
        .unwrap();
        json["statuses"]
            .as_array_mut()
            .unwrap()
            .push(serde_json::json!({"context": "x", "reachability": "teleported"}));
        std::fs::write(&path, json.to_string()).unwrap();
        assert_eq!(load_file(&path), vec![status("/kc", "a", 5)]);
    }

    #[test]
    fn record_keeps_the_last_success() {
        let mut ok = status("/test/record", "ctx", 1_000);
        ok.last_ok_at = None;
        assert_eq!(record(ok).last_ok_at, Some(1_000));

        let mut failed = status("/test/record", "ctx", 2_000);
        failed.reachability = Reachability::Unreachable;
        failed.last_ok_at = None;
        assert_eq!(record(failed).last_ok_at, Some(1_000));
        assert_eq!(
            lock(&CACHE).store.get("/test/record", "ctx").unwrap().checked_at,
            2_000
        );
    }

    /* ----------------------------------------------------------------- gate */

    /// A fake `kubelogin` that leaves a marker when it runs and prints a
    /// credential.
    #[cfg(unix)]
    fn marker_plugin(dir: &Path) -> (PathBuf, PathBuf) {
        use std::os::unix::fs::PermissionsExt;
        let marker = dir.join("plugin-ran");
        let script = dir.join("kubelogin");
        std::fs::write(
            &script,
            format!(
                "#!/bin/sh\ntouch '{}'\necho '{{\"apiVersion\":\"client.authentication.k8s.io/v1beta1\",\"kind\":\"ExecCredential\",\"status\":{{\"token\":\"t\"}}}}'\n",
                marker.display()
            ),
        )
        .unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        (script, marker)
    }

    #[cfg(unix)]
    #[test]
    fn interactive_contexts_are_skipped_without_running_the_plugin() {
        let dir = tempfile::tempdir().unwrap();
        let (script, marker) = marker_plugin(dir.path());
        // Nothing listens there, so an (allowed) check fails fast.
        let closed = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let server = format!("http://{}", closed.local_addr().unwrap());
        drop(closed);
        let users = format!(
            "- name: devicecode\n  user:\n    exec:\n      apiVersion: client.authentication.k8s.io/v1beta1\n      command: {}\n      args: [get-token, --login, devicecode, --server-id, x]\n\
             - name: custom\n  user:\n    exec:\n      apiVersion: client.authentication.k8s.io/v1beta1\n      command: /opt/acme/get-cluster-token\n",
            script.display()
        );
        let kubeconfig = write_kubeconfig(
            dir.path(),
            &server,
            &users,
            &[("aks", "devicecode"), ("acme", "custom")],
        );
        let targets = vec![target(&kubeconfig, "aks"), target(&kubeconfig, "acme")];

        let statuses = results(&run(targets.clone(), fast()));
        assert_eq!(statuses.len(), 2);
        let aks = &statuses[0];
        assert_eq!(aks.context, "aks");
        assert_eq!(aks.reachability, Reachability::Skipped);
        assert_eq!(aks.interactive, InteractiveClass::Interactive);
        assert_eq!(aks.auth_command.as_deref(), Some("kubelogin"));
        assert_eq!(aks.message.as_deref(), Some(SKIPPED_INTERACTIVE));
        let acme = &statuses[1];
        assert_eq!(acme.reachability, Reachability::Skipped);
        assert_eq!(acme.interactive, InteractiveClass::Unknown);
        assert_eq!(acme.auth_command.as_deref(), Some("get-cluster-token"));
        assert_eq!(acme.message.as_deref(), Some(SKIPPED_UNKNOWN));

        std::thread::sleep(Duration::from_millis(200));
        assert!(!marker.exists(), "the interactive plugin must never run");
        // Skipped contexts never get a client either.
        let path = kubeconfig.to_string_lossy().into_owned();
        assert!(!lock(&IN_FLIGHT).keys().any(|t| t.kube_config == path));

        // Control: the same fixture does run the plugin when explicitly
        // asked, so the assertion above can fail.
        let options = ProbeOptions {
            include_interactive: true,
            ..fast()
        };
        let mut ran = false;
        for _ in 0..3 {
            let statuses = results(&run(vec![targets[0].clone()], options));
            assert_eq!(statuses[0].interactive, InteractiveClass::Interactive);
            if marker.exists() {
                assert_eq!(statuses[0].reachability, Reachability::Unreachable);
                assert_eq!(statuses[0].message.as_deref(), Some("Connection refused"));
                ran = true;
                break;
            }
            // A freshly written script can be briefly busy (ETXTBSY).
            std::thread::sleep(Duration::from_millis(100));
        }
        assert!(ran, "the control run should have executed the plugin");
    }

    #[test]
    fn broken_kubeconfigs_and_missing_contexts_are_errors() {
        let dir = tempfile::tempdir().unwrap();
        let kubeconfig = write_kubeconfig(dir.path(), "http://127.0.0.1:1", TOKEN_USER, &[("ok", "token")]);
        let statuses = results(&run(
            vec![
                target(&kubeconfig, "missing"),
                target(&dir.path().join("nope.yaml"), "ctx"),
            ],
            fast(),
        ));
        assert_eq!(statuses[0].reachability, Reachability::Error);
        assert_eq!(statuses[0].message.as_deref(), Some("The context is not defined in this kubeconfig"));
        assert_eq!(statuses[1].reachability, Reachability::Error);
        assert_eq!(statuses[1].message.as_deref(), Some("The file does not exist."));
    }

    /* ------------------------------------------------------- against a server */

    #[test]
    fn reachable_cluster_reports_version_latency_and_nodes() {
        let api = FakeApi::start(Duration::ZERO, healthy_api);
        let dir = tempfile::tempdir().unwrap();
        // A user that isn't defined means no credentials, like kube-rs.
        let kubeconfig = write_kubeconfig(dir.path(), &api.url, TOKEN_USER, &[("prod", "token"), ("anon", "ghost")]);

        let statuses = results(&run(vec![target(&kubeconfig, "prod"), target(&kubeconfig, "anon")], fast()));
        assert_eq!(statuses.len(), 2);
        for status in &statuses {
            assert_eq!(status.reachability, Reachability::Reachable, "{status:?}");
            assert_eq!(status.server_version.as_deref(), Some("v1.31.2"));
            assert_eq!(status.node_count, Some(5));
            assert!(status.latency_ms.is_some());
            assert_eq!(status.last_ok_at, Some(status.checked_at));
            assert_eq!(status.interactive, InteractiveClass::NonInteractive);
            assert_eq!(status.auth_command, None);
            assert_eq!(status.message, None);
        }
        let json = serde_json::to_string(&statuses).unwrap();
        assert!(!json.contains("probe-secret-token"));

        // Without include_nodes the nodes aren't listed.
        let before = api.count("/api/v1/nodes");
        let options = ProbeOptions {
            include_nodes: false,
            ..fast()
        };
        let statuses = results(&run(vec![target(&kubeconfig, "prod")], options));
        assert_eq!(statuses[0].node_count, None);
        assert_eq!(api.count("/api/v1/nodes"), before);
    }

    #[test]
    fn forbidden_nodes_leave_the_cluster_reachable() {
        let api = FakeApi::start(Duration::ZERO, |path| {
            if path.starts_with("/version") {
                healthy_api(path)
            } else {
                (403, r#"{"kind":"Status","apiVersion":"v1","status":"Failure","message":"nodes is forbidden","reason":"Forbidden","code":403}"#.into())
            }
        });
        let dir = tempfile::tempdir().unwrap();
        let kubeconfig = write_kubeconfig(dir.path(), &api.url, TOKEN_USER, &[("prod", "token")]);
        let statuses = results(&run(vec![target(&kubeconfig, "prod")], fast()));
        assert_eq!(statuses[0].reachability, Reachability::Reachable);
        assert_eq!(statuses[0].node_count, None);
    }

    #[test]
    fn rejected_credentials_slow_servers_and_closed_ports() {
        let unauthorized = FakeApi::start(Duration::ZERO, |_| {
            (401, r#"{"kind":"Status","apiVersion":"v1","status":"Failure","message":"Unauthorized","reason":"Unauthorized","code":401}"#.into())
        });
        let slow = FakeApi::start(Duration::from_secs(3), healthy_api);
        let closed = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let closed_url = format!("http://{}", closed.local_addr().unwrap());
        drop(closed);

        for (url, reachability, message, latency) in [
            (unauthorized.url.as_str(), Reachability::Unauthorized, "The cluster rejected the credentials (401 Unauthorized)", true),
            (slow.url.as_str(), Reachability::Unreachable, "Timed out after 400 ms", false),
            (closed_url.as_str(), Reachability::Unreachable, "Connection refused", false),
        ] {
            let dir = tempfile::tempdir().unwrap();
            let kubeconfig = write_kubeconfig(dir.path(), url, TOKEN_USER, &[("prod", "token")]);
            let statuses = results(&run(vec![target(&kubeconfig, "prod")], fast()));
            let status = &statuses[0];
            assert_eq!(status.reachability, reachability, "{url}: {status:?}");
            // Windows retries a refused connection for ~2 s, so the probe's
            // timeout fires first there.
            let windows_closed_port = cfg!(windows) && url == closed_url;
            if windows_closed_port {
                assert!(
                    matches!(status.message.as_deref(), Some("Connection refused" | "Timed out after 400 ms")),
                    "{url}: {status:?}"
                );
            } else {
                assert_eq!(status.message.as_deref(), Some(message), "{url}");
            }
            assert_eq!(status.latency_ms.is_some(), latency, "{url}");
            assert_eq!(status.server_version, None);
            assert_eq!(status.node_count, None);
            assert_eq!(status.last_ok_at, None);
        }
    }

    #[test]
    fn tls_failures_are_unreachable() {
        // A plain HTTP server behind an https:// URL fails the handshake.
        let api = FakeApi::start(Duration::ZERO, healthy_api);
        let dir = tempfile::tempdir().unwrap();
        let https = api.url.replace("http://", "https://");
        let kubeconfig = write_kubeconfig(dir.path(), &https, TOKEN_USER, &[("prod", "token")]);
        let statuses = results(&run(vec![target(&kubeconfig, "prod")], fast()));
        assert_eq!(statuses[0].reachability, Reachability::Unreachable, "{:?}", statuses[0]);
        let message = statuses[0].message.clone().unwrap();
        assert!(message.starts_with("TLS: "), "{message}");
    }

    #[test]
    fn concurrent_checks_of_a_context_share_one_request() {
        let api = FakeApi::start(Duration::from_millis(300), healthy_api);
        let dir = tempfile::tempdir().unwrap();
        let kubeconfig = write_kubeconfig(dir.path(), &api.url, TOKEN_USER, &[("prod", "token")]);
        let options = ProbeOptions {
            include_nodes: false,
            timeouts: Timeouts {
                client: Duration::from_secs(5),
                request: Duration::from_secs(5),
            },
            ..fast()
        };

        let finished = Arc::new(AtomicUsize::new(0));
        let batches: Vec<_> = (0..3)
            .map(|_| {
                let targets = vec![target(&kubeconfig, "prod")];
                let finished = finished.clone();
                std::thread::spawn(move || {
                    let statuses = results(&run(targets, options));
                    finished.fetch_add(1, Ordering::SeqCst);
                    statuses
                })
            })
            .collect();
        let statuses: Vec<ClusterStatus> = batches
            .into_iter()
            .flat_map(|b| b.join().unwrap())
            .collect();
        assert_eq!(finished.load(Ordering::SeqCst), 3);
        assert!(statuses.iter().all(|s| s.reachability == Reachability::Reachable));
        assert_eq!(api.count("/version"), 1, "one check for three requests");
        assert!(statuses.windows(2).all(|w| w[0].checked_at == w[1].checked_at));

        // Once finished, asking again checks again.
        results(&run(vec![target(&kubeconfig, "prod")], options));
        assert_eq!(api.count("/version"), 2);
    }

    #[test]
    fn cancelled_batches_do_not_start_queued_checks() {
        let api = FakeApi::start(Duration::ZERO, healthy_api);
        let dir = tempfile::tempdir().unwrap();
        let kubeconfig = write_kubeconfig(dir.path(), &api.url, TOKEN_USER, &[("prod", "token")]);
        let events = Arc::new(Mutex::new(Vec::new()));
        let sink = events.clone();
        let emit = Arc::new(move |event: ProbeEvent| {
            lock(&sink).push(event);
            true
        });

        tauri::async_runtime::block_on(async {
            // Every slot is taken, so the check is queued.
            let permits = SEMAPHORE.acquire_many(MAX_CONCURRENT_PROBES as u32).await.unwrap();
            let id = start_batch(vec![target(&kubeconfig, "prod")], fast(), emit);
            tokio::time::sleep(Duration::from_millis(100)).await;
            cluster_probe_cancel(id);
            drop(permits);
            for _ in 0..50 {
                if lock(&events).contains(&ProbeEvent::Done) {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
            for _ in 0..50 {
                if !lock(&BATCHES).contains_key(&id) {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
            assert!(!lock(&BATCHES).contains_key(&id), "finished batches are forgotten");
        });
        assert_eq!(*lock(&events), vec![ProbeEvent::Done]);
        assert_eq!(api.count("/version"), 0);
        // Unknown ids are ignored.
        cluster_probe_cancel(u64::MAX);
    }
}

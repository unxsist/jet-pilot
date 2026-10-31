//! Change history for the Health page's Changes tab and `likelyCause`:
//! what changed on the active clusters while JET Pilot is open.
//!
//! The front end says which clusters (and namespaces) are active
//! (`changes_track`); a recorder per cluster follows them (see `recorder`)
//! and adds records to the cluster's history (see `store`). Histories live
//! in memory and in `<app data dir>/changes/<hash>.json`, written at most
//! every few seconds and on exit, capped by age and size. `changes_list`
//! reads them; `changes://changed` tells open views a cluster has new
//! records.
//!
//! Everything older (and what happened while the app was closed) the front
//! end reconstructs from the cluster itself: ReplicaSets, Helm, Argo CD,
//! Flux, managedFields.

mod diff;
mod record;
mod recorder;
mod store;

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::time::Duration;

use chrono::Utc;
use once_cell::sync::{Lazy, OnceCell};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};
use tracing::warn;

use crate::kubernetes::client::resolve_kubeconfig_path;
use crate::util::lock;
use record::ChangeRecord;
use store::{ClusterHistory, ObjectFilter, Query, Session};

/// New records are written this long after the first one.
const FLUSH_DELAY: Duration = Duration::from_secs(10);
/// Open views hear about new records this long after the first one.
const EMIT_DELAY: Duration = Duration::from_secs(1);
/// While recording, the session's end moves on this often (so the front
/// end knows until when the record is complete).
const HEARTBEAT: Duration = Duration::from_secs(120);

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct ClusterKey {
    pub kube_config: String,
    pub context: String,
}

struct Loaded {
    history: ClusterHistory,
    dirty: bool,
}

#[derive(Default)]
struct State {
    histories: HashMap<ClusterKey, Loaded>,
    running: HashMap<ClusterKey, recorder::Running>,
    flush_scheduled: bool,
    emits: HashSet<ClusterKey>,
    heartbeat: bool,
}

static STATE: Lazy<std::sync::Mutex<State>> = Lazy::new(Default::default);
/// One `changes_track` at a time: starting a recorder awaits.
static TRACK: Lazy<tokio::sync::Mutex<()>> = Lazy::new(|| tokio::sync::Mutex::new(()));
static APP: OnceCell<AppHandle> = OnceCell::new();
static DIR: OnceCell<PathBuf> = OnceCell::new();

fn path_of(key: &ClusterKey) -> Option<PathBuf> {
    Some(DIR.get()?.join(store::file_name(&key.kube_config, &key.context)))
}

fn history<'a>(state: &'a mut State, key: &ClusterKey) -> &'a mut Loaded {
    state.histories.entry(key.clone()).or_insert_with(|| Loaded {
        history: path_of(key)
            .and_then(|path| store::load(&path))
            .unwrap_or_else(|| ClusterHistory::new(&key.context, &key.kube_config)),
        dirty: false,
    })
}

/// Marks a history as changed: written soon, and open views told.
fn changed(state: &mut State, key: &ClusterKey) {
    history(state, key).dirty = true;
    if !state.flush_scheduled {
        state.flush_scheduled = true;
        tauri::async_runtime::spawn(async {
            tokio::time::sleep(FLUSH_DELAY).await;
            lock(&STATE).flush_scheduled = false;
            let _ = tauri::async_runtime::spawn_blocking(flush_all).await;
        });
    }
    if state.emits.insert(key.clone()) {
        let key = key.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(EMIT_DELAY).await;
            lock(&STATE).emits.remove(&key);
            if let Some(app) = APP.get() {
                let _ = app.emit("changes://changed", Target { context: key.context, kube_config: Some(key.kube_config), namespaces: vec![] });
            }
        });
    }
}

pub(crate) fn add_record(key: &ClusterKey, record: ChangeRecord) {
    let mut state = lock(&STATE);
    history(&mut state, key).history.add(record);
    changed(&mut state, key);
}

pub(crate) fn set_by(key: &ClusterKey, id: &str, by: &str, at: Option<&str>) {
    let mut state = lock(&STATE);
    if history(&mut state, key).history.set_by(id, by, at) {
        changed(&mut state, key);
    }
}

/// Writes every changed history (debounced writes call this; also on exit).
pub fn flush_all() {
    let now = Utc::now();
    let pending: Vec<(PathBuf, ClusterHistory)> = {
        let mut state = lock(&STATE);
        let running: HashSet<ClusterKey> = state.running.keys().cloned().collect();
        state
            .histories
            .iter_mut()
            .filter(|(_, loaded)| loaded.dirty)
            .filter_map(|(key, loaded)| {
                loaded.dirty = false;
                if running.contains(key) {
                    loaded.history.extend_session(now);
                }
                loaded.history.prune(now);
                Some((path_of(key)?, loaded.history.clone()))
            })
            .collect()
    };
    for (path, history) in pending {
        if let Err(e) = store::save(&path, &history) {
            warn!("Changes: {e}");
        }
    }
}

/// Moves the sessions of the running recorders on, every `HEARTBEAT`.
fn start_heartbeat() {
    let mut state = lock(&STATE);
    if state.heartbeat {
        return;
    }
    state.heartbeat = true;
    tauri::async_runtime::spawn(async {
        loop {
            tokio::time::sleep(HEARTBEAT).await;
            {
                let mut state = lock(&STATE);
                let keys: Vec<ClusterKey> = state.running.keys().cloned().collect();
                for key in keys {
                    history(&mut state, &key).dirty = true;
                }
            }
            let _ = tauri::async_runtime::spawn_blocking(flush_all).await;
        }
    });
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Target {
    pub context: String,
    #[serde(default)]
    pub kube_config: Option<String>,
    /// ["all"] (or none) = every namespace.
    #[serde(default)]
    pub namespaces: Vec<String>,
}

impl Target {
    fn key(&self) -> ClusterKey {
        ClusterKey { kube_config: resolve_kubeconfig_path(self.kube_config.as_deref()), context: self.context.clone() }
    }
}

/// Records the given clusters (and stops recording the others). `fresh`:
/// the page (re)loaded, so earlier hub subscriptions are gone: restart all.
/// Recorders that couldn't start completely are retried.
#[tauri::command]
pub async fn changes_track(app: AppHandle, targets: Vec<Target>, fresh: Option<bool>) -> Result<(), String> {
    let _ = APP.set(app.clone());
    if DIR.get().is_none() {
        let dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join("changes");
        let _ = DIR.set(dir);
    }
    start_heartbeat();

    let _guard = TRACK.lock().await;
    let wanted: HashMap<ClusterKey, Vec<String>> = targets.iter().map(|t| (t.key(), t.namespaces.clone())).collect();
    let stale: Vec<recorder::Running> = {
        let mut state = lock(&STATE);
        let keys: Vec<ClusterKey> = state
            .running
            .iter()
            .filter(|(key, running)| {
                fresh == Some(true) || !running.complete || wanted.get(*key) != Some(&running.namespaces)
            })
            .map(|(key, _)| key.clone())
            .collect();
        keys.iter().filter_map(|key| state.running.remove(key)).collect()
    };
    for running in stale {
        running.stop();
    }

    let mut used: usize = lock(&STATE).running.values().map(|r| r.hub_watchers).sum();
    for (key, namespaces) in wanted {
        if lock(&STATE).running.contains_key(&key) {
            continue;
        }
        let budget = recorder::MAX_HUB_WATCHERS.saturating_sub(used);
        let running = recorder::start(key.clone(), namespaces, budget).await;
        used += running.hub_watchers;
        let mut state = lock(&STATE);
        let loaded = history(&mut state, &key);
        loaded.history.begin_session(Utc::now());
        changed(&mut state, &key);
        state.running.insert(key, running);
    }
    Ok(())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListRequest {
    pub targets: Vec<Target>,
    #[serde(default)]
    pub since: Option<String>,
    /// Only these objects (any when empty).
    #[serde(default)]
    pub objects: Vec<ObjectFilter>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClusterChanges {
    pub context: String,
    pub kube_config: String,
    /// The recorder runs for this cluster now.
    pub recording: bool,
    pub sessions: Vec<Session>,
    pub records: Vec<ChangeRecord>,
}

/// The recorded changes of the given clusters, newest first.
#[tauri::command]
pub fn changes_list(request: ListRequest) -> Vec<ClusterChanges> {
    let mut state = lock(&STATE);
    request
        .targets
        .iter()
        .map(|target| {
            let key = target.key();
            let recording = state.running.contains_key(&key);
            let query = Query {
                since: request.since.clone(),
                namespaces: target.namespaces.clone(),
                objects: request.objects.clone(),
            };
            let loaded = history(&mut state, &key);
            let records = loaded.history.query(&query);
            ClusterChanges {
                context: key.context.clone(),
                kube_config: key.kube_config.clone(),
                recording,
                sessions: loaded.history.sessions.clone(),
                records,
            }
        })
        .collect()
}

//! One watched (context, resource, namespace scope): its object store, sync
//! state, pending delta batch and the subscribers it streams to.
//!
//! Everything here is synchronous and runtime-free so it can be unit tested
//! by feeding watcher events directly; `mod.rs` drives it from the
//! kube-runtime watcher stream.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Instant;

use kube::api::{ApiResource, DynamicObject};
use kube::runtime::watcher;
use serde::Serialize;

use super::batch::{push_objects, DeltaBatch};
use super::object::{prepare, StoredObject, Tag};
use crate::util::lock;

/// Receives serialized JSON messages. Returns false when the receiver is
/// gone (the message is dropped either way).
pub type Sink = Arc<dyn Fn(String) -> bool + Send + Sync>;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum State {
    /// Initial list in progress, nothing to show yet.
    Syncing,
    /// Store is complete and being kept up to date.
    Ready,
    /// Re-listing after a 410 Gone / reconnect; the last rows stay valid.
    Relisting,
    /// Transient failure (network, server error). Retried with backoff.
    Error,
    /// RBAC forbids listing/watching. Terminal until resubscribed.
    Forbidden,
    /// Credentials rejected or the exec plugin failed. Terminal until
    /// resubscribed (after a re-login).
    Unauthorized,
    /// Other terminal failure (e.g. the resource type was removed).
    Failed,
}

impl State {
    pub fn is_terminal(self) -> bool {
        matches!(self, State::Forbidden | State::Unauthorized | State::Failed)
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Status {
    pub state: State,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

impl Status {
    pub fn new(state: State) -> Self {
        Status {
            state,
            message: None,
            code: None,
            reason: None,
        }
    }
}

#[derive(Serialize)]
struct StatusMessage<'a> {
    #[serde(rename = "type")]
    kind: &'static str,
    scope: &'a str,
    #[serde(flatten)]
    status: &'a Status,
}

pub struct EntryState {
    store: HashMap<String, Arc<StoredObject>>,
    /// Objects of an in-progress (re)list, swapped in on `InitDone`.
    relist: Option<HashMap<String, Arc<StoredObject>>>,
    /// The first list completed: `store` is meaningful.
    synced: bool,
    status: Status,
    pending: DeltaBatch,
    sinks: HashMap<u64, Sink>,
    /// Bumped whenever the subscriber count drops to zero, so a stale
    /// eviction timer can tell the entry was used again in between.
    pub idle_generation: u64,
    pub idle_since: Option<Instant>,
}

pub struct Entry {
    pub ar: ApiResource,
    pub tag: Tag,
    /// The namespace this entry watches; "" for all namespaces / cluster
    /// scoped resources. Sent with every message.
    pub scope: String,
    scope_json: String,
    state: Mutex<EntryState>,
}

impl Entry {
    pub fn new(ar: ApiResource, tag: Tag, scope: String) -> Self {
        Entry {
            scope_json: serde_json::to_string(&scope).unwrap_or_else(|_| "\"\"".into()),
            ar,
            tag,
            scope,
            state: Mutex::new(EntryState {
                store: HashMap::new(),
                relist: None,
                synced: false,
                status: Status::new(State::Syncing),
                pending: DeltaBatch::default(),
                sinks: HashMap::new(),
                idle_generation: 0,
                idle_since: Some(Instant::now()),
            }),
        }
    }

    pub fn lock(&self) -> MutexGuard<'_, EntryState> {
        lock(&self.state)
    }

    fn status_message(&self, status: &Status) -> String {
        serde_json::to_string(&StatusMessage {
            kind: "status",
            scope: &self.scope,
            status,
        })
        .unwrap_or_default()
    }

    fn snapshot_message(&self, state: &EntryState) -> String {
        let size = state.store.values().map(|o| o.json.len() + 1).sum::<usize>() + 64;
        let mut out = String::with_capacity(size);
        out.push_str("{\"type\":\"snapshot\",\"scope\":");
        out.push_str(&self.scope_json);
        out.push_str(",\"items\":[");
        push_objects(&mut out, state.store.values());
        out.push_str("]}");
        out
    }

    fn broadcast(state: &EntryState, message: String) {
        let mut sinks = state.sinks.values().peekable();
        while let Some(sink) = sinks.next() {
            if sinks.peek().is_some() {
                sink(message.clone());
            } else {
                sink(message);
                break;
            }
        }
    }

    /// Registers a subscriber: it gets the current status and, when the
    /// store is synced, a snapshot right away (warm entries make navigating
    /// back to a list instant).
    pub fn add_sink(&self, id: u64, sink: Sink) {
        let mut state = self.lock();
        sink(self.status_message(&state.status));
        if state.synced {
            sink(self.snapshot_message(&state));
        }
        state.sinks.insert(id, sink);
        state.idle_since = None;
    }

    /// Removes a subscriber and returns how many are left.
    pub fn remove_sink(&self, id: u64) -> usize {
        let mut state = self.lock();
        if state.sinks.remove(&id).is_some() && state.sinks.is_empty() {
            state.idle_generation += 1;
            state.idle_since = Some(Instant::now());
        }
        state.sinks.len()
    }

    pub fn sink_count(&self) -> usize {
        self.lock().sinks.len()
    }

    pub fn object_count(&self) -> usize {
        self.lock().store.len()
    }

    pub fn status(&self) -> Status {
        self.lock().status.clone()
    }

    pub fn get(&self, uid: &str) -> Option<Arc<StoredObject>> {
        self.lock().store.get(uid).cloned()
    }

    pub fn set_status(&self, status: Status) {
        let mut state = self.lock();
        if state.status != status {
            Self::broadcast(&state, self.status_message(&status));
            state.status = status;
        }
    }

    pub fn has_pending(&self) -> bool {
        !self.lock().pending.is_empty()
    }

    /// Sends the pending delta batch (if any) to every subscriber.
    pub fn flush(&self) {
        let mut state = self.lock();
        if let Some(message) = state.pending.take_message(&self.scope_json) {
            Self::broadcast(&state, message);
        }
    }

    /// Applies one watcher event. Returns true when the pending batch should
    /// be flushed right away (end of a re-list).
    pub fn apply(&self, event: watcher::Event<DynamicObject>) -> bool {
        let mut state = self.lock();
        match event {
            watcher::Event::Init => {
                state.relist = Some(HashMap::with_capacity(state.store.len()));
                if state.synced && state.status.state == State::Ready {
                    let status = Status::new(State::Relisting);
                    Self::broadcast(&state, self.status_message(&status));
                    state.status = status;
                }
                false
            }
            watcher::Event::InitApply(obj) => {
                if let Some(stored) = prepare(obj, &self.ar, &self.tag) {
                    let stored = Arc::new(stored);
                    state
                        .relist
                        .get_or_insert_with(HashMap::new)
                        .insert(stored.uid.clone(), stored);
                }
                false
            }
            watcher::Event::InitDone => {
                let fresh = state.relist.take().unwrap_or_default();
                let was_synced = state.synced;
                if was_synced {
                    self.diff_into_pending(&mut state, fresh);
                } else {
                    state.store = fresh;
                    state.synced = true;
                    // Pending changes predate the snapshot.
                    state.pending = DeltaBatch::default();
                }
                let ready = Status::new(State::Ready);
                if state.status != ready {
                    Self::broadcast(&state, self.status_message(&ready));
                    state.status = ready;
                }
                if !was_synced {
                    Self::broadcast(&state, self.snapshot_message(&state));
                }
                true
            }
            watcher::Event::Apply(obj) => {
                let Some(stored) = prepare(obj, &self.ar, &self.tag) else {
                    return false;
                };
                let previous = state.store.get(&stored.uid);
                if previous.is_some_and(|p| {
                    !p.resource_version.is_empty() && p.resource_version == stored.resource_version
                }) {
                    return false;
                }
                let is_new = previous.is_none();
                let stored = Arc::new(stored);
                state.store.insert(stored.uid.clone(), stored.clone());
                if state.synced {
                    state.pending.upsert(stored, is_new);
                }
                false
            }
            watcher::Event::Delete(obj) => {
                let uid = match &obj.metadata.uid {
                    Some(uid) => uid.clone(),
                    None => format!(
                        "{}/{}",
                        obj.metadata.namespace.as_deref().unwrap_or_default(),
                        obj.metadata.name.as_deref().unwrap_or_default()
                    ),
                };
                if state.store.remove(&uid).is_some() && state.synced {
                    state.pending.delete(&uid);
                }
                false
            }
        }
    }

    /// Turns a completed re-list into deltas against the current store, so
    /// the frontend keeps the identity of unchanged rows.
    fn diff_into_pending(&self, state: &mut EntryState, fresh: HashMap<String, Arc<StoredObject>>) {
        let old = std::mem::take(&mut state.store);
        for (uid, obj) in &fresh {
            match old.get(uid) {
                None => state.pending.upsert(obj.clone(), true),
                Some(previous) if previous.resource_version != obj.resource_version => {
                    state.pending.upsert(obj.clone(), false)
                }
                Some(_) => {}
            }
        }
        for uid in old.keys() {
            if !fresh.contains_key(uid) {
                state.pending.delete(uid);
            }
        }
        state.store = fresh;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::watch::object::tests::{pod, pod_resource, tag};
    use serde_json::Value;

    fn collector() -> (Sink, Arc<Mutex<Vec<Value>>>) {
        let messages = Arc::new(Mutex::new(Vec::new()));
        let sink_messages = messages.clone();
        let sink: Sink = Arc::new(move |m: String| {
            sink_messages.lock().unwrap().push(serde_json::from_str(&m).unwrap());
            true
        });
        (sink, messages)
    }

    fn entry() -> Entry {
        Entry::new(pod_resource(), tag(), "default".into())
    }

    fn sync(entry: &Entry, uids: &[(&str, &str)]) {
        entry.apply(watcher::Event::Init);
        for (uid, rv) in uids {
            entry.apply(watcher::Event::InitApply(pod(uid, rv)));
        }
        entry.apply(watcher::Event::InitDone);
    }

    fn types(messages: &[Value]) -> Vec<String> {
        messages
            .iter()
            .map(|m| match m["type"].as_str().unwrap() {
                "status" => format!("status:{}", m["state"].as_str().unwrap()),
                other => other.to_string(),
            })
            .collect()
    }

    #[test]
    fn subscriber_gets_status_then_snapshot_after_initial_list() {
        let entry = entry();
        let (sink, messages) = collector();
        entry.add_sink(1, sink);
        sync(&entry, &[("a", "1"), ("b", "1")]);

        let messages = messages.lock().unwrap();
        assert_eq!(types(&messages), ["status:syncing", "status:ready", "snapshot"]);
        let snapshot = &messages[2];
        assert_eq!(snapshot["scope"], "default");
        assert_eq!(snapshot["items"].as_array().unwrap().len(), 2);
        assert_eq!(snapshot["items"][0]["metadata"]["context"], "kind-dev");
        assert!(snapshot["items"][0]["metadata"].get("managedFields").is_none());
    }

    #[test]
    fn warm_entry_sends_snapshot_immediately_on_subscribe() {
        let entry = entry();
        sync(&entry, &[("a", "1")]);
        let (sink, messages) = collector();
        entry.add_sink(7, sink);
        assert_eq!(types(&messages.lock().unwrap()), ["status:ready", "snapshot"]);
    }

    #[test]
    fn events_are_batched_until_flush() {
        let entry = entry();
        sync(&entry, &[("a", "1"), ("b", "1")]);
        let (sink, messages) = collector();
        entry.add_sink(1, sink);
        messages.lock().unwrap().clear();

        entry.apply(watcher::Event::Apply(pod("a", "2")));
        entry.apply(watcher::Event::Apply(pod("a", "3")));
        entry.apply(watcher::Event::Apply(pod("c", "1")));
        entry.apply(watcher::Event::Delete(pod("b", "1")));
        // Same resourceVersion again (e.g. watch restart): ignored.
        entry.apply(watcher::Event::Apply(pod("a", "3")));
        assert!(messages.lock().unwrap().is_empty());

        entry.flush();
        let messages = messages.lock().unwrap();
        assert_eq!(messages.len(), 1);
        let delta = &messages[0];
        assert_eq!(delta["type"], "delta");
        assert_eq!(delta["added"][0]["metadata"]["uid"], "c");
        assert_eq!(delta["modified"][0]["metadata"]["resourceVersion"], "3");
        assert_eq!(delta["deleted"], serde_json::json!(["b"]));
        assert_eq!(entry.object_count(), 2);
        assert!(!entry.has_pending());
    }

    #[test]
    fn relist_is_diffed_into_a_delta() {
        let entry = entry();
        sync(&entry, &[("a", "1"), ("b", "1"), ("c", "1")]);
        let (sink, messages) = collector();
        entry.add_sink(1, sink);
        messages.lock().unwrap().clear();

        // 410 Gone -> the watcher re-lists: b changed, c is gone, d is new.
        entry.apply(watcher::Event::Init);
        entry.apply(watcher::Event::InitApply(pod("a", "1")));
        entry.apply(watcher::Event::InitApply(pod("b", "5")));
        entry.apply(watcher::Event::InitApply(pod("d", "1")));
        assert!(entry.apply(watcher::Event::InitDone), "relist flushes immediately");
        entry.flush();

        let messages = messages.lock().unwrap();
        assert_eq!(types(&messages), ["status:relisting", "status:ready", "delta"]);
        let delta = &messages[2];
        assert_eq!(delta["added"][0]["metadata"]["uid"], "d");
        assert_eq!(delta["modified"].as_array().unwrap().len(), 1);
        assert_eq!(delta["modified"][0]["metadata"]["uid"], "b");
        assert_eq!(delta["deleted"], serde_json::json!(["c"]));
    }

    #[test]
    fn sink_ref_counting_tracks_idle_generations() {
        let entry = entry();
        let (sink, _) = collector();
        entry.add_sink(1, sink.clone());
        entry.add_sink(2, sink.clone());
        let generation = entry.lock().idle_generation;

        assert_eq!(entry.remove_sink(1), 1);
        assert!(entry.lock().idle_since.is_none());
        assert_eq!(entry.remove_sink(2), 0);
        assert!(entry.lock().idle_since.is_some());
        assert_eq!(entry.lock().idle_generation, generation + 1);

        // Unknown ids don't bump the generation again.
        assert_eq!(entry.remove_sink(2), 0);
        assert_eq!(entry.lock().idle_generation, generation + 1);

        entry.add_sink(3, sink);
        assert!(entry.lock().idle_since.is_none());
    }

    #[test]
    fn status_changes_are_broadcast_once() {
        let entry = entry();
        let (sink, messages) = collector();
        entry.add_sink(1, sink);
        let forbidden = Status {
            state: State::Forbidden,
            message: Some("pods is forbidden".into()),
            code: Some(403),
            reason: Some("Forbidden".into()),
        };
        entry.set_status(forbidden.clone());
        entry.set_status(forbidden);
        let messages = messages.lock().unwrap();
        assert_eq!(types(&messages), ["status:syncing", "status:forbidden"]);
        assert_eq!(messages[1]["code"], 403);
        assert_eq!(messages[1]["message"], "pods is forbidden");
    }
}

//! The recorder of one cluster: while the app is open it follows the
//! cluster's workloads, nodes, events, ConfigMaps and Secrets and turns
//! what changes into records (see `record`).
//!
//! - Deployments, StatefulSets, DaemonSets, nodes and events come from the
//!   WatchHub through internal sinks, sharing the watchers the views use;
//!   their messages are parsed here, so no object crosses IPC. Hub rows
//!   come without managedFields, so who made a spec change is read back
//!   with one GET of the object.
//! - ConfigMaps and Secrets have watchers of their own: Helm's release
//!   Secrets (large, and Helm history is read from Helm itself) are left
//!   out on the server, only hashes of the values are kept, and the
//!   objects carry their managedFields.
//!
//! Only spec changes count (status churns all the time), plus node
//! condition transitions and the events worth keeping. An object changing
//! more than `NOISY_PER_HOUR` times an hour (a controller rewriting a
//! ConfigMap) stops being recorded until the next start.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::hash::{Hash, Hasher};
use std::sync::Arc;

use chrono::{DateTime, Duration, Utc};
use futures::StreamExt;
use k8s_openapi::apimachinery::pkg::apis::meta::v1::ManagedFieldsEntry;
use kube::api::{Api, ApiResource, DynamicObject, GroupVersionKind};
use kube::runtime::{watcher, WatchStreamExt};
use kube::Client;
use once_cell::sync::Lazy;
use serde_json::{json, Value};
use tauri::async_runtime::JoinHandle;
use tokio::sync::{mpsc, Semaphore};
use tracing::{debug, info, warn};

use super::record::{condition_changes, condition_states, event_record, key_changes, spec_change, Action, ChangeRecord, ObjectId};
use super::store::{now_text, parse_time};
use super::ClusterKey;
use crate::kubernetes::client::client_with_context;
use crate::watch::{self, WatchSink};

/// Hub watchers the recorder may hold across all clusters: its
/// subscriptions never go idle, so they must leave room for the views.
pub const MAX_HUB_WATCHERS: usize = 24;
/// Namespaces watched per data kind and cluster at most.
const MAX_DATA_SCOPES: usize = 8;
const NOISY_PER_HOUR: u32 = 60;
/// A manager's timestamp this much older than the moment a change was
/// seen belongs to an earlier change.
const LOOKUP_SLACK_SECONDS: i64 = 120;
/// Objects created this long before the recorder started are relist
/// artefacts, not creations it saw.
const CREATED_SLACK_SECONDS: i64 = 60;

/// GETs for "who changed it" run two at a time (a Helm upgrade touches
/// many objects at once).
static LOOKUPS: Lazy<Arc<Semaphore>> = Lazy::new(|| Arc::new(Semaphore::new(2)));

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Watched {
    Deployment,
    StatefulSet,
    DaemonSet,
    Node,
    Event,
    ConfigMap,
    Secret,
}

/// Watched through the hub, most useful first (the budget may stop early).
const HUB_KINDS: [Watched; 5] = [Watched::Event, Watched::Deployment, Watched::Node, Watched::StatefulSet, Watched::DaemonSet];
const DATA_KINDS: [Watched; 2] = [Watched::ConfigMap, Watched::Secret];

impl Watched {
    fn kind(self) -> &'static str {
        match self {
            Watched::Deployment => "Deployment",
            Watched::StatefulSet => "StatefulSet",
            Watched::DaemonSet => "DaemonSet",
            Watched::Node => "Node",
            Watched::Event => "Event",
            Watched::ConfigMap => "ConfigMap",
            Watched::Secret => "Secret",
        }
    }

    /// (group, version, plural).
    fn api(self) -> (&'static str, &'static str, &'static str) {
        match self {
            Watched::Deployment => ("apps", "v1", "deployments"),
            Watched::StatefulSet => ("apps", "v1", "statefulsets"),
            Watched::DaemonSet => ("apps", "v1", "daemonsets"),
            Watched::Node => ("", "v1", "nodes"),
            Watched::Event => ("", "v1", "events"),
            Watched::ConfigMap => ("", "v1", "configmaps"),
            Watched::Secret => ("", "v1", "secrets"),
        }
    }

    fn resource(self) -> String {
        match self.api() {
            ("", _, plural) => plural.to_string(),
            (group, _, plural) => format!("{plural}.{group}"),
        }
    }

    fn api_resource(self) -> ApiResource {
        let (group, version, plural) = self.api();
        ApiResource::from_gvk_with_plural(&GroupVersionKind::gvk(group, version, self.kind()), plural)
    }

    fn namespaced(self) -> bool {
        self != Watched::Node
    }

    /// Server-side filters for the data kinds: Helm release and service
    /// account token Secrets, and the cluster autoscaler's status
    /// ConfigMap (rewritten every few seconds).
    fn field_selector(self) -> Option<&'static str> {
        match self {
            Watched::Secret => Some("type!=helm.sh/release.v1,type!=kubernetes.io/service-account-token"),
            Watched::ConfigMap => Some("metadata.name!=cluster-autoscaler-status"),
            _ => None,
        }
    }
}

/// The namespace scopes a kind is watched in: one for all namespaces (or a
/// cluster-scoped kind), else one per namespace.
pub fn scopes(kind: Watched, namespaces: &[String]) -> Vec<Option<String>> {
    if !kind.namespaced() || namespaces.is_empty() || namespaces.iter().any(|ns| ns == "all" || ns.is_empty()) {
        return vec![None];
    }
    let mut list = namespaces.to_vec();
    list.sort();
    list.dedup();
    list.into_iter().map(Some).collect()
}

/// A ConfigMap or Secret as the recorder keeps it: hashes of its values.
#[derive(Debug, Clone)]
pub struct DataObject {
    pub id: ObjectId,
    pub created: String,
    pub keys: BTreeMap<String, u64>,
    /// The latest writer: (manager, time).
    pub writer: Option<(String, String)>,
}

pub enum Message {
    /// A WatchHub message (status, snapshot or delta).
    Hub(Watched, String),
    /// The (re)listed objects of a data kind in a scope ("" = all).
    DataSynced(Watched, String, Vec<DataObject>),
    DataApplied(DataObject),
    DataDeleted(String),
}

#[derive(Debug, PartialEq)]
pub enum Output {
    Record(ChangeRecord),
    /// Find out who made the change of record `id` (a GET of the object).
    Lookup { id: String, kind: Watched, namespace: String, name: String, seen: DateTime<Utc> },
}

struct Tracked {
    id: ObjectId,
    spec: Value,
    conditions: BTreeMap<String, (String, String, String)>,
    keys: BTreeMap<String, u64>,
}

/// What the recorder knows about a cluster's objects; turns messages into
/// records. Pure (no I/O), so it is tested by feeding it messages.
pub struct TargetState {
    started: DateTime<Utc>,
    objects: HashMap<String, Tracked>,
    synced: HashSet<(Watched, String)>,
    /// uid -> (start of the hour, changes in it).
    noise: HashMap<String, (DateTime<Utc>, u32)>,
}

pub fn hash_text(text: &str) -> u64 {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    text.hash(&mut hasher);
    hasher.finish()
}

/// The newest write of anyone but a status writer: (manager, time).
pub fn writer_of(entries: &[ManagedFieldsEntry]) -> Option<(String, String)> {
    entries
        .iter()
        .filter(|e| e.subresource.as_deref() != Some("status"))
        .filter_map(|e| Some((e.manager.clone()?, e.time.as_ref()?.0.to_string())))
        .max_by_key(|(_, time)| parse_time(time))
}

impl TargetState {
    pub fn new(started: DateTime<Utc>) -> Self {
        TargetState { started, objects: HashMap::new(), synced: HashSet::new(), noise: HashMap::new() }
    }

    /// Counts a change of `uid`; false once it changes too often to record.
    fn quiet(&mut self, uid: &str, now: DateTime<Utc>) -> bool {
        let entry = self.noise.entry(uid.to_string()).or_insert((now, 0));
        if now - entry.0 > Duration::hours(1) {
            *entry = (now, 0);
        }
        entry.1 += 1;
        if entry.1 == NOISY_PER_HOUR + 1 {
            info!("Changes: {uid} changes more than {NOISY_PER_HOUR} times an hour; no longer recording it");
        }
        entry.1 <= NOISY_PER_HOUR
    }

    fn created_recently(&self, created: &str) -> bool {
        parse_time(created).is_some_and(|t| t >= self.started - Duration::seconds(CREATED_SLACK_SECONDS))
    }

    pub fn apply(&mut self, message: Message, now: DateTime<Utc>) -> Vec<Output> {
        match message {
            Message::Hub(kind, text) => self.apply_hub(kind, &text, now),
            Message::DataSynced(kind, scope, objects) => self.data_synced(kind, scope, objects, now),
            Message::DataApplied(object) => self.data_applied(object, now),
            Message::DataDeleted(uid) => self.deleted(&uid, now),
        }
    }

    fn apply_hub(&mut self, kind: Watched, text: &str, now: DateTime<Utc>) -> Vec<Output> {
        let Ok(message) = serde_json::from_str::<Value>(text) else {
            return Vec::new();
        };
        let items = |key: &str| message[key].as_array().cloned().unwrap_or_default();
        let mut out = Vec::new();
        match message["type"].as_str() {
            Some("snapshot") => {
                for item in items("items") {
                    if kind == Watched::Event {
                        out.extend(event_record(&item).map(Output::Record));
                    } else {
                        // A second snapshot (a re-subscribe) is compared, the first is the baseline.
                        out.extend(self.hub_upsert(kind, &item, now, false));
                    }
                }
            }
            Some("delta") => {
                for item in items("added").iter().chain(items("modified").iter()) {
                    if kind == Watched::Event {
                        out.extend(event_record(item).map(Output::Record));
                    } else {
                        out.extend(self.hub_upsert(kind, item, now, true));
                    }
                }
                if kind != Watched::Event {
                    for uid in items("deleted").iter().filter_map(Value::as_str) {
                        out.extend(self.deleted(uid, now));
                    }
                }
            }
            _ => {}
        }
        out
    }

    fn hub_upsert(&mut self, kind: Watched, object: &Value, now: DateTime<Utc>, live: bool) -> Vec<Output> {
        let id = ObjectId::of(kind.kind(), object);
        if id.uid.is_empty() {
            return Vec::new();
        }
        let spec = object["spec"].clone();
        let conditions = if kind == Watched::Node { condition_states(object) } else { BTreeMap::new() };
        let revision = object["metadata"]["resourceVersion"].as_str().unwrap_or_default().to_string();
        let at = now_text(now);
        let lookup = |record_id: &str| Output::Lookup {
            id: record_id.to_string(),
            kind,
            namespace: id.namespace.clone(),
            name: id.name.clone(),
            seen: now,
        };

        let mut out = Vec::new();
        match self.objects.get(&id.uid) {
            None => {
                let created = object["metadata"]["creationTimestamp"].as_str().unwrap_or_default();
                if live && self.created_recently(created) {
                    let record = id.record(format!("{}:created", id.uid), created.to_string(), Action::Created);
                    out.push(lookup(&record.id));
                    out.push(Output::Record(record));
                }
            }
            Some(previous) => {
                let changed = spec_change(&id, &previous.spec, &spec, &at, &revision);
                let transitions = condition_changes(&id, &previous.conditions, &conditions, &at);
                if (changed.is_some() || !transitions.is_empty()) && self.quiet(&id.uid, now) {
                    if let Some(record) = changed {
                        out.push(lookup(&record.id));
                        out.push(Output::Record(record));
                    }
                    out.extend(transitions.into_iter().map(Output::Record));
                }
            }
        }
        self.objects.insert(id.uid.clone(), Tracked { id, spec, conditions, keys: BTreeMap::new() });
        out
    }

    fn deleted(&mut self, uid: &str, now: DateTime<Utc>) -> Vec<Output> {
        match self.objects.remove(uid) {
            Some(tracked) => {
                let at = now_text(now);
                vec![Output::Record(tracked.id.record(format!("{uid}:deleted"), at, Action::Deleted))]
            }
            None => Vec::new(),
        }
    }

    fn data_synced(&mut self, kind: Watched, scope: String, objects: Vec<DataObject>, now: DateTime<Utc>) -> Vec<Output> {
        let first = self.synced.insert((kind, scope.clone()));
        let mut out = Vec::new();
        if !first {
            // A relist after a disconnect: what disappeared meanwhile was deleted.
            let present: HashSet<&str> = objects.iter().map(|o| o.id.uid.as_str()).collect();
            let gone: Vec<String> = self
                .objects
                .values()
                .filter(|t| t.id.kind == kind.kind() && (scope.is_empty() || t.id.namespace == scope))
                .filter(|t| !present.contains(t.id.uid.as_str()))
                .map(|t| t.id.uid.clone())
                .collect();
            for uid in gone {
                out.extend(self.deleted(&uid, now));
            }
        }
        for object in objects {
            if first {
                self.objects.insert(
                    object.id.uid.clone(),
                    Tracked { id: object.id, spec: Value::Null, conditions: BTreeMap::new(), keys: object.keys },
                );
            } else {
                out.extend(self.data_applied(object, now));
            }
        }
        out
    }

    fn data_applied(&mut self, object: DataObject, now: DateTime<Utc>) -> Vec<Output> {
        let uid = object.id.uid.clone();
        // The manager's own time when it is this change's; else when it was seen.
        let (by, at) = match &object.writer {
            Some((manager, time)) if parse_time(time).is_some_and(|t| now - t <= Duration::seconds(LOOKUP_SLACK_SECONDS)) => {
                (Some(manager.clone()), time.clone())
            }
            _ => (None, now_text(now)),
        };
        let mut out = Vec::new();
        match self.objects.get(&uid) {
            None => {
                if self.created_recently(&object.created) {
                    let mut record = object.id.record(format!("{uid}:created"), object.created.clone(), Action::Created);
                    record.by = object.writer.as_ref().map(|(manager, _)| manager.clone());
                    out.push(Output::Record(record));
                }
            }
            Some(previous) => {
                if let Some(keys) = key_changes(&previous.keys, &object.keys) {
                    if self.quiet(&uid, now) {
                        let mut record = object.id.record(format!("{uid}:{}", hash_text(&format!("{at}{keys:?}"))), at, Action::Updated);
                        record.by = by;
                        record.keys = Some(keys);
                        out.push(Output::Record(record));
                    }
                }
            }
        }
        self.objects.insert(uid, Tracked { id: object.id, spec: Value::Null, conditions: BTreeMap::new(), keys: object.keys });
        out
    }
}

/* ------------------------------------------------------------ running -- */

/// A running recorder: its hub subscriptions and tasks.
pub struct Running {
    pub namespaces: Vec<String>,
    pub subscriptions: Vec<u64>,
    pub tasks: Vec<JoinHandle<()>>,
    /// Hub watchers it holds (against `MAX_HUB_WATCHERS`).
    pub hub_watchers: usize,
    /// Every part started; when not, a later track tries again.
    pub complete: bool,
}

impl Running {
    pub fn stop(self) {
        for id in self.subscriptions {
            watch::watch_unsubscribe(id);
        }
        for task in self.tasks {
            task.abort();
        }
    }
}

fn hub_request(key: &ClusterKey, kind: Watched, namespaces: &[String]) -> Option<watch::WatchRequest> {
    serde_json::from_value(json!({
        "kubeConfig": key.kube_config,
        "context": key.context,
        "resource": kind.resource(),
        "kind": kind.kind(),
        "namespaces": namespaces,
    }))
    .ok()
}

/// Starts recording a cluster. `budget`: hub watchers it may take.
pub async fn start(key: ClusterKey, namespaces: Vec<String>, budget: usize) -> Running {
    let (tx, rx) = mpsc::unbounded_channel::<Message>();
    let mut running = Running { namespaces: namespaces.clone(), subscriptions: Vec::new(), tasks: Vec::new(), hub_watchers: 0, complete: true };

    for kind in HUB_KINDS {
        let needed = scopes(kind, &namespaces).len();
        if running.hub_watchers + needed > budget {
            info!("Changes: not recording {} in {} (too many watches)", kind.kind(), key.context);
            continue;
        }
        let Some(request) = hub_request(&key, kind, &namespaces) else { continue };
        let sender = tx.clone();
        let sink: WatchSink = Arc::new(move |message: String| sender.send(Message::Hub(kind, message)).is_ok());
        match watch::subscribe(request, sink).await {
            Ok(subscription) => {
                running.subscriptions.push(subscription.id);
                running.hub_watchers += needed;
            }
            Err(e) => {
                warn!("Changes: can't follow {} in {}: {}", kind.kind(), key.context, e);
                running.complete = false;
            }
        }
    }

    match client_with_context(&key.context, Some(&key.kube_config)).await {
        Ok(client) => {
            for kind in DATA_KINDS {
                for scope in scopes(kind, &namespaces).into_iter().take(MAX_DATA_SCOPES) {
                    let task = tauri::async_runtime::spawn(watch_data(client.clone(), key.context.clone(), kind, scope, tx.clone()));
                    running.tasks.push(task);
                }
            }
        }
        Err(e) => {
            warn!("Changes: can't follow ConfigMaps and Secrets in {}: {}", key.context, e.message);
            running.complete = false;
        }
    }

    running.tasks.push(tauri::async_runtime::spawn(process(key, rx)));
    running
}

async fn process(key: ClusterKey, mut rx: mpsc::UnboundedReceiver<Message>) {
    let mut state = TargetState::new(Utc::now());
    while let Some(message) = rx.recv().await {
        for output in state.apply(message, Utc::now()) {
            match output {
                Output::Record(record) => super::add_record(&key, record),
                Output::Lookup { id, kind, namespace, name, seen } => {
                    tauri::async_runtime::spawn(lookup(key.clone(), id, kind, namespace, name, seen));
                }
            }
        }
    }
}

/// Reads who made a change from the object's managedFields.
async fn lookup(key: ClusterKey, id: String, kind: Watched, namespace: String, name: String, seen: DateTime<Utc>) {
    let Ok(_permit) = LOOKUPS.clone().acquire_owned().await else { return };
    let Ok(client) = client_with_context(&key.context, Some(&key.kube_config)).await else { return };
    let ar = kind.api_resource();
    let api: Api<DynamicObject> =
        if kind.namespaced() { Api::namespaced_with(client, &namespace, &ar) } else { Api::all_with(client, &ar) };
    let object = match api.get(&name).await {
        Ok(object) => object,
        Err(e) => {
            debug!("Changes: who changed {} {}? {}", kind.kind(), name, e);
            return;
        }
    };
    let Some((manager, time)) = writer_of(object.metadata.managed_fields.as_deref().unwrap_or_default()) else { return };
    let fresh = parse_time(&time).is_some_and(|t| seen - t <= Duration::seconds(LOOKUP_SLACK_SECONDS));
    if fresh {
        super::set_by(&key, &id, &manager, Some(&time));
    }
}

fn data_object(kind: Watched, object: &DynamicObject) -> Option<DataObject> {
    let meta = &object.metadata;
    let mut keys = BTreeMap::new();
    for field in ["data", "binaryData"] {
        if let Some(map) = object.data.get(field).and_then(Value::as_object) {
            for (key, value) in map {
                keys.insert(key.clone(), hash_text(value.as_str().unwrap_or_default()));
            }
        }
    }
    Some(DataObject {
        id: ObjectId {
            kind: kind.kind().to_string(),
            name: meta.name.clone()?,
            namespace: meta.namespace.clone().unwrap_or_default(),
            uid: meta.uid.clone()?,
        },
        created: meta.creation_timestamp.as_ref().map(|t| t.0.to_string()).unwrap_or_default(),
        keys,
        writer: writer_of(meta.managed_fields.as_deref().unwrap_or_default()),
    })
}

/// Permission and credential failures end a data watch; anything else is
/// retried with the watcher's backoff.
fn terminal(error: &watcher::Error) -> bool {
    match error {
        watcher::Error::InitialListFailed(e) | watcher::Error::WatchStartFailed(e) | watcher::Error::WatchFailed(e) => {
            matches!(e, kube::Error::Api(status) if status.code == 401 || status.code == 403)
                || crate::auth::center::AuthFailure::of_kube_error(e).is_some()
        }
        watcher::Error::WatchError(status) => status.code == 401 || status.code == 403,
        watcher::Error::NoResourceVersion => false,
    }
}

async fn watch_data(client: Client, context: String, kind: Watched, scope: Option<String>, tx: mpsc::UnboundedSender<Message>) {
    let ar = kind.api_resource();
    let api: Api<DynamicObject> = match &scope {
        Some(ns) => Api::namespaced_with(client, ns, &ar),
        None => Api::all_with(client, &ar),
    };
    let mut config = watcher::Config::default().any_semantic();
    if let Some(fields) = kind.field_selector() {
        config = config.fields(fields);
    }
    let stream = watcher(api, config).default_backoff();
    futures::pin_mut!(stream);
    let scope = scope.unwrap_or_default();
    let mut relist: Vec<DataObject> = Vec::new();
    let mut warned = false;
    while let Some(event) = stream.next().await {
        let message = match event {
            Ok(watcher::Event::Init) => {
                relist.clear();
                None
            }
            Ok(watcher::Event::InitApply(object)) => {
                relist.extend(data_object(kind, &object));
                None
            }
            Ok(watcher::Event::InitDone) => Some(Message::DataSynced(kind, scope.clone(), std::mem::take(&mut relist))),
            Ok(watcher::Event::Apply(object)) => data_object(kind, &object).map(Message::DataApplied),
            Ok(watcher::Event::Delete(object)) => object.metadata.uid.clone().map(Message::DataDeleted),
            Err(e) => {
                if terminal(&e) {
                    info!("Changes: not following {}s in {} [{}]: {}", kind.kind(), context, scope, e);
                    return;
                }
                if !warned {
                    warn!("Changes: {}s in {} [{}]: {} (retrying)", kind.kind(), context, scope, e);
                    warned = true;
                }
                None
            }
        };
        if let Some(message) = message {
            warned = false;
            if tx.send(message).is_err() {
                return;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::changes::store::parse_time;

    fn at(minutes: i64) -> DateTime<Utc> {
        parse_time("2026-10-31T12:00:00Z").unwrap() + Duration::minutes(minutes)
    }

    fn deployment(uid: &str, rv: &str, image: &str, created: &str) -> Value {
        json!({
            "kind": "Deployment",
            "metadata": {"name": "checkout-api", "namespace": "checkout", "uid": uid, "resourceVersion": rv, "creationTimestamp": created},
            "spec": {"replicas": 3, "template": {"spec": {"containers": [{"name": "api", "image": image}]}}},
            "status": {"readyReplicas": 3}
        })
    }

    fn records(outputs: &[Output]) -> Vec<&ChangeRecord> {
        outputs.iter().filter_map(|o| if let Output::Record(r) = o { Some(r) } else { None }).collect()
    }

    #[test]
    fn hub_snapshot_is_the_baseline_and_deltas_are_changes() {
        let mut state = TargetState::new(at(0));
        let snapshot = json!({"type": "snapshot", "scope": "", "items": [deployment("u1", "1", "api:1", "2026-01-01T00:00:00Z")]});
        assert!(state.apply(Message::Hub(Watched::Deployment, snapshot.to_string()), at(1)).is_empty());

        // Status only: nothing.
        let mut status_only = deployment("u1", "2", "api:1", "2026-01-01T00:00:00Z");
        status_only["status"]["readyReplicas"] = json!(2);
        let delta = json!({"type": "delta", "scope": "", "added": [], "modified": [status_only], "deleted": []});
        assert!(state.apply(Message::Hub(Watched::Deployment, delta.to_string()), at(2)).is_empty());

        let delta = json!({"type": "delta", "scope": "", "added": [], "modified": [deployment("u1", "3", "api:2", "2026-01-01T00:00:00Z")], "deleted": []});
        let outputs = state.apply(Message::Hub(Watched::Deployment, delta.to_string()), at(3));
        let changes = records(&outputs);
        assert_eq!(changes.len(), 1);
        assert_eq!(changes[0].id, "u1:3");
        assert_eq!(changes[0].fields[0].path.join("."), "template.spec.containers.[api].image");
        assert!(outputs.iter().any(|o| matches!(o, Output::Lookup { id, .. } if id == "u1:3")));

        let delta = json!({"type": "delta", "scope": "", "added": [], "modified": [], "deleted": ["u1"]});
        let outputs = state.apply(Message::Hub(Watched::Deployment, delta.to_string()), at(4));
        assert_eq!(records(&outputs)[0].action, Action::Deleted);
    }

    #[test]
    fn only_new_objects_count_as_created() {
        let mut state = TargetState::new(at(0));
        let old = deployment("u1", "1", "api:1", "2026-01-01T00:00:00Z");
        let new = deployment("u2", "1", "api:1", &now_text(at(5)));
        let delta = json!({"type": "delta", "scope": "", "added": [old, new], "modified": [], "deleted": []});
        let outputs = state.apply(Message::Hub(Watched::Deployment, delta.to_string()), at(5));
        let created = records(&outputs);
        assert_eq!(created.len(), 1);
        assert_eq!((created[0].uid.as_str(), created[0].action), ("u2", Action::Created));
    }

    #[test]
    fn events_are_recorded_from_snapshots_and_deltas() {
        let mut state = TargetState::new(at(0));
        let event = json!({
            "metadata": {"uid": "e1", "namespace": "checkout"},
            "involvedObject": {"kind": "Pod", "name": "p"},
            "type": "Warning", "reason": "BackOff", "message": "Back-off", "count": 3,
            "lastTimestamp": "2026-10-31T11:50:00Z"
        });
        let snapshot = json!({"type": "snapshot", "scope": "", "items": [event]});
        assert_eq!(records(&state.apply(Message::Hub(Watched::Event, snapshot.to_string()), at(1))).len(), 1);
        let delta = json!({"type": "delta", "scope": "", "added": [], "modified": [event], "deleted": ["e1"]});
        assert_eq!(records(&state.apply(Message::Hub(Watched::Event, delta.to_string()), at(2))).len(), 1);
    }

    fn data(uid: &str, keys: &[(&str, &str)], writer: Option<(&str, DateTime<Utc>)>) -> DataObject {
        DataObject {
            id: ObjectId { kind: "Secret".into(), name: "db".into(), namespace: "payments".into(), uid: uid.into() },
            created: "2026-01-01T00:00:00Z".into(),
            keys: keys.iter().map(|(k, v)| (k.to_string(), hash_text(v))).collect(),
            writer: writer.map(|(m, t)| (m.to_string(), now_text(t))),
        }
    }

    #[test]
    fn data_edits_name_the_keys_and_the_writer() {
        let mut state = TargetState::new(at(0));
        let synced = Message::DataSynced(Watched::Secret, "".into(), vec![data("s1", &[("password", "a"), ("user", "u")], None)]);
        assert!(state.apply(synced, at(1)).is_empty());

        let edited = data("s1", &[("password", "b"), ("user", "u")], Some(("kubectl-edit", at(2))));
        let outputs = state.apply(Message::DataApplied(edited), at(2));
        let record = records(&outputs)[0];
        assert_eq!(record.keys.as_ref().unwrap().changed, ["password"]);
        assert_eq!((record.by.as_deref(), record.at.clone()), (Some("kubectl-edit"), now_text(at(2))));
        let text = serde_json::to_string(record).unwrap();
        assert!(!text.contains("\"b\"") && !text.contains(&hash_text("b").to_string()), "no values or hashes in a record");

        // A relist that misses it: deleted while disconnected.
        let relist = Message::DataSynced(Watched::Secret, "".into(), vec![]);
        assert_eq!(records(&state.apply(relist, at(3)))[0].action, Action::Deleted);
    }

    #[test]
    fn noisy_objects_stop_being_recorded() {
        let mut state = TargetState::new(at(0));
        state.apply(Message::DataSynced(Watched::ConfigMap, "".into(), vec![data("c", &[("k", "0")], None)]), at(0));
        let recorded = (1..=NOISY_PER_HOUR + 5)
            .filter(|i| {
                let object = data("c", &[("k", &i.to_string())], None);
                !state.apply(Message::DataApplied(object), at(0) + Duration::seconds(*i as i64)).is_empty()
            })
            .count();
        assert_eq!(recorded as u32, NOISY_PER_HOUR);
    }

    #[test]
    fn the_newest_non_status_write_is_the_writer() {
        let entry = |manager: &str, time: &str, subresource: Option<&str>| ManagedFieldsEntry {
            manager: Some(manager.into()),
            time: Some(k8s_openapi::apimachinery::pkg::apis::meta::v1::Time(time.parse().unwrap())),
            subresource: subresource.map(str::to_string),
            ..Default::default()
        };
        let entries = [
            entry("helm", "2026-10-31T10:00:00Z", None),
            entry("kube-controller-manager", "2026-10-31T12:00:00Z", Some("status")),
            entry("kubectl-edit", "2026-10-31T11:00:00Z", None),
        ];
        assert_eq!(writer_of(&entries), Some(("kubectl-edit".into(), "2026-10-31T11:00:00Z".into())));
        assert_eq!(writer_of(&[]), None);
    }

    #[test]
    fn scopes_follow_the_namespace_selection() {
        assert_eq!(scopes(Watched::Deployment, &["b".into(), "a".into(), "b".into()]), [Some("a".into()), Some("b".into())]);
        assert_eq!(scopes(Watched::Node, &["a".into()]), [None]);
        assert_eq!(scopes(Watched::Event, &["all".into()]), [None]);
    }
}

//! The change history of one cluster: the records, folded where the same
//! object changed again shortly after, the times the recorder ran (so the
//! front end can say what was recorded and when), and the caps: by age, by
//! count (events give way first) and by size.
//!
//! On disk it is one JSON file per cluster, named by a hash of its
//! kubeconfig and context.

use std::path::Path;

use chrono::{DateTime, Duration, SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::record::{replicas_only, Action, ChangeRecord};

/// Records older than this are dropped.
pub const MAX_AGE_DAYS: i64 = 14;
pub const MAX_RECORDS: usize = 4000;
/// Past `MAX_RECORDS`, events go first (oldest first), down to this many.
pub const MIN_EVENTS: usize = 1000;
/// The file stays below this many bytes.
pub const MAX_BYTES: usize = 2 * 1024 * 1024;
const MAX_SESSIONS: usize = 100;
/// The same object changing again this soon is one change.
const MERGE_SECONDS: i64 = 60;
/// Scaling (an autoscaler, `kubectl scale`) and data edits fold for longer:
/// they come in bursts.
const SCALE_MERGE_SECONDS: i64 = 600;
const DATA_MERGE_SECONDS: i64 = 300;
/// How far back an update looks for one to fold into.
const MERGE_LOOKBACK: usize = 200;

pub fn now_text(now: DateTime<Utc>) -> String {
    now.to_rfc3339_opts(SecondsFormat::Secs, true)
}

pub fn parse_time(text: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(text).ok().map(|t| t.with_timezone(&Utc))
}

/// The file of a cluster's history.
pub fn file_name(kube_config: &str, context: &str) -> String {
    let digest = Sha256::digest(format!("{kube_config}\u{0}{context}").as_bytes());
    let hex: String = digest.iter().take(10).map(|b| format!("{b:02x}")).collect();
    format!("{hex}.json")
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Session {
    pub from: String,
    pub to: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClusterHistory {
    #[serde(default)]
    pub version: u32,
    #[serde(default)]
    pub context: String,
    #[serde(default)]
    pub kube_config: String,
    /// When the recorder ran for this cluster, oldest first.
    #[serde(default)]
    pub sessions: Vec<Session>,
    #[serde(default)]
    pub records: Vec<ChangeRecord>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ObjectFilter {
    pub kind: String,
    pub name: String,
    #[serde(default)]
    pub namespace: String,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Query {
    /// Only records at or after this time (RFC 3339).
    #[serde(default)]
    pub since: Option<String>,
    /// Namespaces to include; empty or "all" = every namespace. Records of
    /// cluster-scoped objects are always included.
    #[serde(default)]
    pub namespaces: Vec<String>,
    /// Only these objects (any when empty).
    #[serde(default)]
    pub objects: Vec<ObjectFilter>,
}

fn seconds_between(a: &str, b: &str) -> Option<i64> {
    Some((parse_time(b)? - parse_time(a)?).num_seconds().abs())
}

/// Folds `later` into `earlier`: the oldest value of each field is kept,
/// with the newest after it; fields that went back to where they were drop
/// out.
fn fold(earlier: &mut ChangeRecord, later: ChangeRecord) {
    for field in later.fields {
        match earlier.fields.iter_mut().find(|f| f.path == field.path) {
            Some(existing) => existing.to = field.to,
            None => earlier.fields.push(field),
        }
    }
    earlier.fields.retain(|f| f.from != f.to);
    earlier.more |= later.more;
    match (&mut earlier.keys, later.keys) {
        (Some(keys), Some(more)) => keys.merge(&more),
        (keys @ None, more) => *keys = more,
        _ => {}
    }
    if later.by.is_some() {
        earlier.by = later.by;
    }
    earlier.at = later.at;
    earlier.count += later.count;
}

impl ClusterHistory {
    pub fn new(context: &str, kube_config: &str) -> Self {
        ClusterHistory {
            version: 1,
            context: context.to_string(),
            kube_config: kube_config.to_string(),
            ..Default::default()
        }
    }

    /// Adds a record: replaces one with the same id (an event seen again),
    /// folds it into a recent update of the same object, or appends it.
    pub fn add(&mut self, record: ChangeRecord) {
        if let Some(existing) = self.records.iter_mut().find(|r| r.id == record.id) {
            let by = existing.by.take();
            *existing = record;
            if existing.by.is_none() {
                existing.by = by;
            }
            return;
        }
        if record.action == Action::Updated && !record.uid.is_empty() {
            let recent = self
                .records
                .iter_mut()
                .rev()
                .take(MERGE_LOOKBACK)
                .find(|r| r.uid == record.uid && r.action == Action::Updated);
            if let Some(earlier) = recent {
                let window = if earlier.keys.is_some() && record.keys.is_some() {
                    DATA_MERGE_SECONDS
                } else if replicas_only(earlier) && replicas_only(&record) {
                    SCALE_MERGE_SECONDS
                } else {
                    MERGE_SECONDS
                };
                if seconds_between(&earlier.at, &record.at).is_some_and(|s| s <= window) {
                    fold(earlier, record);
                    return;
                }
            }
        }
        self.records.push(record);
    }

    /// Who made a change, once known; `at` corrects its time (the
    /// manager's own timestamp beats the moment the change was seen).
    pub fn set_by(&mut self, id: &str, by: &str, at: Option<&str>) -> bool {
        let Some(record) = self.records.iter_mut().find(|r| r.id == id) else {
            return false;
        };
        record.by = Some(by.to_string());
        if let Some(at) = at {
            record.at = at.to_string();
        }
        true
    }

    pub fn begin_session(&mut self, now: DateTime<Utc>) {
        let at = now_text(now);
        self.sessions.push(Session { from: at.clone(), to: at });
    }

    /// The current session lasts until `now`.
    pub fn extend_session(&mut self, now: DateTime<Utc>) {
        if let Some(session) = self.sessions.last_mut() {
            session.to = now_text(now);
        }
    }

    /// Applies the caps. Records are kept oldest first.
    pub fn prune(&mut self, now: DateTime<Utc>) {
        let cutoff = now - Duration::days(MAX_AGE_DAYS);
        let fresh = |at: &str| parse_time(at).is_some_and(|t| t >= cutoff);
        self.records.retain(|r| fresh(&r.at));
        self.records.sort_by_key(|r| parse_time(&r.at));

        let events = self.records.iter().filter(|r| r.action == Action::Event).count();
        if self.records.len() > MAX_RECORDS && events > MIN_EVENTS {
            let mut drop = (events - MIN_EVENTS).min(self.records.len() - MAX_RECORDS);
            self.records.retain(|r| {
                if drop > 0 && r.action == Action::Event {
                    drop -= 1;
                    return false;
                }
                true
            });
        }
        if self.records.len() > MAX_RECORDS {
            let excess = self.records.len() - MAX_RECORDS;
            self.records.drain(..excess);
        }

        // Newest first until the size cap.
        let mut size = 0;
        let mut keep = self.records.len();
        for (index, record) in self.records.iter().enumerate().rev() {
            size += serde_json::to_string(record).map(|t| t.len() + 1).unwrap_or(0);
            if size > MAX_BYTES {
                break;
            }
            keep = index;
        }
        self.records.drain(..keep);

        self.sessions.retain(|s| fresh(&s.to));
        if self.sessions.len() > MAX_SESSIONS {
            let excess = self.sessions.len() - MAX_SESSIONS;
            self.sessions.drain(..excess);
        }
    }

    /// The records a query asks for, newest first.
    pub fn query(&self, query: &Query) -> Vec<ChangeRecord> {
        let since = query.since.as_deref().and_then(parse_time);
        let all = query.namespaces.is_empty() || query.namespaces.iter().any(|ns| ns == "all" || ns.is_empty());
        let mut records: Vec<ChangeRecord> = self
            .records
            .iter()
            .filter(|r| all || r.namespace.is_empty() || query.namespaces.contains(&r.namespace))
            .filter(|r| since.is_none_or(|since| parse_time(&r.at).is_some_and(|t| t >= since)))
            .filter(|r| {
                query.objects.is_empty()
                    || query.objects.iter().any(|o| o.kind == r.kind && o.name == r.name && o.namespace == r.namespace)
            })
            .cloned()
            .collect();
        records.sort_by_key(|r| std::cmp::Reverse(parse_time(&r.at)));
        records
    }
}

pub fn load(path: &Path) -> Option<ClusterHistory> {
    let text = std::fs::read_to_string(path).ok()?;
    match serde_json::from_str(&text) {
        Ok(history) => Some(history),
        Err(e) => {
            tracing::warn!("The change history {} can't be read ({}); starting over", path.display(), e);
            None
        }
    }
}

pub fn save(path: &Path, history: &ClusterHistory) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        jp_auth_core::paths::ensure_private_dir(dir).map_err(|e| format!("{} can't be created: {e}", dir.display()))?;
    }
    let text = serde_json::to_string(history).map_err(|e| e.to_string())?;
    jp_auth_core::fsutil::write_atomic(path, text.as_bytes(), 0o600).map_err(|e| format!("{} can't be written: {e}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::changes::diff::FieldChange;
    use crate::changes::record::{KeyChanges, ObjectId};
    use serde_json::json;

    fn t(minutes: i64) -> String {
        now_text(base() + Duration::minutes(minutes))
    }

    fn base() -> DateTime<Utc> {
        parse_time("2026-10-31T12:00:00Z").unwrap()
    }

    fn update(uid: &str, at: String, path: &str, from: i64, to: i64) -> ChangeRecord {
        static IDS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let id = ObjectId { kind: "Deployment".into(), name: format!("d-{uid}"), namespace: "ns".into(), uid: uid.into() };
        let serial = IDS.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let mut record = id.record(format!("{uid}:{serial}"), at, Action::Updated);
        record.fields = vec![FieldChange { path: vec![path.into()], from: Some(json!(from)), to: Some(json!(to)) }];
        record
    }

    #[test]
    fn quick_successive_updates_fold_into_one() {
        let mut history = ClusterHistory::new("ctx", "/kc");
        history.add(update("a", t(0), "paused", 0, 1));
        history.add(update("a", t(0), "replicas", 3, 4));
        history.add(update("b", t(0), "replicas", 1, 2));
        assert_eq!(history.records.len(), 2);
        let folded = &history.records[0];
        assert_eq!((folded.count, folded.fields.len()), (2, 2));

        // Scaling folds for ten minutes, ending where it ended.
        history.add(update("b", t(5), "replicas", 2, 3));
        assert_eq!(history.records.len(), 2);
        assert_eq!(history.records[1].fields[0].to, Some(json!(3)));
        assert_eq!(history.records[1].fields[0].from, Some(json!(1)));

        // Later, or a template change after scaling: separate changes.
        history.add(update("a", t(30), "replicas", 4, 5));
        history.add(update("b", t(7), "image", 1, 2));
        assert_eq!(history.records.len(), 4);
    }

    #[test]
    fn a_change_and_its_revert_keep_no_fields() {
        let mut history = ClusterHistory::new("ctx", "/kc");
        history.add(update("a", t(0), "replicas", 3, 4));
        history.add(update("a", t(0), "replicas", 4, 3));
        assert_eq!(history.records.len(), 1);
        assert!(history.records[0].fields.is_empty());
        assert_eq!(history.records[0].count, 2);
    }

    #[test]
    fn data_edits_fold_their_keys() {
        let mut history = ClusterHistory::new("ctx", "/kc");
        let data = |at: String, keys: KeyChanges| {
            let id = ObjectId { kind: "Secret".into(), name: "db".into(), namespace: "ns".into(), uid: "s".into() };
            let mut record = id.record(format!("s:{at}"), at, Action::Updated);
            record.keys = Some(keys);
            record
        };
        history.add(data(t(0), KeyChanges { changed: vec!["password".into()], ..Default::default() }));
        history.add(data(t(2), KeyChanges { added: vec!["user".into()], ..Default::default() }));
        assert_eq!(history.records.len(), 1);
        let keys = history.records[0].keys.as_ref().unwrap();
        assert_eq!((keys.changed.as_slice(), keys.added.as_slice()), (["password".to_string()].as_slice(), ["user".to_string()].as_slice()));
    }

    #[test]
    fn events_are_replaced_by_id_and_keep_their_manager() {
        let mut history = ClusterHistory::new("ctx", "/kc");
        let id = ObjectId { kind: "Pod".into(), name: "p".into(), namespace: "ns".into(), uid: "p".into() };
        let mut first = id.record("event:e".into(), t(0), Action::Event);
        first.by = Some("kubelet".into());
        history.add(first);
        history.add(id.record("event:e".into(), t(5), Action::Event));
        assert_eq!(history.records.len(), 1);
        assert_eq!(history.records[0].at, t(5));
        assert_eq!(history.records[0].by.as_deref(), Some("kubelet"));

        assert!(history.set_by("event:e", "kubelet", None));
        assert!(!history.set_by("nope", "x", None));
    }

    #[test]
    fn caps_drop_old_records_and_events_first() {
        let mut history = ClusterHistory::new("ctx", "/kc");
        let now = base() + Duration::days(20);
        history.add(update("old", t(0), "replicas", 1, 2));
        let id = ObjectId { kind: "Pod".into(), name: "p".into(), namespace: "ns".into(), uid: "p".into() };
        let recent = now - Duration::days(1);
        for i in 0..3100 {
            history.records.push(id.record(format!("event:{i}"), now_text(recent + Duration::seconds(i as i64)), Action::Event));
        }
        for i in 0..2000 {
            history.records.push(update(&format!("u{i}"), now_text(recent + Duration::seconds(i)), "replicas", 1, 2));
        }
        history.prune(now);
        assert!(!history.records.iter().any(|r| r.uid == "old"), "older than the max age");
        assert_eq!(history.records.len(), MAX_RECORDS);
        assert_eq!(history.records.iter().filter(|r| r.action == Action::Updated).count(), 2000, "events went first");
    }

    #[test]
    fn queries_filter_by_namespace_time_and_object() {
        let mut history = ClusterHistory::new("ctx", "/kc");
        history.add(update("a", t(0), "replicas", 1, 2));
        history.add(update("b", t(10), "replicas", 1, 2));
        let node = ObjectId { kind: "Node".into(), name: "n1".into(), uid: "n".into(), ..Default::default() };
        history.add(node.record("n:1".into(), t(20), Action::Condition));

        let all = history.query(&Query::default());
        assert_eq!(all.iter().map(|r| r.at.clone()).collect::<Vec<_>>(), [t(20), t(10), t(0)], "newest first");
        let other = history.query(&Query { namespaces: vec!["other".into()], ..Default::default() });
        assert_eq!(other.len(), 1, "cluster-scoped records always match");
        let since = history.query(&Query { since: Some(t(5)), ..Default::default() });
        assert_eq!(since.len(), 2);
        let one = history.query(&Query {
            objects: vec![ObjectFilter { kind: "Deployment".into(), name: "d-a".into(), namespace: "ns".into() }],
            ..Default::default()
        });
        assert_eq!(one.len(), 1);
    }

    #[test]
    fn history_round_trips_through_its_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("changes").join(file_name("/kc", "ctx"));
        let mut history = ClusterHistory::new("ctx", "/kc");
        history.begin_session(base());
        history.extend_session(base() + Duration::minutes(5));
        history.add(update("a", t(0), "replicas", 1, 2));
        save(&path, &history).unwrap();

        let loaded = load(&path).unwrap();
        assert_eq!(loaded.records, history.records);
        assert_eq!(loaded.sessions, [Session { from: t(0), to: t(5) }]);
        assert!(load(&dir.path().join("missing.json")).is_none());
        assert_ne!(file_name("/kc", "ctx"), file_name("/kc", "other"));
    }
}

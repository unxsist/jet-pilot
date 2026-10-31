//! What the recorder keeps: one record per change it saw, and the pure
//! rules that turn two versions of an object (or an event) into records.
//!
//! Records never hold a ConfigMap's or Secret's values: data changes name
//! the keys that were added, removed or changed, nothing more.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::diff::{diff, FieldChange};

/// Field changes kept per record; `more` says some were left out.
pub const MAX_FIELDS: usize = 24;
/// Event messages are cut to this many characters.
const MAX_MESSAGE: usize = 300;

/// Normal (not Warning) events worth keeping: scaling, nodes coming and
/// going, preemption. The rest (pulled, created, started) is noise.
const NORMAL_REASONS: &[&str] = &[
    "SuccessfulRescale",
    "NodeNotReady",
    "NodeReady",
    "Rebooted",
    "RemovingNode",
    "RegisteredNode",
    "NodeNotSchedulable",
    "NodeSchedulable",
    "TriggeredScaleUp",
    "ScaleDown",
    "Preempted",
    "Evicted",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Action {
    Created,
    Updated,
    Deleted,
    /// A node condition changed (Ready, MemoryPressure, ...).
    Condition,
    Event,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct KeyChanges {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub added: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub removed: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub changed: Vec<String>,
}

impl KeyChanges {
    fn is_empty(&self) -> bool {
        self.added.is_empty() && self.removed.is_empty() && self.changed.is_empty()
    }

    /// Both changes, as one: a key added and then changed is still added.
    pub fn merge(&mut self, later: &KeyChanges) {
        for key in &later.added {
            // Removed and added back: changed.
            if let Some(index) = self.removed.iter().position(|k| k == key) {
                self.removed.remove(index);
                self.changed.push(key.clone());
            } else if !self.added.contains(key) {
                self.added.push(key.clone());
            }
        }
        for key in &later.removed {
            if let Some(index) = self.added.iter().position(|k| k == key) {
                self.added.remove(index);
            } else if !self.removed.contains(key) {
                self.removed.push(key.clone());
            }
            self.changed.retain(|k| k != key);
        }
        for key in &later.changed {
            if !self.added.contains(key) && !self.changed.contains(key) {
                self.changed.push(key.clone());
            }
        }
        for list in [&mut self.added, &mut self.removed, &mut self.changed] {
            list.sort();
            list.dedup();
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventInfo {
    /// "Warning" or "Normal".
    #[serde(rename = "type")]
    pub kind: String,
    pub reason: String,
    pub message: String,
    pub count: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub first_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ConditionChange {
    #[serde(rename = "type")]
    pub kind: String,
    /// The old status ("True", "False", "Unknown"); absent for a new condition.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub from: Option<String>,
    pub to: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub reason: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangeRecord {
    /// Unique per change; an event keeps its id as its count grows.
    pub id: String,
    /// When it happened (RFC 3339).
    pub at: String,
    pub kind: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub namespace: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub uid: String,
    pub action: Action,
    /// The field manager that made it ("helm", "kubectl-edit"), or an
    /// event's source ("kubelet").
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub by: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub fields: Vec<FieldChange>,
    /// More fields changed than `fields` lists.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub more: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub keys: Option<KeyChanges>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub event: Option<EventInfo>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub condition: Option<ConditionChange>,
    /// How many changes were folded into this one (the same object
    /// changing again shortly after).
    #[serde(default = "one", skip_serializing_if = "is_one")]
    pub count: u32,
}

fn one() -> u32 {
    1
}

fn is_one(count: &u32) -> bool {
    *count == 1
}

/// The identity of an object as the recorder remembers it.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ObjectId {
    pub kind: String,
    pub name: String,
    pub namespace: String,
    pub uid: String,
}

impl ObjectId {
    pub fn of(kind: &str, object: &Value) -> Self {
        let meta = &object["metadata"];
        let text = |key: &str| meta[key].as_str().unwrap_or_default().to_string();
        ObjectId {
            kind: kind.to_string(),
            name: text("name"),
            namespace: text("namespace"),
            uid: text("uid"),
        }
    }

    pub fn record(&self, id: String, at: String, action: Action) -> ChangeRecord {
        ChangeRecord {
            id,
            at,
            kind: self.kind.clone(),
            name: self.name.clone(),
            namespace: self.namespace.clone(),
            uid: self.uid.clone(),
            action,
            by: None,
            fields: Vec::new(),
            more: false,
            keys: None,
            event: None,
            condition: None,
            count: 1,
        }
    }
}

/// A spec change of a workload or node; None when the spec is the same.
pub fn spec_change(id: &ObjectId, old_spec: &Value, new_spec: &Value, at: &str, revision: &str) -> Option<ChangeRecord> {
    let mut fields = diff(old_spec, new_spec);
    if fields.is_empty() {
        return None;
    }
    let more = fields.len() > MAX_FIELDS;
    fields.truncate(MAX_FIELDS);
    let mut record = id.record(format!("{}:{revision}", id.uid), at.to_string(), Action::Updated);
    record.fields = fields;
    record.more = more;
    Some(record)
}

/// The status of each condition of a node.
pub fn condition_states(object: &Value) -> BTreeMap<String, (String, String, String)> {
    object["status"]["conditions"]
        .as_array()
        .map(|list| {
            list.iter()
                .filter_map(|c| {
                    let text = |key: &str| c[key].as_str().unwrap_or_default().to_string();
                    let kind = text("type");
                    (!kind.is_empty()).then(|| (kind, (text("status"), text("reason"), text("message"))))
                })
                .collect()
        })
        .unwrap_or_default()
}

/// The node conditions whose status changed between two versions.
pub fn condition_changes(
    id: &ObjectId,
    old: &BTreeMap<String, (String, String, String)>,
    new: &BTreeMap<String, (String, String, String)>,
    at: &str,
) -> Vec<ChangeRecord> {
    new.iter()
        .filter(|(kind, (status, _, _))| old.get(*kind).map(|(s, _, _)| s) != Some(status))
        .map(|(kind, (status, reason, message))| {
            let mut record = id.record(format!("{}:{kind}:{at}", id.uid), at.to_string(), Action::Condition);
            record.condition = Some(ConditionChange {
                kind: kind.clone(),
                from: old.get(kind).map(|(s, _, _)| s.clone()),
                to: status.clone(),
                reason: reason.clone(),
                message: cut(message, MAX_MESSAGE),
            });
            record
        })
        .collect()
}

/// Which keys of a ConfigMap or Secret were added, removed or changed,
/// from hashes of their values; None when none did.
pub fn key_changes(old: &BTreeMap<String, u64>, new: &BTreeMap<String, u64>) -> Option<KeyChanges> {
    let changes = KeyChanges {
        added: new.keys().filter(|k| !old.contains_key(*k)).cloned().collect(),
        removed: old.keys().filter(|k| !new.contains_key(*k)).cloned().collect(),
        changed: new
            .iter()
            .filter(|(k, hash)| old.get(*k).is_some_and(|old| old != *hash))
            .map(|(k, _)| k.clone())
            .collect(),
    };
    (!changes.is_empty()).then_some(changes)
}

/// An event worth keeping (warnings, scaling, nodes), keyed by its uid so
/// a repeat (a higher count) replaces it. None for the rest.
pub fn event_record(event: &Value) -> Option<ChangeRecord> {
    let text = |value: &Value| value.as_str().unwrap_or_default().to_string();
    let kind = text(&event["type"]);
    let reason = text(&event["reason"]);
    if kind != "Warning" && !NORMAL_REASONS.contains(&reason.as_str()) {
        return None;
    }
    let uid = event["metadata"]["uid"].as_str()?;
    let involved = &event["involvedObject"];
    let first = [&event["firstTimestamp"], &event["eventTime"], &event["metadata"]["creationTimestamp"]]
        .into_iter()
        .find_map(|v| v.as_str().filter(|s| !s.is_empty()))
        .map(str::to_string);
    let at = [&event["lastTimestamp"], &event["series"]["lastObservedTime"], &event["eventTime"]]
        .into_iter()
        .find_map(|v| v.as_str().filter(|s| !s.is_empty()))
        .map(str::to_string)
        .or_else(|| first.clone())?;
    let count = event["series"]["count"].as_u64().or_else(|| event["count"].as_u64()).unwrap_or(1);
    let by = [&event["source"]["component"], &event["reportingComponent"], &event["reportingController"]]
        .into_iter()
        .find_map(|v| v.as_str().filter(|s| !s.is_empty()))
        .map(str::to_string);
    let id = ObjectId {
        kind: text(&involved["kind"]),
        name: text(&involved["name"]),
        namespace: involved["namespace"]
            .as_str()
            .or_else(|| event["metadata"]["namespace"].as_str())
            .unwrap_or_default()
            .to_string(),
        uid: text(&involved["uid"]),
    };
    let mut record = id.record(format!("event:{uid}"), at, Action::Event);
    record.by = by;
    record.event = Some(EventInfo {
        kind,
        reason,
        message: cut(&text(&event["message"]), MAX_MESSAGE),
        count,
        first_at: first,
    });
    Some(record)
}

fn cut(text: &str, max: usize) -> String {
    let text = text.trim();
    if text.chars().count() <= max {
        return text.to_string();
    }
    format!("{}…", text.chars().take(max).collect::<String>())
}

/// Changed paths that only touch the replica count (scaling).
pub fn replicas_only(record: &ChangeRecord) -> bool {
    !record.fields.is_empty() && record.fields.iter().all(|f| f.path == ["replicas"])
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn id() -> ObjectId {
        ObjectId {
            kind: "Deployment".into(),
            name: "checkout-api".into(),
            namespace: "checkout".into(),
            uid: "u1".into(),
        }
    }

    #[test]
    fn a_spec_change_lists_its_fields() {
        let old = json!({"replicas": 3, "template": {"spec": {"containers": [{"name": "api", "image": "api:1"}]}}});
        let new = json!({"replicas": 3, "template": {"spec": {"containers": [{"name": "api", "image": "api:2"}]}}});
        let record = spec_change(&id(), &old, &new, "2026-10-31T14:02:00Z", "42").unwrap();
        assert_eq!(record.id, "u1:42");
        assert_eq!(record.action, Action::Updated);
        assert_eq!(record.fields.len(), 1);
        assert!(!record.more);
        assert!(spec_change(&id(), &old, &old, "x", "1").is_none());

        let json = serde_json::to_value(&record).unwrap();
        assert_eq!(json["action"], "updated");
        assert!(json.get("count").is_none(), "a count of one isn't written");
    }

    #[test]
    fn many_fields_are_capped() {
        let old: serde_json::Map<String, Value> = (0..40).map(|i| (format!("f{i:02}"), json!(i))).collect();
        let new: serde_json::Map<String, Value> = (0..40).map(|i| (format!("f{i:02}"), json!(i + 1))).collect();
        let record = spec_change(&id(), &Value::Object(old), &Value::Object(new), "x", "1").unwrap();
        assert_eq!(record.fields.len(), MAX_FIELDS);
        assert!(record.more);
    }

    #[test]
    fn node_conditions_report_transitions_only() {
        let node = |ready: &str, disk: &str| {
            json!({"status": {"conditions": [
                {"type": "Ready", "status": ready, "reason": "KubeletReady", "lastHeartbeatTime": "t"},
                {"type": "DiskPressure", "status": disk, "reason": "KubeletHasDiskPressure", "message": "disk"}
            ]}})
        };
        let id = ObjectId { kind: "Node".into(), name: "n1".into(), uid: "n".into(), ..Default::default() };
        let before = condition_states(&node("True", "False"));
        assert!(condition_changes(&id, &before, &condition_states(&node("True", "False")), "t").is_empty());
        let changes = condition_changes(&id, &before, &condition_states(&node("True", "True")), "2026-10-31T10:00:00Z");
        assert_eq!(changes.len(), 1);
        let condition = changes[0].condition.as_ref().unwrap();
        assert_eq!((condition.kind.as_str(), condition.from.as_deref(), condition.to.as_str()), ("DiskPressure", Some("False"), "True"));
    }

    #[test]
    fn data_changes_name_keys_only() {
        let old = BTreeMap::from([("password".to_string(), 1), ("user".to_string(), 2), ("old".to_string(), 3)]);
        let new = BTreeMap::from([("password".to_string(), 9), ("user".to_string(), 2), ("new".to_string(), 4)]);
        let changes = key_changes(&old, &new).unwrap();
        assert_eq!(changes.added, ["new"]);
        assert_eq!(changes.removed, ["old"]);
        assert_eq!(changes.changed, ["password"]);
        assert!(key_changes(&old, &old).is_none());
    }

    #[test]
    fn merged_key_changes_stay_consistent() {
        let mut first = KeyChanges { added: vec!["a".into()], changed: vec!["b".into()], ..Default::default() };
        first.merge(&KeyChanges { removed: vec!["a".into()], added: vec!["c".into()], ..Default::default() });
        assert_eq!(first.added, ["c"], "added then removed is no change");
        assert_eq!(first.changed, ["b"]);
        let mut second = KeyChanges { removed: vec!["x".into()], ..Default::default() };
        second.merge(&KeyChanges { added: vec!["x".into()], ..Default::default() });
        assert_eq!((second.removed.len(), second.changed.as_slice()), (0, ["x".to_string()].as_slice()));
    }

    #[test]
    fn warnings_and_scaling_events_are_kept() {
        let event = |kind: &str, reason: &str| {
            json!({
                "metadata": {"uid": "e1", "namespace": "checkout", "creationTimestamp": "2026-10-31T13:00:00Z"},
                "involvedObject": {"kind": "Pod", "name": "checkout-api-1", "uid": "p1"},
                "type": kind, "reason": reason, "message": "Back-off restarting failed container",
                "count": 61, "firstTimestamp": "2026-10-31T13:00:00Z", "lastTimestamp": "2026-10-31T14:00:00Z",
                "source": {"component": "kubelet"}
            })
        };
        let record = event_record(&event("Warning", "BackOff")).unwrap();
        assert_eq!(record.id, "event:e1");
        assert_eq!((record.kind.as_str(), record.name.as_str(), record.namespace.as_str()), ("Pod", "checkout-api-1", "checkout"));
        assert_eq!(record.at, "2026-10-31T14:00:00Z");
        assert_eq!(record.by.as_deref(), Some("kubelet"));
        let info = record.event.unwrap();
        assert_eq!((info.count, info.first_at.as_deref()), (61, Some("2026-10-31T13:00:00Z")));
        assert!(event_record(&event("Normal", "SuccessfulRescale")).is_some());
        assert!(event_record(&event("Normal", "Pulled")).is_none());
    }

    #[test]
    fn records_without_optional_parts_round_trip() {
        let record = id().record("u1:1".into(), "2026-10-31T14:02:00Z".into(), Action::Deleted);
        let text = serde_json::to_string(&record).unwrap();
        assert!(!text.contains("fields") && !text.contains("more") && !text.contains("keys"));
        assert_eq!(serde_json::from_str::<ChangeRecord>(&text).unwrap(), record);
    }
}

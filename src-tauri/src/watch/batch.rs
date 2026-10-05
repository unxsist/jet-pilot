//! Coalescing of watch events into the batched deltas sent to the frontend.

use std::collections::{HashMap, HashSet};
use std::fmt::Write;
use std::sync::Arc;

use super::object::StoredObject;

/// Changes since the last flush, coalesced per object:
///
/// - several updates of one object collapse into the latest version;
/// - an object added and modified within a batch is sent as `added`;
/// - an object added and deleted within a batch is not sent at all;
/// - an object modified and then deleted is only sent as `deleted`.
#[derive(Default)]
pub struct DeltaBatch {
    /// uid -> (latest object, whether it is new since the last flush).
    upserts: HashMap<String, (Arc<StoredObject>, bool)>,
    deleted: HashSet<String>,
}

impl DeltaBatch {
    pub fn is_empty(&self) -> bool {
        self.upserts.is_empty() && self.deleted.is_empty()
    }

    pub fn len(&self) -> usize {
        self.upserts.len() + self.deleted.len()
    }

    /// Records a new or changed object. `is_new` means the object was not
    /// in the store before this event.
    pub fn upsert(&mut self, obj: Arc<StoredObject>, is_new: bool) {
        let uid = obj.uid.clone();
        if self.deleted.remove(&uid) {
            // Deleted and re-created with the same identity (only possible for
            // uid-less objects): the frontend still has the old row.
            self.upserts.insert(uid, (obj, false));
            return;
        }

        let added = match self.upserts.get(&uid) {
            Some((_, added)) => *added,
            None => is_new,
        };
        self.upserts.insert(uid, (obj, added));
    }

    pub fn delete(&mut self, uid: &str) {
        match self.upserts.remove(uid) {
            // Never sent: nothing to delete on the frontend.
            Some((_, true)) => {}
            _ => {
                self.deleted.insert(uid.to_string());
            }
        }
    }

    /// Serializes the batch as a `delta` message and clears it. The object
    /// JSON is already serialized, so this is string concatenation only.
    pub fn take_message(&mut self, scope_json: &str) -> Option<String> {
        if self.is_empty() {
            return None;
        }

        let upserts = std::mem::take(&mut self.upserts);
        let deleted = std::mem::take(&mut self.deleted);

        let size: usize = upserts.values().map(|(o, _)| o.json.len() + 1).sum::<usize>()
            + deleted.iter().map(|uid| uid.len() + 3).sum::<usize>()
            + 64;
        let mut out = String::with_capacity(size);
        let _ = write!(out, "{{\"type\":\"delta\",\"scope\":{scope_json},\"added\":[");
        push_objects(&mut out, upserts.values().filter(|(_, added)| *added).map(|(o, _)| o));
        out.push_str("],\"modified\":[");
        push_objects(&mut out, upserts.values().filter(|(_, added)| !*added).map(|(o, _)| o));
        out.push_str("],\"deleted\":");
        out.push_str(&serde_json::to_string(&deleted).unwrap_or_else(|_| "[]".into()));
        out.push('}');
        Some(out)
    }
}

/// Appends `objects` comma separated (no surrounding brackets).
pub fn push_objects<'a>(out: &mut String, objects: impl Iterator<Item = &'a Arc<StoredObject>>) {
    for (i, obj) in objects.enumerate() {
        if i > 0 {
            out.push(',');
        }
        out.push_str(&obj.json);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    fn obj(uid: &str, rv: &str) -> Arc<StoredObject> {
        Arc::new(StoredObject {
            uid: uid.into(),
            resource_version: rv.into(),
            json: format!("{{\"uid\":\"{uid}\",\"rv\":\"{rv}\"}}").into_boxed_str(),
        })
    }

    fn message(batch: &mut DeltaBatch) -> Value {
        serde_json::from_str(&batch.take_message("\"ns\"").unwrap()).unwrap()
    }

    #[test]
    fn empty_batch_sends_nothing() {
        assert!(DeltaBatch::default().take_message("\"\"").is_none());
    }

    #[test]
    fn added_then_modified_is_sent_once_as_added_with_latest_version() {
        let mut batch = DeltaBatch::default();
        batch.upsert(obj("a", "1"), true);
        batch.upsert(obj("a", "2"), false);
        batch.upsert(obj("a", "3"), false);

        let msg = message(&mut batch);
        assert_eq!(msg["type"], "delta");
        assert_eq!(msg["scope"], "ns");
        assert_eq!(msg["added"].as_array().unwrap().len(), 1);
        assert_eq!(msg["added"][0]["rv"], "3");
        assert!(msg["modified"].as_array().unwrap().is_empty());
        assert!(batch.is_empty());
    }

    #[test]
    fn modifications_collapse_to_the_latest_version() {
        let mut batch = DeltaBatch::default();
        for rv in 1..=50 {
            batch.upsert(obj("a", &rv.to_string()), false);
        }
        assert_eq!(batch.len(), 1);
        let msg = message(&mut batch);
        assert_eq!(msg["modified"][0]["rv"], "50");
    }

    #[test]
    fn added_then_deleted_is_dropped() {
        let mut batch = DeltaBatch::default();
        batch.upsert(obj("a", "1"), true);
        batch.delete("a");
        assert!(batch.is_empty());
    }

    #[test]
    fn modified_then_deleted_is_only_deleted() {
        let mut batch = DeltaBatch::default();
        batch.upsert(obj("a", "2"), false);
        batch.delete("a");
        batch.upsert(obj("b", "1"), true);

        let msg = message(&mut batch);
        assert_eq!(msg["deleted"], serde_json::json!(["a"]));
        assert!(msg["modified"].as_array().unwrap().is_empty());
        assert_eq!(msg["added"][0]["uid"], "b");
    }

    #[test]
    fn deleted_then_recreated_is_a_modification() {
        let mut batch = DeltaBatch::default();
        batch.delete("a");
        batch.upsert(obj("a", "9"), true);

        let msg = message(&mut batch);
        assert!(msg["deleted"].as_array().unwrap().is_empty());
        assert_eq!(msg["modified"][0]["rv"], "9");
    }

    #[test]
    fn message_is_valid_json_for_many_objects() {
        let mut batch = DeltaBatch::default();
        for i in 0..1000 {
            batch.upsert(obj(&format!("u{i}"), "1"), i % 2 == 0);
        }
        for i in 1000..1100 {
            batch.delete(&format!("u{i}"));
        }
        let msg = message(&mut batch);
        assert_eq!(msg["added"].as_array().unwrap().len(), 500);
        assert_eq!(msg["modified"].as_array().unwrap().len(), 500);
        assert_eq!(msg["deleted"].as_array().unwrap().len(), 100);
    }
}

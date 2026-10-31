//! Structural diff of two JSON values (an object's spec before and after a
//! change) as a short list of field changes, which the front end puts in
//! words ("image api:1.4.2 → api:1.5.0").
//!
//! Lists of named objects (containers, env, volumes, ports) are matched by
//! name, so a path reads `spec / template / spec / containers / [api] /
//! image` and reordering them is no change; other lists compare as one
//! value. Values are shortened so a record stays small.

use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Longest string kept as a value; longer ones are cut with "…".
const MAX_TEXT: usize = 160;
/// Lists and objects whose JSON is longer than this are kept as "…".
const MAX_JSON: usize = 400;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FieldChange {
    /// Object keys, and `[name]` for an item of a named list.
    pub path: Vec<String>,
    /// The old value; absent when the field was added.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub from: Option<Value>,
    /// The new value; absent when the field was removed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub to: Option<Value>,
}

/// The fields that differ between `old` and `new`, in a stable order.
pub fn diff(old: &Value, new: &Value) -> Vec<FieldChange> {
    let mut out = Vec::new();
    walk(Some(old), Some(new), &mut Vec::new(), &mut out);
    out
}

fn walk(old: Option<&Value>, new: Option<&Value>, path: &mut Vec<String>, out: &mut Vec<FieldChange>) {
    if old == new {
        return;
    }
    match (old, new) {
        (Some(Value::Object(a)), Some(Value::Object(b))) => {
            let keys: BTreeSet<&String> = a.keys().chain(b.keys()).collect();
            for key in keys {
                path.push(key.clone());
                walk(a.get(key), b.get(key), path, out);
                path.pop();
            }
        }
        (Some(Value::Array(a)), Some(Value::Array(b))) if named(a) && named(b) => {
            // Old order first, then the new names.
            let mut names: Vec<&str> = a.iter().filter_map(name_of).collect();
            for name in b.iter().filter_map(name_of) {
                if !names.contains(&name) {
                    names.push(name);
                }
            }
            for name in names {
                path.push(format!("[{name}]"));
                let find = |list: &'_ [Value]| list.iter().find(|item| name_of(item) == Some(name)).cloned();
                walk(find(a).as_ref(), find(b).as_ref(), path, out);
                path.pop();
            }
        }
        _ => out.push(FieldChange {
            path: path.clone(),
            from: old.map(shorten),
            to: new.map(shorten),
        }),
    }
}

fn name_of(item: &Value) -> Option<&str> {
    item.get("name").and_then(Value::as_str)
}

/// Every item is an object with a unique name (and there is at least one).
fn named(list: &[Value]) -> bool {
    let mut seen = BTreeSet::new();
    !list.is_empty() && list.iter().all(|item| item.is_object() && name_of(item).is_some_and(|name| seen.insert(name)))
}

fn shorten(value: &Value) -> Value {
    match value {
        Value::String(text) if text.chars().count() > MAX_TEXT => {
            Value::String(format!("{}…", text.chars().take(MAX_TEXT).collect::<String>()))
        }
        Value::Array(_) | Value::Object(_) if value.to_string().len() > MAX_JSON => Value::String("…".into()),
        other => other.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn paths(changes: &[FieldChange]) -> Vec<String> {
        changes.iter().map(|c| c.path.join(".")).collect()
    }

    #[test]
    fn named_lists_are_matched_by_name() {
        let old = json!({"template": {"spec": {"containers": [
            {"name": "api", "image": "api:1.4.2"},
            {"name": "sidecar", "image": "envoy:1"}
        ]}}});
        let new = json!({"template": {"spec": {"containers": [
            {"name": "sidecar", "image": "envoy:1"},
            {"name": "api", "image": "api:1.5.0"}
        ]}}});
        let changes = diff(&old, &new);
        assert_eq!(paths(&changes), ["template.spec.containers.[api].image"]);
        assert_eq!(changes[0].from, Some(json!("api:1.4.2")));
        assert_eq!(changes[0].to, Some(json!("api:1.5.0")));
    }

    #[test]
    fn added_and_removed_fields_have_one_side() {
        let old = json!({"replicas": 3, "paused": true, "env": [{"name": "A", "value": "1"}]});
        let new = json!({"replicas": 5, "env": [{"name": "A", "value": "1"}, {"name": "B", "value": "2"}]});
        let changes = diff(&old, &new);
        assert_eq!(paths(&changes), ["env.[B]", "paused", "replicas"]);
        assert_eq!(changes[0].from, None);
        assert_eq!(changes[0].to, Some(json!({"name": "B", "value": "2"})));
        assert_eq!(changes[1].to, None);
    }

    #[test]
    fn unnamed_lists_compare_as_one_value() {
        let old = json!({"args": ["--a"], "taints": [{"key": "x", "effect": "NoSchedule"}]});
        let new = json!({"args": ["--a", "--b"], "taints": []});
        assert_eq!(paths(&diff(&old, &new)), ["args", "taints"]);
        assert!(diff(&old, &old).is_empty());
    }

    #[test]
    fn long_values_are_shortened() {
        let long = "x".repeat(500);
        let changes = diff(&json!({"a": "short", "b": [1]}), &json!({"a": long, "b": vec![long.clone(); 3]}));
        let text = changes[0].to.as_ref().unwrap().as_str().unwrap();
        assert_eq!(text.chars().count(), MAX_TEXT + 1);
        assert!(text.ends_with('…'));
        assert_eq!(changes[1].to, Some(json!("…")));
    }
}

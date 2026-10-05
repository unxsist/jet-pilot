//! Conversion of watched objects into the JSON rows the frontend expects.

use k8s_openapi::apimachinery::pkg::apis::meta::v1::ObjectMeta;
use kube::api::{ApiResource, DynamicObject};
use serde::Serialize;

/// The context a watched object was fetched from. Every row carries it in
/// `metadata.context` / `metadata.kubeConfig` (exactly like the kubectl
/// polling path tagged them) so row actions target the right cluster.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct Tag {
    pub context: String,
    pub kube_config: String,
}

/// A cached object: its identity, version and the serialized row JSON.
#[derive(Debug, PartialEq)]
pub struct StoredObject {
    pub uid: String,
    pub resource_version: String,
    pub json: Box<str>,
}

#[derive(Serialize)]
struct TaggedMeta<'a> {
    #[serde(flatten)]
    meta: &'a ObjectMeta,
    context: &'a str,
    #[serde(rename = "kubeConfig")]
    kube_config: &'a str,
}

#[derive(Serialize)]
struct Row<'a> {
    #[serde(rename = "apiVersion")]
    api_version: &'a str,
    kind: &'a str,
    metadata: TaggedMeta<'a>,
    #[serde(flatten)]
    data: &'a serde_json::Value,
}

/// Serializes `obj` as a frontend row: `managedFields` stripped (often the
/// largest part of an object and never shown), `apiVersion` / `kind` filled
/// in (list responses omit them per item) and the context tags added.
///
/// Objects without a uid (should not happen for real API objects) are keyed
/// by namespace/name so they still have a stable identity.
pub fn prepare(mut obj: DynamicObject, ar: &ApiResource, tag: &Tag) -> Option<StoredObject> {
    obj.metadata.managed_fields = None;

    let uid = match &obj.metadata.uid {
        Some(uid) => uid.clone(),
        None => format!(
            "{}/{}",
            obj.metadata.namespace.as_deref().unwrap_or_default(),
            obj.metadata.name.as_deref()?
        ),
    };
    let resource_version = obj.metadata.resource_version.clone().unwrap_or_default();

    let (api_version, kind) = match &obj.types {
        Some(types) if !types.kind.is_empty() => (types.api_version.as_str(), types.kind.as_str()),
        _ => (ar.api_version.as_str(), ar.kind.as_str()),
    };

    // `data` holds every top-level field except apiVersion/kind/metadata; a
    // non-object (only possible for malformed input) would break flattening.
    if !obj.data.is_object() {
        obj.data = serde_json::Value::Object(Default::default());
    }

    let row = Row {
        api_version,
        kind,
        metadata: TaggedMeta {
            meta: &obj.metadata,
            context: &tag.context,
            kube_config: &tag.kube_config,
        },
        data: &obj.data,
    };

    let json = serde_json::to_string(&row).ok()?.into_boxed_str();
    Some(StoredObject {
        uid,
        resource_version,
        json,
    })
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use kube::core::GroupVersionKind;
    use serde_json::json;

    pub fn pod_resource() -> ApiResource {
        ApiResource::from_gvk_with_plural(&GroupVersionKind::gvk("", "v1", "Pod"), "pods")
    }

    pub fn tag() -> Tag {
        Tag {
            context: "kind-dev".into(),
            kube_config: "/home/me/.kube/config".into(),
        }
    }

    pub fn pod(uid: &str, rv: &str) -> DynamicObject {
        serde_json::from_value(json!({
            "metadata": {
                "name": format!("pod-{uid}"),
                "namespace": "default",
                "uid": uid,
                "resourceVersion": rv,
                "managedFields": [{"manager": "kubectl", "operation": "Apply", "fieldsV1": {"f:spec": {}}}],
                "labels": {"app": "web"}
            },
            "spec": {"containers": [{"name": "c", "image": "nginx"}]},
            "status": {"phase": "Running"}
        }))
        .unwrap()
    }

    #[test]
    fn strips_managed_fields_and_tags_context() {
        let stored = prepare(pod("u1", "7"), &pod_resource(), &tag()).unwrap();
        assert_eq!(stored.uid, "u1");
        assert_eq!(stored.resource_version, "7");
        assert!(!stored.json.contains("managedFields"));

        let value: serde_json::Value = serde_json::from_str(&stored.json).unwrap();
        assert_eq!(value["apiVersion"], "v1");
        assert_eq!(value["kind"], "Pod");
        assert_eq!(value["metadata"]["context"], "kind-dev");
        assert_eq!(value["metadata"]["kubeConfig"], "/home/me/.kube/config");
        assert_eq!(value["metadata"]["labels"]["app"], "web");
        assert_eq!(value["spec"]["containers"][0]["image"], "nginx");
        assert_eq!(value["status"]["phase"], "Running");
    }

    #[test]
    fn keeps_server_provided_type_meta() {
        let mut obj = pod("u1", "1");
        obj.types = Some(kube::api::TypeMeta {
            api_version: "v1".into(),
            kind: "Pod".into(),
        });
        let stored = prepare(obj, &pod_resource(), &tag()).unwrap();
        // Serialized exactly once (no duplicate keys from the flattened data).
        assert_eq!(stored.json.matches("\"kind\"").count(), 1);
    }

    #[test]
    fn objects_without_uid_fall_back_to_namespaced_name() {
        let mut obj = pod("u1", "1");
        obj.metadata.uid = None;
        let stored = prepare(obj, &pod_resource(), &tag()).unwrap();
        assert_eq!(stored.uid, "default/pod-u1");
    }
}

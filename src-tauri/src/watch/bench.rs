//! Rough throughput numbers for the watch store:
//! `cargo test --release bench_ -- --ignored --nocapture`

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Instant;

use kube::api::DynamicObject;
use kube::runtime::watcher;
use serde_json::json;

use super::entry::Entry;
use super::object::tests::{pod_resource, tag};

fn realistic_pod(i: usize, rv: usize) -> DynamicObject {
    let managed_fields: Vec<_> = (0..4)
        .map(|m| {
            json!({
                "manager": format!("manager-{m}"), "operation": "Update", "apiVersion": "v1",
                "time": "2026-10-01T10:00:00Z", "fieldsType": "FieldsV1",
                "fieldsV1": {
                    "f:metadata": {"f:labels": {".": {}, "f:app": {}, "f:team": {}}},
                    "f:spec": {"f:containers": {"k:{\"name\":\"api\"}": {".": {}, "f:image": {}, "f:imagePullPolicy": {}, "f:name": {}, "f:ports": {".": {}}, "f:resources": {".": {}, "f:limits": {".": {}, "f:cpu": {}, "f:memory": {}}}}}},
                    "f:status": {"f:conditions": {".": {}}, "f:containerStatuses": {}, "f:hostIP": {}, "f:phase": {}, "f:podIP": {}, "f:startTime": {}}
                }
            })
        })
        .collect();
    let env: Vec<_> = (0..8)
        .map(|e| json!({"name": format!("ENV_{e}"), "value": "some-config-value"}))
        .collect();
    let conditions: Vec<_> = ["Initialized", "Ready", "ContainersReady", "PodScheduled"]
        .iter()
        .map(|t| json!({"type": t, "status": "True", "lastTransitionTime": "2026-10-01T10:00:00Z"}))
        .collect();

    serde_json::from_value(json!({
        "metadata": {
            "name": format!("payments-api-7d9f8b6c4-{i:05}"),
            "namespace": format!("ns-{}", i % 20),
            "uid": format!("00000000-0000-0000-0000-{i:012}"),
            "resourceVersion": rv.to_string(),
            "creationTimestamp": "2026-10-01T10:00:00Z",
            "labels": {"app": "payments-api", "pod-template-hash": "7d9f8b6c4", "team": "payments"},
            "annotations": {"prometheus.io/scrape": "true"},
            "ownerReferences": [{"apiVersion": "apps/v1", "kind": "ReplicaSet", "name": "payments-api-7d9f8b6c4", "uid": "rs-uid", "controller": true}],
            "managedFields": managed_fields
        },
        "spec": {
            "containers": [{
                "name": "api", "image": "ghcr.io/acme/payments-api:2.14.3",
                "ports": [{"containerPort": 8080, "protocol": "TCP"}],
                "resources": {"requests": {"cpu": "250m", "memory": "256Mi"}, "limits": {"cpu": "1", "memory": "512Mi"}},
                "env": env,
                "volumeMounts": [{"name": "kube-api-access", "mountPath": "/var/run/secrets/kubernetes.io/serviceaccount", "readOnly": true}]
            }],
            "nodeName": "ip-10-0-12-34.eu-west-1.compute.internal",
            "serviceAccountName": "default",
            "restartPolicy": "Always"
        },
        "status": {
            "phase": "Running", "podIP": "10.42.84.10", "hostIP": "10.0.12.34", "startTime": "2026-10-01T10:00:00Z",
            "conditions": conditions,
            "containerStatuses": [{
                "name": "api", "ready": true, "restartCount": rv, "image": "ghcr.io/acme/payments-api:2.14.3",
                "imageID": "ghcr.io/acme/payments-api@sha256:abc", "containerID": "containerd://abc", "started": true,
                "state": {"running": {"startedAt": "2026-10-01T10:00:00Z"}}
            }]
        }
    }))
    .unwrap()
}

#[test]
#[ignore]
fn bench_sync_and_deltas() {
    const N: usize = 5000;
    const UPDATES: usize = 1000;
    let raw_size = serde_json::to_string(&realistic_pod(0, 1)).unwrap().len();

    let entry = Entry::new(pod_resource(), tag(), String::new());
    let bytes = Arc::new(AtomicUsize::new(0));
    let counter = bytes.clone();
    entry.add_sink(
        1,
        Arc::new(move |m: String| {
            counter.fetch_add(m.len(), Ordering::Relaxed);
            true
        }),
    );

    let pods: Vec<_> = (0..N).map(|i| realistic_pod(i, 1)).collect();
    let started = Instant::now();
    entry.apply(watcher::Event::Init);
    for pod in pods {
        entry.apply(watcher::Event::InitApply(pod));
    }
    entry.apply(watcher::Event::InitDone);
    let sync = started.elapsed();
    let snapshot_bytes = bytes.swap(0, Ordering::Relaxed);

    // Snapshot for a second (warm) subscriber, i.e. navigating back.
    let started = Instant::now();
    entry.add_sink(2, Arc::new(|_| true));
    let warm = started.elapsed();

    // Modifications, flushed in batches of 20 (~one 150 ms batch each).
    let updates: Vec<_> = (0..UPDATES).map(|i| realistic_pod((i * 7) % N, 2 + i)).collect();
    let started = Instant::now();
    for (i, pod) in updates.into_iter().enumerate() {
        entry.apply(watcher::Event::Apply(pod));
        if i % 20 == 19 {
            entry.flush();
        }
    }
    let deltas = started.elapsed();
    let delta_bytes = bytes.load(Ordering::Relaxed);

    println!(
        "pods={N} raw_pod_bytes={raw_size} row_bytes={} initial_sync={:?} snapshot_bytes={} \
         warm_snapshot={:?} per_event={:?} delta_bytes_per_event={}",
        snapshot_bytes / N,
        sync,
        snapshot_bytes,
        warm,
        deltas / UPDATES as u32,
        delta_bytes / UPDATES,
    );
}

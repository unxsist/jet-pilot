//! Real API server QA: the backend services (WatchHub, metrics, discovery,
//! manifests, log streams) against a local kwok cluster. Compiled only with
//! the `kwok-qa` feature and never run in CI.
//!
//! Setup (no root, no docker): download `kwokctl`, `kwok` and `kubectl` into
//! /tmp/kwok/bin, then
//!
//! ```sh
//! KWOK_WORKDIR=/tmp/kwok/work kwokctl create cluster --runtime binary \
//!     --name jetqa --kubeconfig /tmp/kwok/kubeconfig
//! ```
//!
//! and create fake nodes, workloads in the namespaces qa-a..qa-d / qa-big
//! and the `widgets.qa.jet.io` CRD (see the QA notes in the PR). Run:
//!
//! ```sh
//! PATH=/tmp/kwok/bin:$PATH JET_QA_KUBECONFIG=/tmp/kwok/kubeconfig \
//!   cargo test --features kwok-qa qa_kwok -- --nocapture --test-threads=1
//! ```
//!
//! `JET_QA_KWOKCTL=/tmp/kwok/bin/kwokctl` (+ `KWOK_WORKDIR`) also runs the
//! API server restart / relist test. Measurements are printed as `QA ...`.

use std::process::Command;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use crate::kubernetes::client::{self as kube_client, ManifestMode};
use crate::logs::streaming::{start_stream_with, stop_stream, EventSink, LogStreamEvent};
use crate::logs::structured_logging as logging;
use crate::util::lock;
use crate::{metrics, watch};

struct QaEnv {
    kubeconfig: String,
    context: String,
}

/// None (test skipped) without a QA cluster.
fn qa_env() -> Option<QaEnv> {
    let kubeconfig = std::env::var("JET_QA_KUBECONFIG").ok()?;
    let context = std::env::var("JET_QA_CONTEXT").unwrap_or_else(|_| "kwok-jetqa".into());
    Some(QaEnv { kubeconfig, context })
}

macro_rules! require_env {
    () => {
        match qa_env() {
            Some(env) => env,
            None => {
                eprintln!("JET_QA_KUBECONFIG not set: skipped");
                return;
            }
        }
    };
}

fn kubectl_with(kubeconfig: &str, args: &[&str]) -> Result<String, String> {
    let output = Command::new("kubectl")
        .arg(format!("--kubeconfig={kubeconfig}"))
        .args(args)
        .output()
        .map_err(|e| format!("kubectl: {e}"))?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).into_owned())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).into_owned())
    }
}

fn kubectl(env: &QaEnv, args: &[&str]) -> String {
    kubectl_with(&env.kubeconfig, args).unwrap_or_else(|e| panic!("kubectl {args:?}: {e}"))
}

fn count_lines(output: &str) -> usize {
    output.lines().filter(|l| !l.trim().is_empty()).count()
}

/* ------------------------------------------------------------ recorder -- */

/// Collects the messages of a subscription with their arrival time.
#[derive(Default)]
struct Recorder {
    messages: Mutex<Vec<(Instant, Value)>>,
}

impl Recorder {
    fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    fn sink(self: &Arc<Self>) -> watch::WatchSink {
        let me = self.clone();
        Arc::new(move |message: String| {
            let value: Value = serde_json::from_str(&message).expect("messages are JSON");
            lock(&me.messages).push((Instant::now(), value));
            true
        })
    }

    fn len(&self) -> usize {
        lock(&self.messages).len()
    }

    fn all(&self) -> Vec<(Instant, Value)> {
        lock(&self.messages).clone()
    }

    /// Polls until `find` returns Some for the messages from index `from`.
    async fn wait_for<T>(
        &self,
        from: usize,
        timeout: Duration,
        find: impl Fn(&[(Instant, Value)]) -> Option<T>,
    ) -> Option<T> {
        let deadline = Instant::now() + timeout;
        loop {
            {
                let messages = lock(&self.messages);
                if let Some(found) = find(&messages[from.min(messages.len())..]) {
                    return Some(found);
                }
            }
            if Instant::now() > deadline {
                return None;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    }

    fn states(&self) -> Vec<String> {
        self.all()
            .iter()
            .filter(|(_, m)| m["type"] == "status")
            .map(|(_, m)| m["state"].as_str().unwrap_or_default().to_string())
            .collect()
    }
}

fn snapshot_of<'a>(messages: &'a [(Instant, Value)], scope: &str) -> Option<(Instant, &'a Vec<Value>)> {
    messages.iter().find_map(|(at, m)| {
        (m["type"] == "snapshot" && m["scope"] == scope).then(|| (*at, m["items"].as_array().unwrap()))
    })
}

fn status_of(messages: &[(Instant, Value)], state: &str) -> Option<(Instant, Value)> {
    messages
        .iter()
        .find(|(_, m)| m["type"] == "status" && m["state"] == state)
        .cloned()
}

fn watch_request(kubeconfig: &str, context: &str, resource: &str, kind: Option<&str>, namespaces: &[&str]) -> watch::WatchRequest {
    serde_json::from_value(json!({
        "kubeConfig": kubeconfig,
        "context": context,
        "resource": resource,
        "kind": kind,
        "namespaces": namespaces,
    }))
    .unwrap()
}

fn block_on<F: std::future::Future>(future: F) -> F::Output {
    // Everything on tauri's runtime, like the app: cached kube clients spawn
    // their connection tasks on the runtime that built them.
    tauri::async_runtime::block_on(future)
}

fn added_count(messages: &[(Instant, Value)]) -> usize {
    messages
        .iter()
        .filter(|(_, m)| m["type"] == "delta")
        .map(|(_, m)| m["added"].as_array().map_or(0, Vec::len))
        .sum()
}

fn deleted_uids(messages: &[(Instant, Value)]) -> Vec<String> {
    messages
        .iter()
        .filter(|(_, m)| m["type"] == "delta")
        .flat_map(|(_, m)| m["deleted"].as_array().cloned().unwrap_or_default())
        .filter_map(|v| v.as_str().map(String::from))
        .collect()
}

/* --------------------------------------------------------------- watch -- */

#[test]
fn watch_pods_snapshot_deltas_and_warm_resubscribe() {
    let env = require_env!();
    block_on(async {
        kubectl(&env, &["-n", "qa-a", "scale", "deployment/web", "--replicas=80"]);
        kubectl(&env, &["-n", "qa-a", "rollout", "status", "deployment/web", "--timeout=60s"]);
        tokio::time::sleep(Duration::from_secs(2)).await;
        let expected = count_lines(&kubectl(&env, &["get", "pods", "-A", "--no-headers"]));

        // Cold: client + discovery + initial list of every pod.
        let recorder = Recorder::new();
        let started = Instant::now();
        let subscription = watch::subscribe(
            watch_request(&env.kubeconfig, &env.context, "pods", Some("Pod"), &["all"]),
            recorder.sink(),
        )
        .await
        .expect("subscribe");
        let subscribed = started.elapsed();
        assert_eq!(subscription.scopes, vec![String::new()]);
        assert_eq!(subscription.api_version, "v1");
        let (at, count, sample) = recorder
            .wait_for(0, Duration::from_secs(60), |m| {
                snapshot_of(m, "").map(|(at, items)| (at, items.len(), items[0].clone()))
            })
            .await
            .expect("snapshot");
        eprintln!(
            "QA watch pods (all namespaces): subscribe returned after {:?}, snapshot of {} pods after {:?}",
            subscribed,
            count,
            at - started
        );
        assert_eq!(count, expected, "snapshot has every pod");
        assert_eq!(sample["metadata"]["context"], env.context.as_str());
        assert_eq!(sample["metadata"]["kubeConfig"], env.kubeconfig.as_str());
        assert_eq!(sample["kind"], "Pod");
        assert_eq!(sample["apiVersion"], "v1");
        assert!(sample["metadata"].get("managedFields").is_none());
        let states = recorder.states();
        assert_eq!(states.first().map(String::as_str), Some("syncing"));
        assert!(states.contains(&"ready".to_string()), "{states:?}");

        // Scale up: pods are created (added), then kwok runs them (modified).
        let before = recorder.len();
        let started = Instant::now();
        kubectl(&env, &["-n", "qa-a", "scale", "deployment/web", "--replicas=85"]);
        let issued = started.elapsed();
        let first = recorder
            .wait_for(before, Duration::from_secs(30), |m| {
                m.iter()
                    .find(|(_, m)| m["type"] == "delta" && !m["added"].as_array().unwrap().is_empty())
                    .map(|(at, _)| *at)
            })
            .await
            .expect("added delta");
        let all = recorder
            .wait_for(before, Duration::from_secs(30), |m| {
                (added_count(m) >= 5).then(|| m.last().unwrap().0)
            })
            .await
            .expect("5 added pods");
        eprintln!(
            "QA delta latency (kubectl scale +5, command took {:?}): first added pod after {:?}, all 5 after {:?}",
            issued,
            first - started,
            all - started
        );

        // Delete one pod.
        let pods = kubectl(&env, &["-n", "qa-a", "get", "pods", "-l", "app=web", "-o", "jsonpath={.items[0].metadata.name} {.items[0].metadata.uid}"]);
        let (name, uid) = pods.split_once(' ').unwrap();
        let before = recorder.len();
        let started = Instant::now();
        // Blocks until the API server removed the pod (graceful deletion).
        kubectl(&env, &["-n", "qa-a", "delete", "pod", name, "--wait=true"]);
        let gone = started.elapsed();
        let terminating = recorder
            .wait_for(before, Duration::from_secs(30), |m| {
                m.iter()
                    .find(|(_, m)| {
                        m["type"] == "delta"
                            && m["modified"].as_array().unwrap().iter().any(|p| {
                                p["metadata"]["uid"] == uid && !p["metadata"]["deletionTimestamp"].is_null()
                            })
                    })
                    .map(|(at, _)| *at)
            })
            .await;
        eprintln!(
            "QA delta latency (kubectl delete pod): terminating row after {:?}",
            terminating.map(|at| at - started)
        );
        let deleted = recorder
            .wait_for(before, Duration::from_secs(60), |m| {
                m.iter()
                    .find(|(_, m)| {
                        m["type"] == "delta"
                            && m["deleted"].as_array().unwrap().iter().any(|d| d == uid)
                    })
                    .map(|(at, _)| *at)
            })
            .await
            .expect("deleted delta");
        eprintln!(
            "QA delta latency (kubectl delete pod): removed after {:?}, kubectl delete --wait returned after {:?}",
            deleted - started,
            gone
        );

        // Batching: deltas arrive at most every ~150 ms per watcher.
        let before = recorder.len();
        kubectl(&env, &["-n", "qa-a", "scale", "deployment/web", "--replicas=80"]);
        recorder
            .wait_for(before, Duration::from_secs(60), |m| (deleted_uids(m).len() >= 5).then_some(()))
            .await
            .expect("scale down deletes");
        tokio::time::sleep(Duration::from_secs(2)).await;
        let deltas: Vec<Instant> = recorder.all()[before..]
            .iter()
            .filter(|(_, m)| m["type"] == "delta")
            .map(|(at, _)| *at)
            .collect();
        let min_gap = deltas.windows(2).map(|w| w[1] - w[0]).min();
        eprintln!(
            "QA scale down -5: {} delta messages, smallest gap {:?}",
            deltas.len(),
            min_gap
        );
        if let Some(gap) = min_gap {
            assert!(gap >= Duration::from_millis(100), "deltas are batched ({gap:?})");
        }

        watch::watch_unsubscribe(subscription.id);

        // Warm: the watcher stays alive for 60 s, resubscribing is instant.
        let recorder = Recorder::new();
        let started = Instant::now();
        let subscription = watch::subscribe(
            watch_request(&env.kubeconfig, &env.context, "pods", Some("Pod"), &["all"]),
            recorder.sink(),
        )
        .await
        .unwrap();
        let (at, count) = recorder
            .wait_for(0, Duration::from_secs(5), |m| snapshot_of(m, "").map(|(at, i)| (at, i.len())))
            .await
            .expect("warm snapshot");
        eprintln!("QA watch pods warm resubscribe: {} pods after {:?}", count, at - started);
        assert!(at - started < Duration::from_secs(2));
        assert_eq!(recorder.states()[0], "ready", "warm watchers report ready first");
        watch::watch_unsubscribe(subscription.id);

        // Per namespace: one watcher (and snapshot) per scope.
        let recorder = Recorder::new();
        let started = Instant::now();
        let subscription = watch::subscribe(
            watch_request(&env.kubeconfig, &env.context, "pods", None, &["qa-b", "qa-a"]),
            recorder.sink(),
        )
        .await
        .unwrap();
        assert_eq!(subscription.scopes, vec!["qa-a".to_string(), "qa-b".to_string()]);
        let counts = recorder
            .wait_for(0, Duration::from_secs(30), |m| {
                Some((snapshot_of(m, "qa-a")?.1.len(), snapshot_of(m, "qa-b")?.1.len()))
            })
            .await
            .expect("namespace snapshots");
        let expected_a = count_lines(&kubectl(&env, &["-n", "qa-a", "get", "pods", "--no-headers"]));
        eprintln!("QA watch pods [qa-a, qa-b]: {:?} pods after {:?}", counts, started.elapsed());
        assert_eq!(counts.0, expected_a);
        watch::watch_unsubscribe(subscription.id);
    });
}

#[test]
fn watch_deployments_crds_and_unknown_resources() {
    let env = require_env!();
    block_on(async {
        for (resource, kind, expected_api) in [
            ("deployments", Some("Deployment"), "apps/v1"),
            ("deployments.apps", None, "apps/v1"),
            ("widgets", Some("Widget"), "qa.jet.io/v1"),
            ("statefulsets", None, "apps/v1"),
            ("ingresses", None, "networking.k8s.io/v1"),
            ("nodes", None, "v1"),
            ("customresourcedefinitions", None, "apiextensions.k8s.io/v1"),
        ] {
            let recorder = Recorder::new();
            let started = Instant::now();
            let subscription = watch::subscribe(
                watch_request(&env.kubeconfig, &env.context, resource, kind, &["all"]),
                recorder.sink(),
            )
            .await
            .unwrap_or_else(|e| panic!("subscribe {resource}: {e}"));
            assert_eq!(subscription.api_version, expected_api, "{resource}");
            let (at, items) = recorder
                .wait_for(0, Duration::from_secs(30), |m| snapshot_of(m, "").map(|(at, i)| (at, i.clone())))
                .await
                .unwrap_or_else(|| panic!("{resource} snapshot"));
            eprintln!("QA watch {resource}: {} objects after {:?}", items.len(), at - started);
            assert!(!items.is_empty(), "{resource}");
            if resource == "widgets" {
                assert_eq!(items[0]["spec"]["size"], 3);
                assert_eq!(items[0]["kind"], "Widget");
            }
            watch::watch_unsubscribe(subscription.id);
        }

        // Cluster scoped resources ignore the namespace selection.
        let recorder = Recorder::new();
        let subscription = watch::subscribe(
            watch_request(&env.kubeconfig, &env.context, "nodes", None, &["qa-a"]),
            recorder.sink(),
        )
        .await
        .unwrap();
        assert!(!subscription.namespaced);
        assert_eq!(subscription.scopes, vec![String::new()]);
        watch::watch_unsubscribe(subscription.id);

        let error = watch::subscribe(
            watch_request(&env.kubeconfig, &env.context, "doesnotexist", None, &["all"]),
            Recorder::new().sink(),
        )
        .await
        .expect_err("unknown resource");
        eprintln!("QA watch unknown resource: {error}");
        assert!(error.contains("doesnotexist"));

        // A CRD installed after discovery ran is found (discovery is
        // refreshed on a miss, at most every 20 s).
        let crd = r#"{"apiVersion":"apiextensions.k8s.io/v1","kind":"CustomResourceDefinition","metadata":{"name":"gadgets.qa.jet.io"},"spec":{"group":"qa.jet.io","scope":"Namespaced","names":{"plural":"gadgets","singular":"gadget","kind":"Gadget"},"versions":[{"name":"v1","served":true,"storage":true,"schema":{"openAPIV3Schema":{"type":"object","x-kubernetes-preserve-unknown-fields":true}}}]}}"#;
        let _ = kubectl_with(&env.kubeconfig, &["delete", "crd", "gadgets.qa.jet.io", "--ignore-not-found"]);
        kube_client::apply_manifest(
            &env.context,
            "",
            crd.to_string(),
            ManifestMode::Apply,
            Some(env.kubeconfig.clone()),
            None,
        )
        .await
        .expect("create CRD");
        kubectl(&env, &["wait", "--for=condition=Established", "crd/gadgets.qa.jet.io", "--timeout=30s"]);
        let started = Instant::now();
        let mut attempts = 0;
        let subscription = loop {
            attempts += 1;
            match watch::subscribe(
                watch_request(&env.kubeconfig, &env.context, "gadgets", Some("Gadget"), &["all"]),
                Recorder::new().sink(),
            )
            .await
            {
                Ok(subscription) => break subscription,
                Err(e) if started.elapsed() < Duration::from_secs(40) => {
                    if attempts == 1 {
                        eprintln!("QA new CRD not watchable right away: {e}");
                    }
                    tokio::time::sleep(Duration::from_secs(1)).await;
                }
                Err(e) => panic!("new CRD never became watchable: {e}"),
            }
        };
        eprintln!(
            "QA new CRD watchable after {:?} ({} attempts)",
            started.elapsed(),
            attempts
        );
        watch::watch_unsubscribe(subscription.id);
        kubectl(&env, &["delete", "crd", "gadgets.qa.jet.io", "--wait=false"]);
    });
}

/* ---------------------------------------------------------------- RBAC -- */

/// A kubeconfig for ServiceAccount qa-a/jet-limited: pods get/list/watch in
/// qa-a, configmaps get/list (no watch) in qa-a, nothing else.
fn limited_kubeconfig(env: &QaEnv) -> String {
    let rbac = r#"
apiVersion: v1
kind: ServiceAccount
metadata: {name: jet-limited, namespace: qa-a}
---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata: {name: jet-limited, namespace: qa-a}
rules:
- apiGroups: [""]
  resources: [pods]
  verbs: [get, list, watch]
- apiGroups: [""]
  resources: [configmaps]
  verbs: [get, list]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata: {name: jet-limited, namespace: qa-a}
roleRef: {apiGroup: rbac.authorization.k8s.io, kind: Role, name: jet-limited}
subjects:
- {kind: ServiceAccount, name: jet-limited, namespace: qa-a}
"#;
    let dir = std::env::temp_dir().join("jet-qa-rbac");
    std::fs::create_dir_all(&dir).unwrap();
    let manifest = dir.join("rbac.yaml");
    std::fs::write(&manifest, rbac).unwrap();
    kubectl(env, &["apply", "-f", manifest.to_str().unwrap()]);
    let token = kubectl(env, &["-n", "qa-a", "create", "token", "jet-limited", "--duration=1h"]);
    let server = kubectl(env, &["config", "view", "--minify", "--raw", "-o", "jsonpath={.clusters[0].cluster.server}"]);
    let ca = kubectl(env, &["config", "view", "--minify", "--raw", "-o", "jsonpath={.clusters[0].cluster.certificate-authority-data}"]);
    let ca_line = if ca.is_empty() {
        "    insecure-skip-tls-verify: true".to_string()
    } else {
        format!("    certificate-authority-data: {ca}")
    };
    let path = dir.join("kubeconfig");
    std::fs::write(
        &path,
        format!(
            "apiVersion: v1\nkind: Config\nclusters:\n- name: qa\n  cluster:\n    server: {server}\n{ca_line}\nusers:\n- name: limited\n  user:\n    token: {}\ncontexts:\n- name: qa-limited\n  context: {{cluster: qa, user: limited}}\ncurrent-context: qa-limited\n",
            token.trim()
        ),
    )
    .unwrap();
    path.to_string_lossy().into_owned()
}

#[test]
fn rbac_forbidden_and_list_without_watch() {
    let env = require_env!();
    let kubeconfig = limited_kubeconfig(&env);
    block_on(async {
        let subscribe = |resource: &'static str, namespaces: &'static [&'static str]| {
            let kubeconfig = kubeconfig.clone();
            async move {
                let recorder = Recorder::new();
                let started = Instant::now();
                let result = watch::subscribe(
                    watch_request(&kubeconfig, "qa-limited", resource, None, namespaces),
                    recorder.sink(),
                )
                .await;
                (recorder, started, result)
            }
        };

        // Allowed: pods in qa-a.
        let (recorder, started, result) = subscribe("pods", &["qa-a"]).await;
        let subscription = result.expect("subscribe pods qa-a");
        let (at, count) = recorder
            .wait_for(0, Duration::from_secs(30), |m| snapshot_of(m, "qa-a").map(|(at, i)| (at, i.len())))
            .await
            .expect("qa-a snapshot");
        eprintln!("QA RBAC pods in qa-a (allowed): {count} pods after {:?}", at - started);
        watch::watch_unsubscribe(subscription.id);

        // Forbidden: pods in all namespaces -> terminal `forbidden` status
        // (the frontend then polls with kubectl, which reports the error).
        let (recorder, started, result) = subscribe("pods", &["all"]).await;
        let subscription = result.expect("subscribing succeeds, the watcher reports");
        let (at, status) = recorder
            .wait_for(0, Duration::from_secs(30), |m| status_of(m, "forbidden"))
            .await
            .expect("forbidden status");
        eprintln!(
            "QA RBAC pods in all namespaces: forbidden after {:?} (code {}, message: {})",
            at - started,
            status["code"],
            status["message"]
        );
        assert_eq!(status["code"], 403);
        tokio::time::sleep(Duration::from_secs(2)).await;
        let states = recorder.states();
        assert_eq!(
            states.iter().filter(|s| *s == "forbidden").count(),
            1,
            "terminal, no retry storm: {states:?}"
        );
        watch::watch_unsubscribe(subscription.id);

        // Other namespace / resource.
        let (recorder, _, result) = subscribe("deployments", &["qa-a"]).await;
        let subscription = result.expect("subscribe deployments");
        recorder
            .wait_for(0, Duration::from_secs(30), |m| status_of(m, "forbidden"))
            .await
            .expect("deployments forbidden");
        watch::watch_unsubscribe(subscription.id);

        // list allowed, watch forbidden: the initial list succeeds, the
        // watch is rejected -> forbidden (the frontend falls back to polling).
        let (recorder, started, result) = subscribe("configmaps", &["qa-a"]).await;
        let subscription = result.expect("subscribe configmaps");
        let outcome = recorder
            .wait_for(0, Duration::from_secs(30), |m| status_of(m, "forbidden"))
            .await;
        tokio::time::sleep(Duration::from_millis(500)).await;
        eprintln!(
            "QA RBAC configmaps list-without-watch: states {:?}, forbidden after {:?}, snapshot sent: {}",
            recorder.states(),
            outcome.as_ref().map(|(at, _)| *at - started),
            snapshot_of(&recorder.all(), "qa-a").is_some()
        );
        assert!(outcome.is_some(), "list without watch ends as forbidden");
        watch::watch_unsubscribe(subscription.id);

        // Rejected credentials (expired / revoked token).
        let bogus = std::fs::read_to_string(&kubeconfig)
            .unwrap()
            .lines()
            .map(|l| if l.trim_start().starts_with("token:") { "    token: not-a-valid-token".to_string() } else { l.to_string() })
            .collect::<Vec<_>>()
            .join("\n");
        let bogus_path = std::env::temp_dir().join("jet-qa-rbac").join("bogus-kubeconfig");
        std::fs::write(&bogus_path, bogus).unwrap();
        let result = watch::subscribe(
            watch_request(bogus_path.to_str().unwrap(), "qa-limited", "pods", None, &["qa-a"]),
            Recorder::new().sink(),
        )
        .await;
        eprintln!("QA invalid token: subscribe -> {:?}", result.as_ref().err());
        assert!(result.is_err(), "discovery fails with 401 before any watcher starts");

        // Metrics: no metrics API at all.
        let recorder = Recorder::new();
        let id = metrics::subscribe(
            serde_json::from_value(json!({"kubeConfig": kubeconfig, "context": "qa-limited", "namespaces": ["qa-a"]})).unwrap(),
            recorder.sink(),
        )
        .await
        .unwrap();
        let state = recorder
            .wait_for(0, Duration::from_secs(20), |m| {
                m.iter()
                    .find(|(_, m)| m["type"] == "status" && m["state"] != "syncing")
                    .map(|(_, m)| m["state"].as_str().unwrap().to_string())
            })
            .await;
        eprintln!("QA RBAC metrics state: {state:?}");
        metrics::metrics_unsubscribe(id);
    });
}

/* ------------------------------------------------------------- metrics -- */

#[test]
fn metrics_without_metrics_server_are_unavailable() {
    let env = require_env!();
    block_on(async {
        let recorder = Recorder::new();
        let started = Instant::now();
        let id = metrics::subscribe(
            serde_json::from_value(json!({"kubeConfig": env.kubeconfig, "context": env.context, "namespaces": ["all"]})).unwrap(),
            recorder.sink(),
        )
        .await
        .expect("metrics subscribe");
        let (at, status) = recorder
            .wait_for(0, Duration::from_secs(20), |m| status_of(m, "unavailable"))
            .await
            .unwrap_or_else(|| panic!("unavailable status, got {:?}", recorder.states()));
        eprintln!(
            "QA metrics without metrics-server: unavailable after {:?} ({})",
            at - started,
            status["message"]
        );
        assert!(!recorder.all().iter().any(|(_, m)| m["type"] == "sample"));
        metrics::metrics_unsubscribe(id);

        // "" resolves like the explicit path: same poller, no second one.
        let recorder = Recorder::new();
        let id = metrics::subscribe(
            serde_json::from_value(json!({"kubeConfig": env.kubeconfig, "context": env.context, "namespaces": []})).unwrap(),
            recorder.sink(),
        )
        .await
        .unwrap();
        let first = recorder.wait_for(0, Duration::from_secs(1), |m| m.first().cloned()).await.unwrap();
        assert_eq!(first.1["state"], "unavailable", "warm poller replays its state");
        metrics::metrics_unsubscribe(id);
    });
}

/* ----------------------------------------------------------- discovery -- */

#[test]
fn discovery_commands() {
    let env = require_env!();
    block_on(async {
        let kc = Some(env.kubeconfig.clone());
        let started = Instant::now();
        let versions = kube_client::get_core_api_versions(&env.context, kc.clone()).await.unwrap();
        let core = kube_client::get_core_api_resources(&env.context, "v1", kc.clone()).await.unwrap();
        let groups = kube_client::get_api_groups(&env.context, kc.clone()).await.unwrap();
        let widgets = kube_client::get_api_group_resources(&env.context, "qa.jet.io/v1", kc.clone())
            .await
            .unwrap();
        eprintln!(
            "QA discovery: core {:?} ({} resources), {} groups, qa.jet.io/v1 {:?} in {:?}",
            versions,
            core.len(),
            groups.len(),
            widgets.iter().map(|r| r.name.as_str()).collect::<Vec<_>>(),
            started.elapsed()
        );
        assert!(core.iter().any(|r| r.name == "pods"));
        assert!(groups.iter().any(|g| g.name == "qa.jet.io"));
        assert!(widgets.iter().any(|r| r.name == "widgets" && r.short_names.as_deref() == Some(&["wg".to_string()][..])));

        // The WatchHub resolver (aggregated discovery), cached afterwards.
        let client = kube_client::client_with_context(&env.context, Some(&env.kubeconfig)).await.unwrap();
        let key = (env.kubeconfig.clone(), format!("{}-discovery-test", env.context));
        let started = Instant::now();
        let found = watch::discovery::resolve(&client, key.clone(), "widgets", None).await.unwrap();
        let cold = started.elapsed();
        let started = Instant::now();
        watch::discovery::resolve(&client, key.clone(), "deployments", Some("Deployment")).await.unwrap();
        eprintln!("QA watch discovery: cold {:?}, cached {:?}", cold, started.elapsed());
        assert_eq!(found.ar.group, "qa.jet.io");
        assert!(found.namespaced && found.watchable);

        let events = watch::discovery::resolve(&client, key, "events", None).await.unwrap();
        assert_eq!(events.group, "", "core events win over events.k8s.io");
    });
}

/* ----------------------------------------------------------- manifests -- */

#[test]
fn apply_manifest_dry_run_apply_and_errors() {
    let env = require_env!();
    block_on(async {
        let _ = kubectl_with(&env.kubeconfig, &["-n", "qa-a", "delete", "configmap", "jet-qa-apply", "--ignore-not-found"]);
        let manifest = "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: jet-qa-apply\ndata:\n  key: one\n";
        let apply = |manifest: String, mode: ManifestMode, dry_run: bool| {
            kube_client::apply_manifest(
                &env.context,
                "qa-a",
                manifest,
                mode,
                Some(env.kubeconfig.clone()),
                Some(dry_run),
            )
        };

        let started = Instant::now();
        let out = apply(manifest.into(), ManifestMode::Apply, true).await.expect("dry run");
        eprintln!("QA apply_manifest dry run: {:?} in {:?}", out.trim(), started.elapsed());
        assert!(out.contains("server dry run"), "{out}");
        assert!(kubectl_with(&env.kubeconfig, &["-n", "qa-a", "get", "configmap", "jet-qa-apply"]).is_err());

        let out = apply(manifest.into(), ManifestMode::Apply, false).await.expect("apply");
        assert!(out.contains("created"), "{out}");
        let value = kubectl(&env, &["-n", "qa-a", "get", "configmap", "jet-qa-apply", "-o", "jsonpath={.data.key}"]);
        assert_eq!(value, "one");

        // Replace with a stale resourceVersion: conflict surfaced as text.
        let stale = manifest.replace("name: jet-qa-apply", "name: jet-qa-apply\n  resourceVersion: \"1\"");
        let err = apply(stale, ManifestMode::Replace, false).await.expect_err("conflict");
        eprintln!("QA apply_manifest stale replace: {}", err.trim());
        assert!(err.contains("Conflict") || err.contains("modified"), "{err}");

        // Invalid: server side validation via dry run.
        let invalid = manifest.replace("data:\n  key: one", "data:\n  key: [1, 2]");
        let err = apply(invalid, ManifestMode::Apply, true).await.expect_err("invalid");
        eprintln!("QA apply_manifest invalid: {}", err.trim());

        // Empty kubeconfig = the selected / default one (not "--kubeconfig=").
        let err = kube_client::apply_manifest(&env.context, "qa-a", manifest.into(), ManifestMode::Apply, Some(String::new()), Some(true)).await;
        eprintln!("QA apply_manifest with empty kubeconfig: {:?}", err.as_ref().map(|s| s.trim().to_string()));

        kubectl(&env, &["-n", "qa-a", "delete", "configmap", "jet-qa-apply"]);
    });
}

/* ---------------------------------------------------------------- logs -- */

#[derive(Default)]
struct LogEvents(Mutex<Vec<(Instant, LogStreamEvent)>>);

impl EventSink for LogEvents {
    fn send(&self, event: LogStreamEvent) -> bool {
        lock(&self.0).push((Instant::now(), event));
        true
    }
}

impl LogEvents {
    fn added(&self) -> u64 {
        lock(&self.0)
            .iter()
            .map(|(_, e)| match e {
                LogStreamEvent::Appended { added, .. } => *added as u64,
                _ => 0,
            })
            .sum()
    }
}

#[test]
fn multi_pod_log_stream() {
    let env = require_env!();
    block_on(async {
        let session = logging::start_structured_logging_session(vec![]).await;
        let events = Arc::new(LogEvents::default());
        let spec = serde_json::from_value(json!({
            "context": env.context,
            "namespace": "qa-a",
            "kubeConfig": env.kubeconfig,
            "target": {"kind": "selector", "selector": "app=api"},
            "follow": false,
            "tail": 5,
            "maxPods": 25,
        }))
        .unwrap();
        let started = Instant::now();
        start_stream_with(session.clone(), spec, events.clone(), "kubectl").expect("start");

        let deadline = Instant::now() + Duration::from_secs(60);
        while Instant::now() < deadline && !lock(&events.0).iter().any(|(_, e)| *e == LogStreamEvent::Ended) {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        let all = lock(&events.0).clone();
        let first_lines = all
            .iter()
            .find(|(_, e)| matches!(e, LogStreamEvent::Appended { .. }))
            .map(|(at, _)| *at - started);
        let sources = all.iter().rev().find_map(|(_, e)| match e {
            LogStreamEvent::Sources { pods } => Some(pods.clone()),
            _ => None,
        });
        let notices: Vec<String> = all
            .iter()
            .filter_map(|(_, e)| match e {
                LogStreamEvent::Notice { message, .. } => Some(message.clone()),
                _ => None,
            })
            .collect();
        eprintln!(
            "QA multi-pod logs (selector app=api, 80 pods, max 25, tail 5): {} lines, first after {:?}, ended after {:?}, {} sources, notices {:?}",
            events.added(),
            first_lines,
            started.elapsed(),
            sources.as_ref().map_or(0, Vec::len),
            notices
        );
        let sources = sources.expect("sources");
        let mut states = std::collections::BTreeMap::new();
        for pod in &sources {
            *states.entry(format!("{:?}", pod.state)).or_insert(0) += 1;
        }
        eprintln!("QA multi-pod log sources by state: {states:?}");
        assert_eq!(sources.len(), 80, "every matching pod is listed");
        assert_eq!(states.get("Ended"), Some(&25), "capped at maxPods");
        assert_eq!(states.get("Skipped"), Some(&55), "the others are marked skipped, not waiting");
        assert_eq!(events.added(), 25 * 5, "tail 5 from each streamed pod");

        let result = serde_json::to_value(
            logging::get_filtered_data_for_structured_logging_session(session.clone(), "items/18".into(), vec![], None, None, Some(1000)).await,
        )
        .unwrap();
        eprintln!(
            "QA logs search 'items/18': {} of {} lines",
            result["filtered_total"], result["total"]
        );
        assert_eq!(result["filtered_total"], 25);
        let entry = &result["entries"][0];
        eprintln!("QA logs entry sample: {entry}");

        // Follow: a line appended to the (kwok-served) log file reaches every
        // followed pod's stream.
        let follow_events = Arc::new(LogEvents::default());
        let spec = serde_json::from_value(json!({
            "context": env.context,
            "namespace": "qa-b",
            "kubeConfig": env.kubeconfig,
            "target": {"kind": "selector", "selector": "app=cache"},
            "follow": true,
            "tail": 1,
            "maxPods": 10,
        }))
        .unwrap();
        start_stream_with(session.clone(), spec, follow_events.clone(), "kubectl").expect("follow");
        let deadline = Instant::now() + Duration::from_secs(30);
        while follow_events.added() < 10 && Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert_eq!(follow_events.added(), 10, "tail 1 of 10 followed pods");
        let log_file = std::env::var("JET_QA_LOG_FILE").unwrap_or_else(|_| "/tmp/kwok/fake.log".into());
        let appended_at = Instant::now();
        {
            use std::io::Write;
            let mut file = std::fs::OpenOptions::new().append(true).open(&log_file).expect("kwok log file");
            writeln!(
                file,
                "{} stdout F {{\"level\":\"warn\",\"msg\":\"followed line\"}}",
                chrono::Utc::now().format("%Y-%m-%dT%H:%M:%S%.9fZ")
            )
            .unwrap();
        }
        let deadline = Instant::now() + Duration::from_secs(30);
        while follow_events.added() < 20 && Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        eprintln!(
            "QA follow: appended line reached {} of 10 followed pods after {:?}",
            follow_events.added() - 10,
            appended_at.elapsed()
        );
        assert_eq!(follow_events.added(), 20);

        stop_stream(&session);
        logging::end_structured_logging_session(session).await;
    });
}

/* --------------------------------------------------------------- relist -- */

/// Restarts the API server (kwokctl stop / start) under a running watch:
/// the watcher reports errors while it's down, re-lists or resumes, and
/// changes made after the restart arrive as deltas.
#[test]
fn zz_relist_after_api_server_restart() {
    let env = require_env!();
    let Ok(kwokctl) = std::env::var("JET_QA_KWOKCTL") else {
        eprintln!("JET_QA_KWOKCTL not set: restart test skipped");
        return;
    };
    block_on(async {
        let recorder = Recorder::new();
        let subscription = watch::subscribe(
            watch_request(&env.kubeconfig, &env.context, "pods", None, &["qa-b"]),
            recorder.sink(),
        )
        .await
        .unwrap();
        let (_, before_count) = recorder
            .wait_for(0, Duration::from_secs(30), |m| snapshot_of(m, "qa-b").map(|(at, i)| (at, i.len())))
            .await
            .unwrap();

        // Writes elsewhere advance the etcd revision past the watcher's
        // resourceVersion, then compact it away: resuming must get 410.
        for i in 0..20 {
            let _ = kubectl_with(&env.kubeconfig, &["-n", "qa-c", "annotate", "configmap", "web-config", &format!("jet-qa/bump={i}"), "--overwrite"]);
        }
        let started = Instant::now();
        let stop = Command::new(&kwokctl).args(["stop", "cluster", "--name", "jetqa"]).output().unwrap();
        assert!(stop.status.success(), "{}", String::from_utf8_lossy(&stop.stderr));
        // JET_QA_OUTAGE: seconds the API server stays down (default 3).
        let outage = std::env::var("JET_QA_OUTAGE").ok().and_then(|s| s.parse().ok()).unwrap_or(3);
        tokio::time::sleep(Duration::from_secs(outage)).await;
        let start = Command::new(&kwokctl).args(["start", "cluster", "--name", "jetqa", "--wait", "2m"]).output().unwrap();
        assert!(start.status.success(), "{}", String::from_utf8_lossy(&start.stderr));
        let back = started.elapsed();

        // Recovery of the watch itself: the relist completes (ready) and a
        // direct API change (no controller involved) arrives as a delta.
        let back_at = Instant::now();
        let ready_again = recorder
            .wait_for(0, Duration::from_secs(60), |m| {
                let last_error = m.iter().rposition(|(_, m)| m["type"] == "status" && m["state"] == "error")?;
                m[last_error..]
                    .iter()
                    .find(|(_, m)| m["type"] == "status" && m["state"] == "ready")
                    .map(|(at, _)| *at)
            })
            .await
            .expect("ready after the restart");
        let pod = kubectl(&env, &["-n", "qa-b", "get", "pods", "-l", "app=api", "-o", "jsonpath={.items[0].metadata.uid}"]);
        let mark = recorder.len();
        let annotated = Instant::now();
        // A new value every run (an unchanged annotation is no event).
        let annotation = format!("jet-qa/after-restart={}", chrono::Utc::now().timestamp_millis());
        kubectl(&env, &["-n", "qa-b", "annotate", "pods", "-l", "app=api", &annotation, "--overwrite"]);
        let seen = recorder
            .wait_for(mark, Duration::from_secs(30), |m| {
                m.iter()
                    .find(|(_, m)| {
                        m["type"] == "delta"
                            && m["modified"].as_array().unwrap().iter().any(|p| p["metadata"]["uid"] == pod.as_str())
                    })
                    .map(|(at, _)| *at)
            })
            .await;
        eprintln!(
            "QA API server restart: watch ready again {:?} after the cluster was back (relist), direct change seen after {:?}",
            ready_again.saturating_duration_since(back_at),
            seen.map(|at| at - annotated)
        );
        let timeline: Vec<String> = recorder
            .all()
            .iter()
            .filter(|(_, m)| m["type"] == "status")
            .map(|(at, m)| {
                let offset = if *at >= back_at {
                    format!("+{:?}", *at - back_at)
                } else {
                    format!("-{:?}", back_at - *at)
                };
                format!("{} {}", m["state"].as_str().unwrap_or_default(), offset)
            })
            .collect();
        eprintln!("QA API server restart: status timeline (relative to cluster back) {timeline:?}");
        assert!(seen.is_some());

        // A change through a controller (kube-controller-manager re-acquires
        // its leader lease first, ~15 s after a restart).
        let mark = recorder.len();
        kubectl(&env, &["-n", "qa-b", "scale", "deployment/web", "--replicas=82"]);
        let arrived = recorder
            .wait_for(mark, Duration::from_secs(90), |m| (added_count(m) >= 2).then(|| m.last().unwrap().0))
            .await;
        let states = recorder.states();
        eprintln!(
            "QA API server restart: cluster back after {:?}, states {:?}, scaled pods seen {:?} after the restart began",
            back,
            states,
            arrived.map(|at| at - started)
        );
        assert!(arrived.is_some(), "watch recovered after the restart");
        assert!(states.last().is_some_and(|s| s == "ready"), "{states:?}");

        let mark = recorder.len();
        let started = Instant::now();
        kubectl(&env, &["-n", "qa-b", "scale", "deployment/web", "--replicas=80"]);
        // kwok leaves pods deleted right after its restart in Terminating
        // for a long time; the rows must show that, then disappear when the
        // pods are force-deleted.
        let terminating = recorder
            .wait_for(mark, Duration::from_secs(30), |m| {
                let count: usize = m
                    .iter()
                    .filter(|(_, m)| m["type"] == "delta")
                    .flat_map(|(_, m)| m["modified"].as_array().cloned().unwrap_or_default())
                    .filter(|p| !p["metadata"]["deletionTimestamp"].is_null())
                    .count();
                (count >= 2).then(|| m.last().unwrap().0)
            })
            .await;
        eprintln!("QA after restart, scale down -2: terminating rows after {:?}", terminating.map(|at| at - started));
        let stuck = kubectl(&env, &["-n", "qa-b", "get", "pods", "-o", "jsonpath={range .items[?(@.metadata.deletionTimestamp)]}{.metadata.name} {end}"]);
        for pod in stuck.split_whitespace() {
            let _ = kubectl_with(&env.kubeconfig, &["-n", "qa-b", "delete", "pod", pod, "--grace-period=0", "--force"]);
        }
        let recovered = recorder
            .wait_for(mark, Duration::from_secs(60), |m| (deleted_uids(m).len() >= 2).then(|| m.last().unwrap().0))
            .await;
        let after: Vec<String> = recorder.all()[mark..]
            .iter()
            .map(|(at, m)| {
                format!(
                    "{:?} {} +{} ~{} -{}",
                    *at - started,
                    m["type"].as_str().unwrap_or_default(),
                    m["added"].as_array().map_or(0, Vec::len),
                    m["modified"].as_array().map_or(0, Vec::len),
                    m["deleted"].as_array().map_or(0, Vec::len)
                )
            })
            .collect();
        eprintln!("QA after restart, scale down -2: {after:?}");
        assert!(recovered.is_some(), "deletions after the restart arrive");
        assert_eq!(
            count_lines(&kubectl(&env, &["-n", "qa-b", "get", "pods", "--no-headers"])),
            before_count
        );
        watch::watch_unsubscribe(subscription.id);
    });
}

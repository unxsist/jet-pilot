//! Real API server QA of the raw API (`kube_request`), native Helm reads,
//! access reviews, GitOps patches, native port-forwards and Prometheus
//! discovery through the service proxy, against the kwok cluster of the
//! parent module. Self-contained: every test applies what it needs.
//!
//! Setup (no root, no docker; everything under ~/.cache/jp-kwok): kwokctl,
//! kwok, kubectl, helm (3 and/or 4) in ~/.cache/jp-kwok/bin, then
//!
//! ```sh
//! export PATH=~/.cache/jp-kwok/bin:$PATH KWOK_WORKDIR=~/.cache/jp-kwok/work
//! kwokctl create cluster --runtime binary --name jetqa \
//!     --kubeconfig ~/.cache/jp-kwok/kubeconfig \
//!     --enable-crds=PortForward,ClusterPortForward --wait 3m
//! JET_QA_KUBECONFIG=~/.cache/jp-kwok/kubeconfig JET_QA_DIR=~/.cache/jp-kwok/qa \
//!   cargo test --features kwok-qa --bin jet_pilot qa_kwok::api -- --nocapture --test-threads=1
//! ```
//!
//! (from src-tauri, with a `../dist` directory for `generate_context!`).
//!
//! `JET_QA_HELM=helm4` runs the Helm test with another helm binary (its
//! releases go to their own namespace). A local HTTP server (port
//! `JET_QA_BACKEND_PORT`, 18080) stands in for the pods: kwok forwards pod
//! ports to it (`ClusterPortForward`), and pods whose IP is patched to this
//! machine's address (`JET_QA_HOST_IP`, else the default route's) serve
//! the API server's service proxy. Measurements are printed as `QA ...`.

use std::net::IpAddr;
use std::process::Command;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tauri::ipc::{InvokeResponseBody, IpcResponse};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use super::{block_on, kubectl, kubectl_with, qa_env, QaEnv};
use crate::helm;
use crate::kube_api::{kube_request, KubeRequest};
use crate::kubernetes::client::SerializableKubeError;
use crate::port_forward::http::{port_forward_http_request, Header, HttpTestRequest};
use crate::port_forward::{self, ForwardStatus, PortForwardInfo, PortForwardSpec};
use crate::util::lock;

const FIXTURES: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/src/qa_kwok/fixtures");
const NS: &str = "qa-api";

/// Scratch files (kubeconfigs, charts, helm's home).
fn qa_dir() -> std::path::PathBuf {
    let dir = std::env::var("JET_QA_DIR")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|_| std::env::temp_dir().join("jet-qa"));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// `block_on` on a thread with a roomy stack: these test futures need a
/// little more than a test thread's 2 MiB in debug builds.
fn run<F: std::future::Future + Send>(future: F) -> F::Output
where
    F::Output: Send,
{
    std::thread::scope(|scope| {
        std::thread::Builder::new()
            .stack_size(16 << 20)
            .spawn_scoped(scope, || block_on(future))
            .unwrap()
            .join()
            .unwrap_or_else(|panic| std::panic::resume_unwind(panic))
    })
}

fn apply_yaml(env: &QaEnv, name: &str, yaml: &str) {
    let path = qa_dir().join(name);
    std::fs::write(&path, yaml).unwrap();
    kubectl(env, &["apply", "-f", path.to_str().unwrap()]);
}

/* ------------------------------------------------------------ backend -- */

/// The local HTTP server standing in for pods.
struct Backend {
    port: u16,
    host_ip: IpAddr,
}

static BACKEND: OnceLock<Backend> = OnceLock::new();

/// This machine's address on the default route: the API server's service
/// proxy refuses loopback endpoints.
fn host_ip() -> IpAddr {
    if let Ok(ip) = std::env::var("JET_QA_HOST_IP") {
        return ip.parse().expect("JET_QA_HOST_IP");
    }
    // Connecting a UDP socket sends nothing; it only picks the route.
    let socket = std::net::UdpSocket::bind("0.0.0.0:0").unwrap();
    socket.connect("192.0.2.1:9").expect("a default route (or set JET_QA_HOST_IP)");
    socket.local_addr().unwrap().ip()
}

fn backend() -> &'static Backend {
    BACKEND.get_or_init(|| {
        let port = std::env::var("JET_QA_BACKEND_PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(18080);
        let listener = std::net::TcpListener::bind(("0.0.0.0", port)).expect("backend port is free");
        listener.set_nonblocking(true).unwrap();
        tauri::async_runtime::spawn(async move {
            let listener = tokio::net::TcpListener::from_std(listener).unwrap();
            while let Ok((stream, _)) = listener.accept().await {
                tokio::spawn(serve_backend(stream));
            }
        });
        Backend { port, host_ip: host_ip() }
    })
}

const PROM_VECTOR: &str =
    r#"{"status":"success","data":{"resultType":"vector","result":[{"metric":{},"value":[1760000000.123,"7"]}]}}"#;
const PROM_BAD_QUERY: &str =
    r#"{"status":"error","errorType":"bad_data","error":"invalid parameter \"query\": 1:6: parse error: unclosed left parenthesis"}"#;

/// Prometheus' `/api/v1/query` (a `bad` query is rejected like Prometheus
/// does), a JSON 500 that isn't a Kubernetes Status, a text 502, and an
/// echo of the request for everything else.
async fn serve_backend(mut stream: tokio::net::TcpStream) {
    let mut buffer = Vec::new();
    let mut chunk = [0u8; 4096];
    let header_end = loop {
        let Ok(n) = stream.read(&mut chunk).await else { return };
        if n == 0 {
            return;
        }
        buffer.extend_from_slice(&chunk[..n]);
        if let Some(at) = buffer.windows(4).position(|w| w == b"\r\n\r\n") {
            break at + 4;
        }
    };
    let head = String::from_utf8_lossy(&buffer[..header_end]).into_owned();
    let mut lines = head.split("\r\n");
    let mut request_line = lines.next().unwrap_or_default().split(' ');
    let method = request_line.next().unwrap_or_default().to_string();
    let path = request_line.next().unwrap_or_default().to_string();
    let headers: Vec<(String, String)> = lines
        .filter_map(|l| l.split_once(':'))
        .map(|(k, v)| (k.trim().to_ascii_lowercase(), v.trim().to_string()))
        .collect();
    let length: usize = headers
        .iter()
        .find(|(k, _)| k == "content-length")
        .and_then(|(_, v)| v.parse().ok())
        .unwrap_or(0);
    while buffer.len() < header_end + length {
        let Ok(n) = stream.read(&mut chunk).await else { return };
        if n == 0 {
            break;
        }
        buffer.extend_from_slice(&chunk[..n]);
    }
    let body = String::from_utf8_lossy(&buffer[header_end..]).into_owned();

    let (status, content_type, payload) = if path.starts_with("/api/v1/query") && path.contains("bad") {
        (400, "application/json", PROM_BAD_QUERY.to_string())
    } else if path.starts_with("/api/v1/query") {
        (200, "application/json", PROM_VECTOR.to_string())
    } else if path == "/boom" {
        (500, "application/json", r#"{"error":"boom"}"#.to_string())
    } else if path == "/broken" {
        (502, "text/plain", "upstream broke".to_string())
    } else {
        let echoed: serde_json::Map<String, Value> =
            headers.iter().filter(|(k, _)| k.starts_with("x-")).map(|(k, v)| (k.clone(), json!(v))).collect();
        (200, "application/json", json!({"method": method, "path": path, "body": body, "headers": echoed}).to_string())
    };
    let reason = match status {
        200 => "OK",
        400 => "Bad Request",
        500 => "Internal Server Error",
        _ => "Bad Gateway",
    };
    let mut response = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nX-Qa-Backend: yes\r\nConnection: close\r\n\r\n",
        payload.len()
    );
    if method != "HEAD" {
        response.push_str(&payload);
    }
    let _ = stream.write_all(response.as_bytes()).await;
    let _ = stream.shutdown().await;
}

/* -------------------------------------------------------------- setup -- */

static SETUP: OnceLock<()> = OnceLock::new();

/// The fixtures (node, namespaces, deployment, CRDs) and kwok's port
/// forwarding of every pod port 8080 in qa-api to the backend.
fn setup(env: &QaEnv) -> &'static Backend {
    let backend = backend();
    SETUP.get_or_init(|| {
        kubectl(env, &["apply", "-f", FIXTURES]);
        kubectl(env, &["wait", "--for=condition=established", "--timeout=60s", "crd", "--all"]);
        apply_yaml(
            env,
            "port-forward.yaml",
            &format!(
                "apiVersion: kwok.x-k8s.io/v1alpha1\nkind: ClusterPortForward\nmetadata: {{name: jet-qa}}\nspec:\n  selector: {{matchNamespaces: [{NS}, monitoring]}}\n  forwards:\n  - ports: [8080]\n    target: {{address: 127.0.0.1, port: {}}}\n",
                backend.port
            ),
        );
        kubectl(env, &["-n", NS, "rollout", "status", "deployment/web", "--timeout=60s"]);
    });
    backend
}

/// A kubeconfig for ServiceAccount qa-api/jet-qa-limited: `view` in qa-api
/// (through a RoleBinding of the ClusterRole), patching only the ConfigMap
/// `settings`, nothing elsewhere.
fn restricted_kubeconfig(env: &QaEnv) -> String {
    static PATH: OnceLock<String> = OnceLock::new();
    PATH.get_or_init(|| {
        apply_yaml(
            env,
            "restricted.yaml",
            &format!(
                r#"
apiVersion: v1
kind: ServiceAccount
metadata: {{name: jet-qa-limited, namespace: {NS}}}
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata: {{name: jet-qa-view, namespace: {NS}}}
roleRef: {{apiGroup: rbac.authorization.k8s.io, kind: ClusterRole, name: view}}
subjects:
- {{kind: ServiceAccount, name: jet-qa-limited, namespace: {NS}}}
---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata: {{name: jet-qa-settings, namespace: {NS}}}
rules:
- apiGroups: [""]
  resources: [configmaps]
  resourceNames: [settings]
  verbs: [patch]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata: {{name: jet-qa-settings, namespace: {NS}}}
roleRef: {{apiGroup: rbac.authorization.k8s.io, kind: Role, name: jet-qa-settings}}
subjects:
- {{kind: ServiceAccount, name: jet-qa-limited, namespace: {NS}}}
"#
            ),
        );
        let token = kubectl(env, &["-n", NS, "create", "token", "jet-qa-limited", "--duration=2h"]);
        let server = kubectl(env, &["config", "view", "--minify", "--raw", "-o", "jsonpath={.clusters[0].cluster.server}"]);
        let ca = kubectl(
            env,
            &["config", "view", "--minify", "--raw", "-o", "jsonpath={.clusters[0].cluster.certificate-authority-data}"],
        );
        let ca_line = if ca.is_empty() {
            "    insecure-skip-tls-verify: true".to_string()
        } else {
            format!("    certificate-authority-data: {ca}")
        };
        let path = qa_dir().join("restricted-kubeconfig");
        std::fs::write(
            &path,
            format!(
                "apiVersion: v1\nkind: Config\nclusters:\n- name: qa\n  cluster:\n    server: {server}\n{ca_line}\nusers:\n- name: limited\n  user:\n    token: {}\ncontexts:\n- name: qa-limited\n  context: {{cluster: qa, user: limited}}\ncurrent-context: qa-limited\n",
                token.trim()
            ),
        )
        .unwrap();
        path.to_string_lossy().into_owned()
    })
    .clone()
}

/* ------------------------------------------------------- kube_request -- */

/// `kube_request` like `src/lib/kubeApi.ts` calls it.
#[derive(Clone)]
struct Api {
    kubeconfig: String,
    context: String,
}

impl Api {
    fn admin(env: &QaEnv) -> Self {
        Api { kubeconfig: env.kubeconfig.clone(), context: env.context.clone() }
    }

    fn restricted(env: &QaEnv) -> Self {
        Api { kubeconfig: restricted_kubeconfig(env), context: "qa-limited".into() }
    }

    async fn text(
        &self,
        method: &str,
        path: &str,
        body: Option<Value>,
        content_type: Option<&str>,
        accept: Option<&str>,
    ) -> Result<String, SerializableKubeError> {
        let request = KubeRequest {
            method: method.into(),
            path: path.into(),
            body,
            content_type: content_type.map(String::from),
            accept: accept.map(String::from),
        };
        let response = kube_request(&self.context, Some(self.kubeconfig.clone()), request).await?;
        Ok(match response.body().unwrap() {
            InvokeResponseBody::Raw(bytes) => String::from_utf8(bytes).expect("UTF-8 body"),
            InvokeResponseBody::Json(text) => text,
        })
    }

    async fn json(&self, method: &str, path: &str, body: Option<Value>, content_type: Option<&str>) -> Result<Value, SerializableKubeError> {
        let text = self.text(method, path, body, content_type, None).await?;
        Ok(if text.trim().is_empty() { Value::Null } else { serde_json::from_str(&text).expect("JSON body") })
    }

    async fn get(&self, path: &str) -> Result<Value, SerializableKubeError> {
        self.json("GET", path, None, None).await
    }

    async fn post(&self, path: &str, body: Value) -> Result<Value, SerializableKubeError> {
        self.json("POST", path, Some(body), None).await
    }

    /// `kubePatch`: the content type of the patch type, always explicit.
    async fn patch(&self, path: &str, patch: Value, kind: &str) -> Result<Value, SerializableKubeError> {
        let content_type = match kind {
            "merge" => "application/merge-patch+json",
            "json" => "application/json-patch+json",
            "strategic" => "application/strategic-merge-patch+json",
            "apply" => "application/apply-patch+yaml",
            other => panic!("patch type {other}"),
        };
        self.json("PATCH", path, Some(patch), Some(content_type)).await
    }
}

fn describe(err: &SerializableKubeError) -> String {
    format!("{:?} {:?}: {}", err.code, err.reason, err.message)
}

#[test]
fn api_kube_request_crud_patches_and_errors() {
    let env = require_env!();
    setup(&env);
    let api = Api::admin(&env);
    run(async {
        let cms = format!("/api/v1/namespaces/{NS}/configmaps");
        let _ = api.json("DELETE", &format!("{cms}/jet-qa-request"), None, None).await;

        // GET: an object and a list.
        let started = Instant::now();
        let settings = api.get(&format!("{cms}/settings")).await.expect("get");
        eprintln!("QA kube_request GET configmap in {:?}", started.elapsed());
        assert_eq!(settings["data"]["mode"], "blue");
        let list = api.get(&format!("{cms}?labelSelector=missing%3Dlabel")).await.unwrap();
        assert_eq!(list["kind"], "ConfigMapList");
        assert_eq!(list["items"], json!([]));

        // POST (JSON body, application/json), then a conflict.
        let body = json!({"apiVersion": "v1", "kind": "ConfigMap", "metadata": {"name": "jet-qa-request"}, "data": {"a": "1"}});
        let created = api.post(&cms, body.clone()).await.expect("create");
        assert_eq!(created["metadata"]["name"], "jet-qa-request");
        let conflict = api.post(&cms, body).await.expect_err("exists");
        eprintln!("QA kube_request POST existing: {}", describe(&conflict));
        assert_eq!(conflict.code, Some(409));
        assert_eq!(conflict.reason.as_deref(), Some("AlreadyExists"));

        let path = format!("{cms}/jet-qa-request");
        // Merge patch (also the default content type for PATCH).
        let merged = api.patch(&path, json!({"metadata": {"labels": {"jet": "qa"}}, "data": {"b": "2"}}), "merge").await.unwrap();
        assert_eq!(merged["metadata"]["labels"]["jet"], "qa");
        assert_eq!(merged["data"], json!({"a": "1", "b": "2"}));
        let defaulted = api.json("PATCH", &path, Some(json!({"data": {"c": "3"}})), None).await.expect("default merge");
        assert_eq!(defaulted["data"]["c"], "3");
        // JSON patch.
        let patched = api
            .patch(&path, json!([{"op": "replace", "path": "/data/a", "value": "one"}, {"op": "remove", "path": "/data/b"}]), "json")
            .await
            .unwrap();
        assert_eq!(patched["data"], json!({"a": "one", "c": "3"}));
        // A JSON patch whose test fails: 422, not a silent no-op.
        let failed = api
            .patch(&path, json!([{"op": "test", "path": "/data/a", "value": "nope"}]), "json")
            .await
            .expect_err("test op");
        eprintln!("QA kube_request failed JSON patch test: {}", describe(&failed));
        assert_eq!(failed.code, Some(422));
        // Server-side apply (JSON is YAML).
        let applied = api
            .patch(
                &format!("{path}?fieldManager=jet-pilot&force=true"),
                json!({"apiVersion": "v1", "kind": "ConfigMap", "metadata": {"name": "jet-qa-request"}, "data": {"d": "4"}}),
                "apply",
            )
            .await
            .expect("apply patch");
        assert_eq!(applied["data"]["d"], "4");

        // Strategic merge on a deployment: containers merge by name.
        let deployment = format!("/apis/apps/v1/namespaces/{NS}/deployments/web");
        let strategic = api
            .patch(
                &deployment,
                json!({"spec": {"template": {"spec": {"containers": [{"name": "web", "env": [{"name": "JET_QA", "value": "1"}]}]}}}}),
                "strategic",
            )
            .await
            .expect("strategic");
        let container = &strategic["spec"]["template"]["spec"]["containers"][0];
        assert_eq!(container["image"], "fake/web:1", "strategic merge kept the image");
        assert_eq!(container["env"][0]["name"], "JET_QA");
        api.patch(&deployment, json!([{"op": "remove", "path": "/spec/template/spec/containers/0/env"}]), "json")
            .await
            .unwrap();
        // Scale subresource.
        let scale = api.get(&format!("{deployment}/scale")).await.unwrap();
        assert_eq!(scale["kind"], "Scale");

        // A custom resource: create, merge patch; strategic merge is refused.
        let apps = format!("/apis/argoproj.io/v1alpha1/namespaces/{NS}/applications");
        let _ = api.json("DELETE", &format!("{apps}/jet-qa-crd"), None, None).await;
        api.post(&apps, argo_application("jet-qa-crd")).await.expect("create CR");
        let cr = api.patch(&format!("{apps}/jet-qa-crd"), json!({"metadata": {"labels": {"jet": "qa"}}}), "merge").await.unwrap();
        assert_eq!(cr["metadata"]["labels"]["jet"], "qa");
        let unsupported = api
            .patch(&format!("{apps}/jet-qa-crd"), json!({"metadata": {"labels": {"x": "y"}}}), "strategic")
            .await
            .expect_err("no strategic merge for CRs");
        eprintln!("QA kube_request strategic merge on a CR: {}", describe(&unsupported));
        assert_eq!(unsupported.code, Some(415));
        // Server-side validation of a CR.
        let invalid = api
            .patch(&format!("{apps}/jet-qa-crd"), json!({"spec": {"destination": {"server": 42}}}), "merge")
            .await
            .expect_err("invalid CR");
        eprintln!("QA kube_request invalid CR patch: {}", describe(&invalid));
        assert_eq!(invalid.code, Some(422));

        // Table output (Accept header).
        let table = api
            .text("GET", &cms, None, None, Some("application/json;as=Table;v=v1;g=meta.k8s.io"))
            .await
            .unwrap();
        let table: Value = serde_json::from_str(&table).unwrap();
        assert_eq!(table["kind"], "Table");

        // DELETE: the object (or a Status) comes back.
        let deleted = api.json("DELETE", &path, None, None).await.expect("delete");
        assert!(deleted["kind"] == "ConfigMap" || deleted["kind"] == "Status", "{deleted}");
        api.json("DELETE", &format!("{apps}/jet-qa-crd"), None, None).await.unwrap();

        // Not found, an unknown API, a bad request.
        let missing = api.get(&format!("{cms}/does-not-exist")).await.expect_err("404");
        eprintln!("QA kube_request missing object: {}", describe(&missing));
        assert_eq!(missing.code, Some(404));
        assert_eq!(missing.reason.as_deref(), Some("NotFound"));
        assert!(missing.message.contains("does-not-exist"), "{}", missing.message);
        let unknown = api.get("/apis/nope.example.com/v1/things").await.expect_err("unknown API");
        eprintln!("QA kube_request unknown API: {}", describe(&unknown));
        assert_eq!(unknown.code, Some(404));
        let bad = api.get(&format!("{cms}?labelSelector=%3D%3D%3D")).await.expect_err("bad selector");
        eprintln!("QA kube_request bad selector: {}", describe(&bad));
        assert_eq!(bad.code, Some(400));
        let rejected = api.get("https://example.com/api").await.expect_err("not an API path");
        assert_eq!(rejected.code, Some(400));

        // The restricted service account: 403 with the API server's words.
        let restricted = Api::restricted(&env);
        let pods = restricted.get(&format!("/api/v1/namespaces/{NS}/pods")).await.expect("view allows pods");
        assert_eq!(pods["kind"], "PodList");
        let forbidden = restricted.get("/apis/apps/v1/namespaces/monitoring/deployments").await.expect_err("403");
        eprintln!("QA kube_request forbidden: {}", describe(&forbidden));
        assert_eq!(forbidden.code, Some(403));
        assert_eq!(forbidden.reason.as_deref(), Some("Forbidden"));
        assert!(forbidden.message.contains("system:serviceaccount:qa-api:jet-qa-limited"), "{}", forbidden.message);
        assert!(forbidden.auth.is_none(), "a 403 is not a sign-in problem");
        let named = restricted
            .patch(&format!("{cms}/settings"), json!({"metadata": {"annotations": {"jet-qa/touched": "yes"}}}), "merge")
            .await
            .expect("patch allowed by resourceNames");
        assert_eq!(named["metadata"]["annotations"]["jet-qa/touched"], "yes");

        // Rejected credentials: 401 with the sign-in context filled in.
        let bogus_path = qa_dir().join("bogus-kubeconfig");
        let bogus: String = std::fs::read_to_string(&restricted.kubeconfig)
            .unwrap()
            .lines()
            .map(|l| if l.trim_start().starts_with("token:") { "    token: not-a-valid-token" } else { l })
            .collect::<Vec<_>>()
            .join("\n");
        std::fs::write(&bogus_path, bogus).unwrap();
        let bogus = Api { kubeconfig: bogus_path.to_string_lossy().into_owned(), context: "qa-limited".into() };
        let unauthorized = bogus.get(&format!("{cms}/settings")).await.expect_err("401");
        eprintln!(
            "QA kube_request invalid token: {} (auth: {})",
            describe(&unauthorized),
            serde_json::to_string(&unauthorized.auth).unwrap()
        );
        assert_eq!(unauthorized.code, Some(401));
        assert!(unauthorized.auth.is_some(), "401s carry the context for sign-in");
    });
}

/* -------------------------------------------- service proxy + metrics -- */

/// A bare pod in `namespace` that kwok runs, with its IP then set to this
/// machine's so the API server's proxy reaches the backend (or nothing).
fn proxied_pod(env: &QaEnv, backend: &Backend, namespace: &str, name: &str, app: &str, port: u16) {
    let _ = kubectl_with(&env.kubeconfig, &["-n", namespace, "delete", "pod", name, "--ignore-not-found", "--wait=true"]);
    apply_yaml(
        env,
        &format!("{name}.yaml"),
        &format!(
            "apiVersion: v1\nkind: Pod\nmetadata: {{name: {name}, namespace: {namespace}, labels: {{app: {app}}}}}\nspec:\n  containers:\n  - name: main\n    image: fake/prometheus:1\n    ports: [{{name: web, containerPort: {port}}}]\n"
        ),
    );
    kubectl(env, &["-n", namespace, "wait", "--for=condition=Ready", &format!("pod/{name}"), "--timeout=60s"]);
    let ip = backend.host_ip.to_string();
    let status = json!({"status": {"podIP": ip, "podIPs": [{"ip": ip}]}}).to_string();
    kubectl(env, &["-n", namespace, "patch", "pod", name, "--subresource=status", "--type=merge", "-p", &status]);
}

fn wait_for_endpoint(env: &QaEnv, namespace: &str, service: &str, ip: &str) {
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let addresses = kubectl(
            env,
            &["-n", namespace, "get", "endpointslices", "-l", &format!("kubernetes.io/service-name={service}"), "-o", "jsonpath={..addresses}"],
        );
        if addresses.contains(ip) {
            return;
        }
        assert!(Instant::now() < deadline, "{service} has no endpoint at {ip}: {addresses}");
        std::thread::sleep(Duration::from_millis(200));
    }
}

/// `serviceProxyPath` of src/lib/kubeApi.ts.
fn service_proxy_path(namespace: &str, service: &str, port: &str, path: &str) -> String {
    format!("/api/v1/namespaces/{namespace}/services/http:{service}:{port}/proxy{path}")
}

#[test]
fn api_service_proxy_and_metrics_discovery() {
    let env = require_env!();
    let backend = setup(&env);
    let ip = backend.host_ip.to_string();
    proxied_pod(&env, backend, "monitoring", "prometheus-k8s-0", "jet-qa-prometheus", backend.port);
    // Nothing listens on the port of this one.
    proxied_pod(&env, backend, "monitoring", "prometheus-down-0", "jet-qa-prometheus-down", 1);
    apply_yaml(
        &env,
        "monitoring-services.yaml",
        r#"
apiVersion: v1
kind: Service
metadata: {name: prometheus-k8s, namespace: monitoring, labels: {app.kubernetes.io/name: prometheus}}
spec:
  selector: {app: jet-qa-prometheus}
  ports: [{name: web, port: 9090, targetPort: web}]
---
apiVersion: v1
kind: Service
metadata: {name: prometheus-down, namespace: monitoring}
spec:
  selector: {app: jet-qa-prometheus-down}
  ports: [{name: web, port: 9090, targetPort: web}]
---
apiVersion: v1
kind: Service
metadata: {name: prometheus-empty, namespace: monitoring}
spec:
  selector: {app: nothing-matches}
  ports: [{name: web, port: 9090}]
"#,
    );
    wait_for_endpoint(&env, "monitoring", "prometheus-k8s", &ip);
    wait_for_endpoint(&env, "monitoring", "prometheus-down", &ip);
    let api = Api::admin(&env);
    run(async {
        // Discovery step 1 (src/lib/metrics/discovery.ts): every service.
        let started = Instant::now();
        let services = api.get("/api/v1/services").await.expect("list services");
        eprintln!("QA metrics discovery: service list in {:?}", started.elapsed());
        assert_eq!(services["kind"], "ServiceList");
        let prometheus = services["items"]
            .as_array()
            .unwrap()
            .iter()
            .find(|s| s["metadata"]["name"] == "prometheus-k8s")
            .expect("prometheus-k8s listed");
        eprintln!(
            "QA metrics discovery: prometheus-k8s as listed: metadata {} spec.ports {} spec.clusterIP {}",
            json!({"name": prometheus["metadata"]["name"], "namespace": prometheus["metadata"]["namespace"], "labels": prometheus["metadata"]["labels"]}),
            prometheus["spec"]["ports"],
            prometheus["spec"]["clusterIP"]
        );
        assert_eq!(prometheus["metadata"]["namespace"], "monitoring");
        assert_eq!(prometheus["spec"]["ports"][0]["name"], "web");
        assert_eq!(prometheus["spec"]["ports"][0]["port"], 9090);
        assert_eq!(prometheus["spec"]["ports"][0]["protocol"], "TCP");
        assert!(prometheus["spec"]["clusterIP"].is_string());

        // Step 2: the ping, `count(up)` as URLSearchParams encodes it.
        let ping = service_proxy_path("monitoring", "prometheus-k8s", "web", "/api/v1/query?query=count%28up%29");
        let started = Instant::now();
        let answer = api.get(&ping).await.expect("ping through the service proxy");
        eprintln!("QA metrics ping through the service proxy: {answer} in {:?}", started.elapsed());
        assert_eq!(answer["status"], "success");
        // By port number too.
        let by_number = service_proxy_path("monitoring", "prometheus-k8s", "9090", "/api/v1/query?query=up");
        assert_eq!(api.get(&by_number).await.expect("port number")["status"], "success");

        // Prometheus rejects a query: 400 with its JSON as the message.
        let bad = service_proxy_path("monitoring", "prometheus-k8s", "web", "/api/v1/query?query=bad%28");
        let rejected = api.get(&bad).await.expect_err("400");
        eprintln!("QA metrics rejected query: {}", describe(&rejected));
        assert_eq!(rejected.code, Some(400));
        let body: Value = serde_json::from_str(&rejected.message).expect("the message is Prometheus' JSON");
        assert_eq!(body["errorType"], "bad_data");

        // A JSON 500 that isn't a Kubernetes Status, and a text 502.
        let boom = api.get(&service_proxy_path("monitoring", "prometheus-k8s", "web", "/boom")).await.expect_err("500");
        eprintln!("QA service proxy JSON 500: {}", describe(&boom));
        assert_eq!(boom.code, Some(500));
        assert!(boom.message.contains("boom"), "the upstream body is the message: {}", describe(&boom));
        let broken = api.get(&service_proxy_path("monitoring", "prometheus-k8s", "web", "/broken")).await.expect_err("502");
        eprintln!("QA service proxy text 502: {}", describe(&broken));
        assert_eq!(broken.code, Some(502));
        assert_eq!(broken.message, "upstream broke");

        // Nothing listening, no endpoints, no such service.
        let refused = api
            .get(&service_proxy_path("monitoring", "prometheus-down", "web", "/api/v1/query?query=up"))
            .await
            .expect_err("refused");
        eprintln!("QA service proxy, nothing listening: {}", describe(&refused));
        assert_eq!(refused.code, Some(503));
        assert!(refused.message.contains("error trying to reach service"), "{}", refused.message);
        let empty = api
            .get(&service_proxy_path("monitoring", "prometheus-empty", "web", "/api/v1/query?query=up"))
            .await
            .expect_err("no endpoints");
        eprintln!("QA service proxy, no endpoints: {}", describe(&empty));
        assert_eq!(empty.code, Some(503));
        assert!(empty.message.contains("no endpoints available"), "{}", empty.message);
        let missing = api
            .get(&service_proxy_path("monitoring", "prometheus-nope", "web", "/api/v1/query?query=up"))
            .await
            .expect_err("404");
        eprintln!("QA service proxy, no such service: {}", describe(&missing));
        assert_eq!(missing.code, Some(404));
        assert!(missing.message.contains("services \"prometheus-nope\" not found"), "{}", missing.message);

        // A kwok pod's own IP: nothing there (kwok pods can't serve HTTP).
        let kwok_pod = kubectl(&env, &["-n", NS, "get", "pods", "-l", "app=web", "-o", "jsonpath={.items[0].metadata.name}"]);
        let started = Instant::now();
        let unreachable = api
            .get(&format!("/api/v1/namespaces/{NS}/pods/{kwok_pod}:8080/proxy/"))
            .await
            .expect_err("kwok pod");
        eprintln!("QA pod proxy to a kwok pod IP: {} after {:?}", describe(&unreachable), started.elapsed());

        // The restricted account: no service list, no service proxy.
        let restricted = Api::restricted(&env);
        let listing = restricted.get("/api/v1/services").await.expect_err("403 list");
        assert_eq!(listing.code, Some(403));
        let proxy = restricted.get(&ping).await.expect_err("403 proxy");
        eprintln!("QA service proxy, restricted: {}", describe(&proxy));
        assert_eq!(proxy.code, Some(403));
    });
}

/* --------------------------------------------------------------- RBAC -- */

#[test]
fn api_access_reviews_admin_and_restricted() {
    let env = require_env!();
    setup(&env);
    let admin = Api::admin(&env);
    let restricted = Api::restricted(&env);
    run(async {
        // Exactly the bodies src/lib/accessReview.ts posts.
        let ssar = |attributes: Value| {
            json!({"apiVersion": "authorization.k8s.io/v1", "kind": "SelfSubjectAccessReview", "spec": attributes})
        };
        let can_i = |api: Api, spec: Value| async move {
            api.post("/apis/authorization.k8s.io/v1/selfsubjectaccessreviews", ssar(spec)).await.expect("SSAR")
        };
        let resource = |verb: &str, group: &str, resource: &str, namespace: Option<&str>| {
            let mut attributes = json!({"verb": verb, "group": group, "resource": resource});
            if let Some(namespace) = namespace {
                attributes["namespace"] = json!(namespace);
            }
            json!({"resourceAttributes": attributes})
        };

        let review = can_i(admin.clone(), resource("delete", "apps", "deployments", Some(NS))).await;
        eprintln!("QA SSAR admin delete deployments: status {}", review["status"]);
        assert_eq!(review["status"]["allowed"], true);

        let review = can_i(restricted.clone(), resource("list", "", "pods", Some(NS))).await;
        eprintln!("QA SSAR restricted list pods: status {}", review["status"]);
        assert_eq!(review["status"]["allowed"], true);
        assert_eq!(
            review["status"]["reason"],
            "RBAC: allowed by RoleBinding \"jet-qa-view/qa-api\" of ClusterRole \"view\" to ServiceAccount \"jet-qa-limited/qa-api\""
        );

        let named = json!({"resourceAttributes": {"verb": "patch", "group": "", "resource": "configmaps", "name": "settings", "namespace": NS}});
        let review = can_i(restricted.clone(), named).await;
        eprintln!("QA SSAR restricted patch configmap/settings: status {}", review["status"]);
        assert_eq!(review["status"]["allowed"], true);

        let review = can_i(restricted.clone(), resource("create", "", "pods", Some(NS))).await;
        eprintln!("QA SSAR restricted create pods: status {}", review["status"]);
        assert_eq!(review["status"]["allowed"], false);
        let subresource = json!({"resourceAttributes": {"verb": "create", "group": "", "resource": "pods", "subresource": "portforward", "namespace": NS}});
        let review = can_i(restricted.clone(), subresource).await;
        eprintln!("QA SSAR restricted create pods/portforward: status {}", review["status"]);
        assert_eq!(review["status"]["allowed"], false);
        let review = can_i(restricted.clone(), json!({"nonResourceAttributes": {"verb": "get", "path": "/healthz"}})).await;
        eprintln!("QA SSAR restricted get /healthz: status {}", review["status"]);
        assert_eq!(review["status"]["allowed"], true);

        // What the restricted account may do in qa-api.
        let rules = restricted
            .post(
                "/apis/authorization.k8s.io/v1/selfsubjectrulesreviews",
                json!({"apiVersion": "authorization.k8s.io/v1", "kind": "SelfSubjectRulesReview", "spec": {"namespace": NS}}),
            )
            .await
            .expect("SSRR");
        let status = &rules["status"];
        eprintln!(
            "QA SSRR restricted: {} resource rules, {} non-resource rules, incomplete {}, evaluationError {:?}; sample {} / {}",
            status["resourceRules"].as_array().map_or(0, Vec::len),
            status["nonResourceRules"].as_array().map_or(0, Vec::len),
            status["incomplete"],
            status["evaluationError"],
            status["resourceRules"][0],
            status["nonResourceRules"][0]
        );
        assert_eq!(status["incomplete"], false);
        let resource_rules = status["resourceRules"].as_array().unwrap();
        assert!(resource_rules.iter().all(|r| r["verbs"].is_array() && r["apiGroups"].is_array() && r["resources"].is_array()));
        assert!(resource_rules.iter().any(|r| r["resourceNames"] == json!(["settings"]) && r["verbs"] == json!(["patch"])));
        assert!(status["nonResourceRules"].as_array().unwrap().iter().all(|r| r["nonResourceURLs"].is_array()));

        // Who am I.
        for (who, api) in [("admin", &admin), ("restricted", &restricted)] {
            let review = api
                .post(
                    "/apis/authentication.k8s.io/v1/selfsubjectreviews",
                    json!({"apiVersion": "authentication.k8s.io/v1", "kind": "SelfSubjectReview"}),
                )
                .await
                .expect("SelfSubjectReview");
            eprintln!("QA SelfSubjectReview {who}: userInfo {}", review["status"]["userInfo"]);
            assert!(review["status"]["userInfo"]["username"].is_string());
            assert!(review["status"]["userInfo"]["groups"].is_array());
        }
        let beta = admin
            .post(
                "/apis/authentication.k8s.io/v1beta1/selfsubjectreviews",
                json!({"apiVersion": "authentication.k8s.io/v1beta1", "kind": "SelfSubjectReview"}),
            )
            .await;
        eprintln!("QA SelfSubjectReview v1beta1: {:?}", beta.as_ref().map(|_| "served").map_err(describe));
    });
}

/* ------------------------------------------------------------- GitOps -- */

fn argo_application(name: &str) -> Value {
    json!({
        "apiVersion": "argoproj.io/v1alpha1",
        "kind": "Application",
        "metadata": {"name": name},
        "spec": {
            "project": "default",
            "source": {"repoURL": "https://example.com/repo.git", "path": "apps/web", "targetRevision": "main"},
            "destination": {"server": "https://kubernetes.default.svc", "namespace": NS}
        }
    })
}

#[test]
fn api_gitops_patches_as_the_front_end_sends_them() {
    let env = require_env!();
    setup(&env);
    let api = Api::admin(&env);
    run(async {
        let flux = format!("/apis/kustomize.toolkit.fluxcd.io/v1/namespaces/{NS}/kustomizations");
        let git = format!("/apis/source.toolkit.fluxcd.io/v1/namespaces/{NS}/gitrepositories");
        let releases = format!("/apis/helm.toolkit.fluxcd.io/v2/namespaces/{NS}/helmreleases");
        let apps = format!("/apis/argoproj.io/v1alpha1/namespaces/{NS}/applications");
        for path in [format!("{flux}/jet-qa"), format!("{git}/jet-qa"), format!("{releases}/jet-qa"), format!("{apps}/jet-qa")] {
            let _ = api.json("DELETE", &path, None, None).await;
        }
        api.post(
            &git,
            json!({"apiVersion": "source.toolkit.fluxcd.io/v1", "kind": "GitRepository", "metadata": {"name": "jet-qa"},
                   "spec": {"interval": "5m", "url": "https://example.com/repo.git", "ref": {"branch": "main"}}}),
        )
        .await
        .expect("GitRepository");
        api.post(
            &flux,
            json!({"apiVersion": "kustomize.toolkit.fluxcd.io/v1", "kind": "Kustomization", "metadata": {"name": "jet-qa"},
                   "spec": {"interval": "10m", "path": "./apps", "prune": true, "sourceRef": {"kind": "GitRepository", "name": "jet-qa"}}}),
        )
        .await
        .expect("Kustomization");
        api.post(
            &releases,
            json!({"apiVersion": "helm.toolkit.fluxcd.io/v2", "kind": "HelmRelease", "metadata": {"name": "jet-qa"},
                   "spec": {"interval": "10m", "chart": {"spec": {"chart": "web", "sourceRef": {"kind": "HelmRepository", "name": "jet-qa"}}}}}),
        )
        .await
        .expect("HelmRelease");
        api.post(&apps, argo_application("jet-qa")).await.expect("Application");

        // reconcile(): the annotation on the sources first, then the delivery.
        let token = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let annotation = json!({"metadata": {"annotations": {"reconcile.fluxcd.io/requestedAt": token}}});
        for path in [format!("{git}/jet-qa"), format!("{flux}/jet-qa"), format!("{releases}/jet-qa")] {
            let patched = api.patch(&path, annotation.clone(), "merge").await.expect("reconcile annotation");
            assert_eq!(patched["metadata"]["annotations"]["reconcile.fluxcd.io/requestedAt"], token.as_str(), "{path}");
        }

        // setSuspended().
        for suspend in [true, false] {
            for path in [format!("{flux}/jet-qa"), format!("{releases}/jet-qa")] {
                let patched = api.patch(&path, json!({"spec": {"suspend": suspend}}), "merge").await.expect("suspend");
                assert_eq!(patched["spec"]["suspend"], suspend, "{path}");
            }
        }

        // sync(): the operation the application controller picks up.
        let app = format!("{apps}/jet-qa");
        let synced = api
            .patch(&app, json!({"operation": {"initiatedBy": {"username": "jet-pilot"}, "sync": {}}}), "merge")
            .await
            .expect("sync");
        eprintln!("QA Argo sync patch stored operation: {}", synced["operation"]);
        assert_eq!(synced["operation"], json!({"initiatedBy": {"username": "jet-pilot"}, "sync": {}}), "kept as sent (not pruned)");
        // The controller clears it when done; with prune:
        api.patch(&app, json!({"operation": null}), "merge").await.unwrap();
        let pruned = api
            .patch(&app, json!({"operation": {"initiatedBy": {"username": "jet-pilot"}, "sync": {"prune": true}}}), "merge")
            .await
            .expect("sync with prune");
        assert_eq!(pruned["operation"]["sync"], json!({"prune": true}));

        // refresh(): the annotation; the front end reads the new resourceVersion.
        for mode in ["normal", "hard"] {
            let refreshed = api
                .patch(&app, json!({"metadata": {"annotations": {"argocd.argoproj.io/refresh": mode}}}), "merge")
                .await
                .expect("refresh");
            assert_eq!(refreshed["metadata"]["annotations"]["argocd.argoproj.io/refresh"], mode);
            assert!(refreshed["metadata"]["resourceVersion"].as_str().is_some_and(|v| !v.is_empty()));
        }

        // The pending-action tracker watches `plural.group` names.
        for resource in ["kustomizations.kustomize.toolkit.fluxcd.io", "applications.argoproj.io"] {
            let recorder = super::Recorder::new();
            let subscription = crate::watch::subscribe(
                super::watch_request(&env.kubeconfig, &env.context, resource, None, &[NS]),
                recorder.sink(),
            )
            .await
            .expect("subscribe");
            let count = recorder
                .wait_for(0, Duration::from_secs(20), |m| super::snapshot_of(m, NS).map(|(_, items)| items.len()))
                .await
                .unwrap_or_else(|| panic!("{resource} snapshot, states {:?}", recorder.states()));
            eprintln!("QA GitOps watch {resource}: {count} in the snapshot");
            assert!(count >= 1);
            crate::watch::watch_unsubscribe(subscription.id);
        }

        for path in [format!("{flux}/jet-qa"), format!("{git}/jet-qa"), format!("{releases}/jet-qa"), app] {
            api.json("DELETE", &path, None, None).await.unwrap();
        }
    });
}

/* --------------------------------------------------------------- Helm -- */

struct Helm {
    binary: String,
    kubeconfig: String,
    context: String,
    home: std::path::PathBuf,
}

impl Helm {
    fn command(&self, driver: &str, args: &[&str]) -> Command {
        let mut command = Command::new(&self.binary);
        command
            .args(args)
            .args(["--kube-context", &self.context])
            .env("KUBECONFIG", &self.kubeconfig)
            .env("HELM_DRIVER", driver)
            .env("HELM_CACHE_HOME", self.home.join("cache"))
            .env("HELM_CONFIG_HOME", self.home.join("config"))
            .env("HELM_DATA_HOME", self.home.join("data"));
        command
    }

    fn run(&self, driver: &str, args: &[&str]) -> Result<String, String> {
        let output = self.command(driver, args).output().map_err(|e| format!("{}: {e}", self.binary))?;
        if output.status.success() {
            Ok(String::from_utf8_lossy(&output.stdout).into_owned())
        } else {
            Err(String::from_utf8_lossy(&output.stderr).into_owned())
        }
    }

    fn ok(&self, args: &[&str]) -> String {
        self.run("secret", args).unwrap_or_else(|e| panic!("helm {args:?}: {e}"))
    }

    fn json(&self, args: &[&str]) -> Value {
        serde_json::from_str(&self.ok(args)).unwrap_or_else(|e| panic!("helm {args:?}: {e}"))
    }
}

fn millis(time: &str) -> i64 {
    chrono::DateTime::parse_from_rfc3339(time).unwrap().timestamp_millis()
}

#[test]
fn api_helm_reads_match_the_helm_cli() {
    let env = require_env!();
    setup(&env);
    let binary = std::env::var("JET_QA_HELM").unwrap_or_else(|_| "helm".into());
    let dir = qa_dir().join(format!("helm-{}", binary.replace('/', "_")));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let helm = Helm {
        binary: binary.clone(),
        kubeconfig: env.kubeconfig.clone(),
        context: env.context.clone(),
        home: dir.join("home"),
    };
    let version = helm.ok(&["version", "--short"]);
    let major = version.trim().trim_start_matches('v').split('.').next().unwrap_or("x").to_string();
    let ns = format!("qa-helm{major}");
    eprintln!("QA helm: {} ({}) in {ns}", version.trim(), binary);
    let _ = kubectl_with(&env.kubeconfig, &["delete", "namespace", &ns, "--ignore-not-found", "--wait=true", "--timeout=90s"]);

    // A local chart with a values schema and an icon.
    let chart = dir.join("qa-web");
    helm.ok(&["create", chart.to_str().unwrap()]);
    let chart_yaml = chart.join("Chart.yaml");
    let mut metadata = std::fs::read_to_string(&chart_yaml).unwrap();
    metadata.push_str("icon: https://example.com/qa-web.svg\n");
    std::fs::write(&chart_yaml, metadata).unwrap();
    std::fs::write(
        chart.join("values.schema.json"),
        r#"{"$schema": "https://json-schema.org/draft-07/schema#", "type": "object", "properties": {"replicaCount": {"type": "integer", "minimum": 0}}}"#,
    )
    .unwrap();
    // A pre-upgrade hook that never finishes (kwok's pods run forever).
    std::fs::write(
        chart.join("templates/stuck-hook.yaml"),
        "{{- if .Values.stuckHook }}\napiVersion: batch/v1\nkind: Job\nmetadata:\n  name: {{ include \"qa-web.fullname\" . }}-stuck\n  annotations: {helm.sh/hook: pre-upgrade}\nspec:\n  template:\n    spec:\n      restartPolicy: Never\n      containers: [{name: wait, image: fake/wait:1}]\n{{- end }}\n",
    )
    .unwrap();
    let values_a = dir.join("values-a.yaml");
    std::fs::write(&values_a, "replicaCount: 2\nservice:\n  port: 8080\nextra:\n  nested: {a: 1, b: [x, y]}\n").unwrap();
    let values_c = dir.join("values-c.yaml");
    std::fs::write(&values_c, "replicaCount: 1\npodAnnotations: null\nnodeSelector: {kubernetes.io/os: linux}\n").unwrap();
    let chart = chart.to_str().unwrap();
    let common = ["-n", ns.as_str(), "--wait", "--timeout", "60s"];

    let started = Instant::now();
    helm.ok(&[&["install", "qa-web", chart, "--create-namespace", "-f", values_a.to_str().unwrap()][..], &common[..]].concat());
    helm.ok(&[&["upgrade", "qa-web", chart, "--set", "replicaCount=3"][..], &common[..]].concat());
    helm.ok(&[&["upgrade", "qa-web", chart, "-f", values_c.to_str().unwrap()][..], &common[..]].concat());
    // The API server rejects the Service: the release fails.
    let failed = helm.run("secret", &[&["upgrade", "qa-web", chart, "--set", "service.type=Bogus"][..], &common[..]].concat());
    eprintln!("QA helm failing upgrade: {:?}", failed.as_ref().map(|_| "succeeded?").map_err(|e| e.trim().to_string()));
    assert!(failed.is_err(), "the upgrade fails");
    // Uninstalled, history kept: not listed (like helm list).
    helm.ok(&[&["install", "qa-gone", chart][..], &common[..]].concat());
    helm.ok(&["uninstall", "qa-gone", "-n", ns.as_str(), "--keep-history"]);
    // The ConfigMap driver.
    helm.run("configmap", &[&["install", "qa-cm", chart, "--set", "replicaCount=1"][..], &common[..]].concat())
        .expect("configmap driver install");
    // An upgrade whose helm process dies while a hook runs: stuck in pending-upgrade.
    helm.ok(&[&["install", "qa-stuck", chart][..], &common[..]].concat());
    let mut upgrade = helm
        .command("secret", &["upgrade", "qa-stuck", chart, "-n", ns.as_str(), "--set", "stuckHook=true"])
        .stderr(std::process::Stdio::null())
        .spawn()
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(30);
    while kubectl(&env, &["-n", &ns, "get", "secrets", "-l", "name=qa-stuck,status=pending-upgrade", "-o", "name"]).trim().is_empty() {
        assert!(Instant::now() < deadline, "qa-stuck never went pending");
        std::thread::sleep(Duration::from_millis(200));
    }
    upgrade.kill().unwrap();
    let _ = upgrade.wait();
    eprintln!("QA helm: releases installed in {:?}", started.elapsed());

    run(async {
        let kc = Some(env.kubeconfig.clone());
        let started = Instant::now();
        let listed = helm::helm_releases(&env.context, kc.clone(), vec![ns.clone()]).await.expect("helm_releases");
        eprintln!("QA helm_releases ({ns}): {} releases in {:?}", listed.len(), started.elapsed());
        let all = helm::helm_releases(&env.context, kc.clone(), vec!["all".into()]).await.expect("all namespaces");
        let all_here: Vec<_> = all.iter().filter(|r| r.namespace == ns).cloned().collect();
        assert_eq!(all_here, listed, "all namespaces = this namespace");

        // Against `helm list` (both drivers).
        let mut cli: Vec<Value> = helm.json(&["list", "-n", &ns, "-o", "json"]).as_array().unwrap().clone();
        let cm_list = helm.run("configmap", &["list", "-n", &ns, "-o", "json"]).unwrap();
        cli.extend(serde_json::from_str::<Value>(&cm_list).unwrap().as_array().unwrap().clone());
        for pending in helm.json(&["list", "-n", &ns, "--pending", "-o", "json"]).as_array().unwrap() {
            if !cli.iter().any(|r| r["name"] == pending["name"]) {
                cli.push(pending.clone());
            }
        }
        // Helm 4 lists every status by default (Helm 3: deployed and failed);
        // JET Pilot leaves out only uninstalled releases kept for history.
        cli.retain(|r| r["status"] != "uninstalled");
        cli.sort_by_key(|r| r["name"].as_str().unwrap().to_string());
        let names: Vec<&str> = listed.iter().map(|r| r.name.as_str()).collect();
        assert_eq!(names, vec!["qa-cm", "qa-stuck", "qa-web"], "qa-gone (uninstalled) is hidden");
        for (ours, theirs) in listed.iter().zip(&cli) {
            eprintln!("QA helm list: ours {} / helm {}", serde_json::to_string(ours).unwrap(), theirs);
            assert_eq!(ours.name, theirs["name"].as_str().unwrap());
            assert_eq!(ours.revision.to_string(), theirs["revision"].as_str().unwrap());
            assert_eq!(ours.status, theirs["status"].as_str().unwrap());
            assert_eq!(format!("{}-{}", ours.chart, ours.chart_version), theirs["chart"].as_str().unwrap());
            assert_eq!(ours.app_version, theirs["app_version"].as_str().unwrap());
            assert_eq!(ours.icon.as_deref(), Some("https://example.com/qa-web.svg"));
        }
        assert_eq!(listed[0].storage, "configmap");
        assert_eq!((listed[1].status.as_str(), listed[1].revision), ("pending-upgrade", 2));
        assert_eq!(listed[2].storage, "secret");
        assert_eq!((listed[2].status.as_str(), listed[2].revision), ("failed", 4));

        // History against `helm history`.
        let history = helm::helm_history(&env.context, kc.clone(), &ns, "qa-web").await.expect("helm_history");
        let cli = helm.json(&["history", "qa-web", "-n", &ns, "-o", "json"]);
        let mut cli = cli.as_array().unwrap().clone();
        cli.reverse();
        assert_eq!(history.len(), cli.len());
        for (ours, theirs) in history.iter().zip(&cli) {
            eprintln!(
                "QA helm history: ours #{} {} {:?} / helm #{} {} {:?}",
                ours.revision, ours.status, ours.description, theirs["revision"], theirs["status"], theirs["description"]
            );
            assert_eq!(Value::from(ours.revision), theirs["revision"]);
            assert_eq!(ours.status, theirs["status"].as_str().unwrap());
            assert_eq!(ours.description, theirs["description"].as_str().unwrap());
            assert_eq!(format!("{}-{}", ours.chart, ours.chart_version), theirs["chart"].as_str().unwrap());
            assert_eq!(millis(ours.updated.as_deref().unwrap()), millis(theirs["updated"].as_str().unwrap()));
        }
        let gone = helm::helm_history(&env.context, kc.clone(), &ns, "qa-gone").await.expect("uninstalled history");
        assert_eq!(gone[0].status, "uninstalled");

        // Every revision's detail against `helm get`.
        for revision in 1..=4u32 {
            let rev = revision.to_string();
            let detail = helm::helm_release_detail(&env.context, kc.clone(), &ns, "qa-web", Some(revision))
                .await
                .expect("helm_release_detail");
            let get = |what: &str, extra: &[&str]| helm.ok(&[&["get", what, "qa-web", "-n", ns.as_str(), "--revision", rev.as_str()][..], extra].concat());
            let values: Value = serde_json::from_str(&get("values", &["-o", "json"])).unwrap();
            let values = if values.is_null() { json!({}) } else { values };
            let computed: Value = serde_json::from_str(&get("values", &["--all", "-o", "json"])).unwrap();
            assert_eq!(detail.values, values, "user values of #{revision}");
            assert_eq!(detail.computed_values, computed, "computed values of #{revision}");
            assert_eq!(detail.manifest.trim(), get("manifest", &[]).trim(), "manifest of #{revision}");
            let notes = get("notes", &[]);
            assert_eq!(detail.notes.trim(), notes.trim().trim_start_matches("NOTES:").trim(), "notes of #{revision}");
            let hooks = get("hooks", &[]);
            assert_eq!(detail.hooks.len(), hooks.matches("# Source:").count(), "hooks of #{revision}");
            assert_eq!(detail.revision, revision);
            assert_eq!(detail.chart.name, "qa-web");
            assert_eq!(detail.chart.app_version.as_deref(), Some("1.16.0"));
            assert!(detail.values_schema.as_ref().is_some_and(|s| s["properties"]["replicaCount"]["minimum"] == 0));
            assert!(detail.first_deployed.is_some());
            eprintln!(
                "QA helm detail #{revision}: {} · values {} · computed keys {} · manifest {} bytes · notes {} bytes · hooks {:?}",
                detail.status,
                detail.values,
                detail.computed_values.as_object().map_or(0, |o| o.len()),
                detail.manifest.len(),
                detail.notes.len(),
                detail.hooks.iter().map(|h| format!("{} {:?} {}", h.kind, h.events, h.phase)).collect::<Vec<_>>()
            );
        }
        // The latest revision (no revision given) is the failed one.
        let latest = helm::helm_release_detail(&env.context, kc.clone(), &ns, "qa-web", None).await.unwrap();
        assert_eq!((latest.revision, latest.status.as_str()), (4, "failed"));
        assert!(latest.description.contains("Bogus"), "{}", latest.description);
        // From the ConfigMap driver.
        let cm = helm::helm_release_detail(&env.context, kc.clone(), &ns, "qa-cm", None).await.expect("configmap detail");
        assert_eq!(cm.values, json!({"replicaCount": 1}));
        let missing = helm::helm_release_detail(&env.context, kc.clone(), &ns, "qa-nope", None).await.expect_err("404");
        assert_eq!(missing.code, Some(404));

        // The restricted account can't read secrets (view): a clear error.
        let restricted = restricted_kubeconfig(&env);
        let denied = helm::helm_releases("qa-limited", Some(restricted), vec![NS.into()]).await;
        eprintln!("QA helm_releases restricted: {:?}", denied.as_ref().map(|r| r.len()).map_err(describe));
    });
}

/* ------------------------------------------------------- port-forward -- */

#[derive(Default)]
struct Events(Mutex<Vec<(Instant, String, PortForwardInfo)>>);

impl Events {
    fn emit(self: &Arc<Self>) -> Arc<dyn Fn(&'static str, PortForwardInfo) + Send + Sync> {
        let me = self.clone();
        Arc::new(move |event, info| lock(&me.0).push((Instant::now(), event.to_string(), info)))
    }

    fn len(&self) -> usize {
        lock(&self.0).len()
    }

    async fn wait(&self, from: usize, event: &str, timeout: Duration) -> Option<(Instant, PortForwardInfo)> {
        let deadline = Instant::now() + timeout;
        loop {
            if let Some((at, _, info)) = lock(&self.0).iter().skip(from).find(|(_, e, _)| e == event) {
                return Some((*at, info.clone()));
            }
            if Instant::now() > deadline {
                return None;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }

    fn names(&self) -> Vec<String> {
        lock(&self.0).iter().map(|(_, e, info)| format!("{e}({:?})", info.status)).collect()
    }
}

fn forward_spec(kubeconfig: &str, context: &str, kind: &str, name: &str, port: u16) -> PortForwardSpec {
    serde_json::from_value(json!({
        "kubeConfig": kubeconfig,
        "context": context,
        "namespace": NS,
        "objectType": kind,
        "objectName": name,
        "objectPort": port,
        "localPort": 0,
        "address": "127.0.0.1",
    }))
    .unwrap()
}

async fn tester(id: &str, method: &str, path: &str, body: Option<&str>) -> Result<(u16, Value), String> {
    let response = port_forward_http_request(HttpTestRequest {
        id: id.to_string(),
        method: method.into(),
        path: path.into(),
        headers: vec![Header { name: "X-Jet-Qa".into(), value: "tester".into() }],
        body: body.map(String::from),
    })
    .await?;
    let body = if response.body.is_empty() { Value::Null } else { serde_json::from_str(&response.body).unwrap() };
    Ok((response.status, body))
}

#[test]
fn api_native_port_forward_pod_deployment_service() {
    let env = require_env!();
    setup(&env);
    run(async {
        let start = |spec: PortForwardSpec, startup: Duration| async move {
            let events = Arc::new(Events::default());
            let started = Instant::now();
            let id = port_forward::start_for_qa(spec, events.emit(), startup).await.expect("start");
            (id, events, started)
        };
        let pod = kubectl(&env, &["-n", NS, "get", "pods", "-l", "app=web", "-o", "jsonpath={.items[0].metadata.name}"]);

        // A pod.
        let (id, events, started) = start(forward_spec(&env.kubeconfig, &env.context, "pod", &pod, 8080), Duration::from_secs(30)).await;
        let (at, info) = events.wait(0, "port_forward_ready", Duration::from_secs(30)).await.expect("ready");
        eprintln!("QA port-forward pod/{pod}: ready after {:?} on port {}", at - started, info.local_port);
        assert_eq!(info.pod.as_deref(), Some(pod.as_str()));
        let started = Instant::now();
        let (status, body) = tester(&id, "GET", "/hello?x=1", None).await.expect("tester");
        eprintln!("QA HTTP tester GET through the forward: {status} {body} in {:?}", started.elapsed());
        assert_eq!(status, 200);
        assert_eq!(body["path"], "/hello?x=1");
        assert_eq!(body["headers"]["x-jet-qa"], "tester");
        let (status, body) = tester(&id, "POST", "/orders", Some(r#"{"qty":2}"#)).await.unwrap();
        assert_eq!((status, body["method"].as_str(), body["body"].as_str()), (200, Some("POST"), Some(r#"{"qty":2}"#)));
        let (status, body) = tester(&id, "HEAD", "/", None).await.unwrap();
        assert_eq!((status, body), (200, Value::Null));
        let (status, _) = tester(&id, "GET", "/boom", None).await.unwrap();
        assert_eq!(status, 500);
        let listed = port_forward::list_port_forwards().into_iter().find(|f| f.id == id).expect("listed");
        eprintln!("QA port-forward traffic after the tester: {:?}", listed.traffic);
        assert!(listed.traffic.connections >= 4 && listed.traffic.bytes_received > 0);
        port_forward::stop_for_qa(&id);
        assert!(tester(&id, "GET", "/", None).await.is_err(), "stopped");

        // A deployment, then its pod replaced: reconnect to the new one.
        let (id, events, _) = start(forward_spec(&env.kubeconfig, &env.context, "deployment", "web", 8080), Duration::from_secs(30)).await;
        let (_, info) = events.wait(0, "port_forward_ready", Duration::from_secs(30)).await.expect("ready");
        let old = info.pod.clone().unwrap();
        assert_eq!(tester(&id, "GET", "/before", None).await.unwrap().0, 200);
        let mark = events.len();
        let deleted = Instant::now();
        kubectl(&env, &["-n", NS, "delete", "pod", &old, "--wait=false"]);
        let reconnecting = events.wait(mark, "port_forward_reconnecting", Duration::from_secs(30)).await;
        let ready = events.wait(mark, "port_forward_ready", Duration::from_secs(60)).await;
        eprintln!(
            "QA port-forward deployment pod replaced: reconnecting after {:?} ({:?}), ready on {:?} after {:?}, events {:?}",
            reconnecting.as_ref().map(|(at, _)| *at - deleted),
            reconnecting.as_ref().and_then(|(_, i)| i.reason.clone()),
            ready.as_ref().and_then(|(_, i)| i.pod.clone()),
            ready.as_ref().map(|(at, _)| *at - deleted),
            events.names()
        );
        let (_, info) = ready.expect("ready again");
        assert_ne!(info.pod.as_deref(), Some(old.as_str()));
        assert_eq!(info.reconnects, 1);
        eprintln!("QA port-forward last reconnect: {:?}", info.last_reconnect);
        assert_eq!(tester(&id, "GET", "/after", None).await.unwrap().0, 200);
        port_forward::stop_for_qa(&id);
        kubectl(&env, &["-n", NS, "rollout", "status", "deployment/web", "--timeout=60s"]);

        // A service (port 80 -> targetPort http -> 8080 on the pod).
        let (id, events, started) = start(forward_spec(&env.kubeconfig, &env.context, "service", "web", 80), Duration::from_secs(30)).await;
        let (at, info) = events.wait(0, "port_forward_ready", Duration::from_secs(30)).await.expect("ready");
        eprintln!("QA port-forward service/web:80: ready on {:?} after {:?}", info.pod, at - started);
        assert_eq!(tester(&id, "GET", "/svc", None).await.unwrap().0, 200);
        port_forward::stop_for_qa(&id);

        // Nothing listening (kwok has no forward for the port): fails at the deadline.
        let (id, events, started) = start(forward_spec(&env.kubeconfig, &env.context, "pod", &pod_now(&env), 9999), Duration::from_secs(4)).await;
        let (at, info) = events.wait(0, "port_forward_error", Duration::from_secs(20)).await.expect("error");
        eprintln!("QA port-forward nothing listening: {:?} after {:?}", info.error, at - started);
        assert!(info.error.as_deref().unwrap_or_default().contains("Nothing is listening on port 9999"));
        port_forward::stop_for_qa(&id);

        // No such pod; the restricted account.
        let (id, events, _) = start(forward_spec(&env.kubeconfig, &env.context, "pod", "nope", 8080), Duration::from_secs(10)).await;
        let (_, info) = events.wait(0, "port_forward_error", Duration::from_secs(10)).await.expect("error");
        eprintln!("QA port-forward missing pod: {:?}", info.error);
        assert_eq!(info.error.as_deref(), Some("Pod nope doesn't exist in qa-api"));
        port_forward::stop_for_qa(&id);
        let restricted = restricted_kubeconfig(&env);
        let (id, events, _) = start(forward_spec(&restricted, "qa-limited", "pod", &pod_now(&env), 8080), Duration::from_secs(10)).await;
        let (_, info) = events.wait(0, "port_forward_error", Duration::from_secs(10)).await.expect("error");
        eprintln!("QA port-forward restricted: {:?}", info.error);
        assert_eq!(info.status, ForwardStatus::Error);
        assert!(info.error.as_deref().unwrap_or_default().contains("permission"), "{:?}", info.error);
        port_forward::stop_for_qa(&id);
    });
}

fn pod_now(env: &QaEnv) -> String {
    kubectl(env, &["-n", NS, "get", "pods", "-l", "app=web", "--field-selector=status.phase=Running", "-o", "jsonpath={.items[0].metadata.name}"])
}

/* ------------------------------------------------- metrics-server down -- */

/// A registered metrics API whose server is down (crash-looping
/// metrics-server): the API server answers 503, which the poller reports as
/// `unavailable` right away. Last: the broken APIService makes discovery of
/// the whole cluster partial until it's removed.
#[test]
fn api_zz_metrics_server_down_is_unavailable() {
    let env = require_env!();
    setup(&env);
    apply_yaml(
        &env,
        "metrics-apiservice.yaml",
        r#"
apiVersion: v1
kind: Service
metadata: {name: jet-qa-metrics-server, namespace: kube-system}
spec:
  selector: {app: nothing-matches}
  ports: [{port: 443, targetPort: 4443}]
---
apiVersion: apiregistration.k8s.io/v1
kind: APIService
metadata: {name: v1beta1.metrics.k8s.io}
spec:
  service: {name: jet-qa-metrics-server, namespace: kube-system, port: 443}
  group: metrics.k8s.io
  version: v1beta1
  insecureSkipTLSVerify: true
  groupPriorityMinimum: 100
  versionPriority: 100
"#,
    );
    // A kubeconfig of its own: a fresh client and poller.
    let kubeconfig = qa_dir().join("metrics-kubeconfig");
    std::fs::copy(&env.kubeconfig, &kubeconfig).unwrap();
    let kubeconfig = kubeconfig.to_string_lossy().into_owned();
    let outcome = run(async {
        let api = Api { kubeconfig: kubeconfig.clone(), context: env.context.clone() };
        let started = Instant::now();
        let direct = tokio::time::timeout(Duration::from_secs(30), api.get("/apis/metrics.k8s.io/v1beta1/pods")).await;
        eprintln!(
            "QA metrics API with its server down: {:?} after {:?}",
            direct.as_ref().map(|r| r.as_ref().map(|_| "ok").map_err(describe)),
            started.elapsed()
        );

        let recorder = super::Recorder::new();
        let started = Instant::now();
        let id = crate::metrics::subscribe(
            serde_json::from_value(json!({"kubeConfig": kubeconfig, "context": env.context, "namespaces": ["all"]})).unwrap(),
            recorder.sink(),
        )
        .await
        .expect("metrics subscribe");
        let state = recorder
            .wait_for(0, Duration::from_secs(30), |m| {
                m.iter()
                    .find(|(_, m)| m["type"] == "status" && m["state"] != "syncing")
                    .map(|(at, m)| (*at - started, m["state"].as_str().unwrap_or_default().to_string()))
            })
            .await;
        eprintln!("QA metrics poller with metrics-server down: {state:?}");
        crate::metrics::metrics_unsubscribe(id);
        (direct.map(|r| r.map_err(|e| e.code)), state)
    });
    kubectl(&env, &["delete", "apiservice", "v1beta1.metrics.k8s.io"]);
    kubectl(&env, &["-n", "kube-system", "delete", "service", "jet-qa-metrics-server"]);
    let (direct, state) = outcome;
    assert_eq!(direct.expect("answered within 30 s").expect_err("503"), Some(503));
    let (after, state) = state.expect("a state within 30 s");
    assert_eq!(state, "unavailable");
    assert!(after < Duration::from_secs(10), "unavailable after {after:?}");
}

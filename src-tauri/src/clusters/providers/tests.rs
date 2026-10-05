//! Every provider end to end without real clouds: connections, catalog
//! refresh and add, managed entry shapes (no inline secrets, helper
//! arguments, standard exec plugins), in-app minting and credential status
//! against a fake REST server (DigitalOcean, Akamai, Civo, Scaleway, Vultr,
//! Exoscale) and fake `gcloud` / `az` / `doctl` / `kubelogin` scripts on a
//! test `PATH` (unix).

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use base64::Engine;
use jp_auth_core::aws::AwsContext;
use jp_auth_core::cloud::CloudContext;
use jp_auth_core::connections::{ConnectionKind, ConnectionStatus, ExoscaleSettings};
use jp_auth_core::fake::{FakeRequest, FakeResponse, FakeServer};
use kube::config::{ExecConfig, Kubeconfig};
use serde_json::json;

use super::cli::{self, CliTool, TestEnv};
use super::TEST_LOCK;
use crate::auth::status::{statuses, CredentialState, StatusEnv};
use crate::clusters::catalog::{self, CatalogCluster, CatalogEvent};
use crate::clusters::connections::{self, ConnectionPatch, ConnectionSpec};
use crate::clusters::error::AppErrorCode;
use crate::clusters::managed_kubeconfig as managed;
use crate::probe::ContextRef;
use crate::util::lock;

const CERT_PEM: &str = "-----BEGIN CERTIFICATE-----\nCERT\n-----END CERTIFICATE-----\n";
const KEY_PEM: &str = "-----BEGIN EC PRIVATE KEY-----\nKEY\n-----END EC PRIVATE KEY-----\n";
const EXO_SECRET: &str = "exo-good-secret";
/// Secrets that must never reach the managed kubeconfig or the catalog.
const SECRETS: &[&str] = &[
    "dop_v1_good",
    "do-minted-token",
    "linode-good",
    "lke-static-token",
    "civo-good",
    "scw-good",
    "scw-cluster-token",
    "vultr-good",
    EXO_SECRET,
    "LS0tLS1CRUdJTiBFQyBQUklWQVRFIEtFWS0tLS0t",
];

fn b64(text: &str) -> String {
    base64::engine::general_purpose::STANDARD.encode(text)
}

fn token_kubeconfig(name: &str, server: &str, token: &str) -> String {
    format!(
        "apiVersion: v1\nkind: Config\nclusters:\n- cluster:\n    certificate-authority-data: Q0E=\n    server: {server}\n  name: {name}\nusers:\n- name: {name}-admin\n  user:\n    token: {token}\ncontexts:\n- context:\n    cluster: {name}\n    user: {name}-admin\n    namespace: default\n  name: {name}-ctx\ncurrent-context: {name}-ctx\n"
    )
}

fn cert_kubeconfig(name: &str, server: &str) -> String {
    format!(
        "apiVersion: v1\nkind: Config\nclusters:\n- cluster:\n    certificate-authority-data: Q0E=\n    server: {server}\n  name: {name}\nusers:\n- name: {name}-admin\n  user:\n    client-certificate-data: {}\n    client-key-data: {}\ncontexts:\n- context:\n    cluster: {name}\n    user: {name}-admin\n  name: {name}\ncurrent-context: {name}\n",
        b64(CERT_PEM),
        b64(KEY_PEM)
    )
}

fn bearer(req: &FakeRequest) -> &str {
    req.header("authorization")
        .and_then(|a| a.strip_prefix("Bearer "))
        .unwrap_or_default()
}

/// The six REST providers on one fake server.
fn fake_clouds(req: &FakeRequest) -> FakeResponse {
    let path = req.path.as_str();
    let not_found = || FakeResponse::json(404, json!({"message": "not found"}));
    // Exoscale: signed requests.
    if let Some(header) = req
        .header("authorization")
        .filter(|h| h.starts_with("EXO2"))
    {
        let expires: i64 = header
            .split(",expires=")
            .nth(1)
            .and_then(|r| r.split(',').next())
            .and_then(|e| e.parse().ok())
            .unwrap_or_default();
        let expected = jp_auth_core::cloud::exoscale::authorization(
            "EXOgood",
            EXO_SECRET,
            &req.method,
            &req.path,
            &[],
            req.body.as_bytes(),
            expires,
        );
        if header != expected {
            return FakeResponse::json(403, json!({"message": "Invalid key or request signature"}));
        }
        return match (req.method.as_str(), path) {
            ("GET", "/v2/organization") => FakeResponse::json(200, json!({"name": "Acme SA"})),
            ("GET", "/v2/sks-cluster") => FakeResponse::json(
                200,
                json!({"sks-clusters": [
                {"id": "x1", "name": "sks-prod", "version": "1.31.1", "state": "running",
                 "endpoint": "https://x1.sks-ch-gva-2.exo.io:443", "created-at": "2026-04-01T00:00:00Z"}]}),
            ),
            ("GET", "/v2/sks-cluster/x1/authority/control-plane/cert") => {
                FakeResponse::json(200, json!({"cacert": b64(CERT_PEM)}))
            }
            ("POST", "/v2/sks-cluster-kubeconfig/x1") => FakeResponse::json(
                200,
                json!({"kubeconfig": b64(&cert_kubeconfig("sks-prod", "https://x1.sks-ch-gva-2.exo.io:443"))}),
            ),
            _ => not_found(),
        };
    }
    // DigitalOcean
    if bearer(req) == "dop_v1_good" {
        return match path {
            "/v2/account" => FakeResponse::json(
                200,
                json!({"account": {"email": "sammy@example.com", "team": {"name": "Acme"}}}),
            ),
            "/v2/kubernetes/clusters" => FakeResponse::json(
                200,
                json!({"kubernetes_clusters": [
                {"id": "do-c1", "name": "prod", "region": "nyc1", "version": "1.31.1-do.3", "status": {"state": "running"},
                 "endpoint": "https://do-c1.k8s.ondigitalocean.com", "created_at": "2026-01-02T03:04:05Z"}], "links": {}}),
            ),
            "/v2/kubernetes/clusters/do-c1/credentials" => FakeResponse::json(
                200,
                json!({
                "server": "https://do-c1.k8s.ondigitalocean.com", "certificate_authority_data": "Q0E=",
                "token": "do-minted-token", "expires_at": "2099-01-01T00:00:00Z"}),
            ),
            _ => not_found(),
        };
    }
    // Akamai
    if path.starts_with("/v4/") {
        if path == "/v4/regions" {
            return FakeResponse::json(
                200,
                json!({"data": [
                {"id": "us-east", "capabilities": ["Linodes", "Kubernetes"]},
                {"id": "nowhere", "capabilities": ["Linodes"]}]}),
            );
        }
        if bearer(req) != "linode-good" {
            return FakeResponse::json(401, json!({"errors": [{"reason": "Invalid Token"}]}));
        }
        return match path {
            "/v4/profile" => FakeResponse::json(200, json!({"username": "lin-user"})),
            "/v4/lke/clusters" => FakeResponse::json(
                200,
                json!({"page": 1, "pages": 1, "data": [
                {"id": 101, "label": "web", "region": "us-east", "k8s_version": "1.31", "status": "ready", "created": "2026-01-02T03:04:05"},
                {"id": 102, "label": "api", "region": "us-east", "k8s_version": "1.31", "status": "not_ready"}]}),
            ),
            "/v4/lke/clusters/101/kubeconfig" => FakeResponse::json(
                200,
                json!({"kubeconfig": b64(&token_kubeconfig(
                "lke101", "https://101.us-east-1.linodelke.net:443", "lke-static-token-0123456789"))}),
            ),
            "/v4/lke/clusters/102/kubeconfig" => FakeResponse::json(
                503,
                json!({"errors": [{"reason": "Cluster kubeconfig is not yet available."}]}),
            ),
            _ => not_found(),
        };
    }
    // Civo
    if bearer(req) == "civo-good" {
        return match path {
            "/v2/regions" => FakeResponse::json(
                200,
                json!([{"code": "LON1", "features": {"kubernetes": true}}]),
            ),
            "/v2/kubernetes/clusters" => FakeResponse::json(
                200,
                json!({"page": 1, "pages": 1, "items": [
                {"id": "cv1", "name": "k3s", "status": "ACTIVE", "kubernetes_version": "1.30.5-k3s1",
                 "api_endpoint": "https://74.220.0.1:6443", "kubeconfig": "not-stored"}]}),
            ),
            "/v2/kubernetes/clusters/cv1" => FakeResponse::json(
                200,
                json!({"id": "cv1",
                "kubeconfig": cert_kubeconfig("k3s", "https://74.220.0.1:6443")}),
            ),
            _ => not_found(),
        };
    }
    // Scaleway
    if path.starts_with("/k8s/") || path.starts_with("/account/") {
        if req.header("x-auth-token") != Some("scw-good") {
            return FakeResponse::json(401, json!({"message": "authentication is denied"}));
        }
        return match path {
            "/k8s/v1/regions/fr-par/clusters" => FakeResponse::json(
                200,
                json!({"total_count": 1, "clusters": [
                {"id": "s1", "name": "kapsule", "region": "fr-par", "status": "ready", "version": "1.31.2",
                 "cluster_url": "https://s1.api.k8s.fr-par.scw.cloud:6443", "project_id": "11111111-1111-4111-8111-111111111111"}]}),
            ),
            "/k8s/v1/regions/nl-ams/clusters" | "/k8s/v1/regions/pl-waw/clusters" => {
                FakeResponse::json(200, json!({"total_count": 0, "clusters": []}))
            }
            "/k8s/v1/regions/fr-par/clusters/s1/kubeconfig" => FakeResponse::json(
                200,
                json!({"content": b64(&token_kubeconfig(
                "kapsule", "https://s1.api.k8s.fr-par.scw.cloud:6443", "scw-cluster-token"))}),
            ),
            "/account/v3/projects/11111111-1111-4111-8111-111111111111" => {
                FakeResponse::json(200, json!({"name": "default"}))
            }
            _ => not_found(),
        };
    }
    // Vultr
    if bearer(req) == "vultr-good" {
        return match path {
            "/v2/account" => FakeResponse::json(
                200,
                json!({"account": {"name": "Vultr Co", "email": "ops@example.com"}}),
            ),
            "/v2/kubernetes/clusters" => FakeResponse::json(
                200,
                json!({"vke_clusters": [
                {"id": "v1", "label": "vke-a", "region": "ewr", "version": "v1.31.0+1", "status": "active", "endpoint": "v1.vultr-k8s.com"}],
                "meta": {"total": 1, "links": {"next": "", "prev": ""}}}),
            ),
            "/v2/kubernetes/clusters/v1/config" => FakeResponse::json(
                200,
                json!({"kube_config": b64(&cert_kubeconfig("vke-a", "https://v1.vultr-k8s.com:6443"))}),
            ),
            _ => not_found(),
        };
    }
    if path == "/v2/zone" {
        return FakeResponse::json(
            200,
            json!({"zones": [{"name": "ch-gva-2"}, {"name": "de-fra-1"}]}),
        );
    }
    FakeResponse::json(
        401,
        json!({"message": "Unable to authenticate you", "error": "Invalid API token."}),
    )
}

/// The process-wide contexts of a test, reset on drop.
struct Fixture {
    dir: tempfile::TempDir,
    managed: PathBuf,
    aws: AwsContext,
}

impl Fixture {
    fn new(url: &str) -> Fixture {
        let dir = tempfile::tempdir().unwrap();
        let aws = jp_auth_core::aws::fake::test_context(dir.path(), url);
        let cloud: CloudContext =
            jp_auth_core::cloud::test_context(aws.store.clone(), aws.connections_file.clone(), url);
        super::aws::use_test_context(Some(aws.clone()));
        super::use_test_context(Some(cloud));
        crate::secrets::use_test_env(aws.store.env.clone());
        let managed = dir.path().join("managed").join("config");
        catalog::use_test_paths(Some((dir.path().join("catalog.json"), managed.clone())));
        let empty = dir.path().join("empty-path");
        std::fs::create_dir_all(&empty).unwrap();
        cli::use_test_env(Some(TestEnv {
            path: Some(empty.clone().into_os_string()),
            managed_bin: Some(empty),
        }));
        super::api::forget_entry_statuses();
        Fixture { dir, managed, aws }
    }

    fn doc(&self) -> Kubeconfig {
        managed::read(&self.managed).unwrap()
    }

    fn exec_of(&self, context: &str) -> ExecConfig {
        let doc = self.doc();
        let ctx = doc
            .contexts
            .iter()
            .find(|c| c.name == context)
            .unwrap_or_else(|| panic!("no context {context}"))
            .context
            .clone()
            .unwrap();
        doc.auth_infos
            .iter()
            .find(|u| Some(&u.name) == ctx.user.as_ref())
            .unwrap()
            .auth_info
            .clone()
            .unwrap()
            .exec
            .unwrap()
    }

    fn server_of(&self, context: &str) -> (String, String) {
        let doc = self.doc();
        let ctx = doc.contexts.iter().find(|c| c.name == context).unwrap();
        let cluster_name = &ctx.context.as_ref().unwrap().cluster;
        let cluster = doc
            .clusters
            .iter()
            .find(|c| &c.name == cluster_name)
            .unwrap()
            .cluster
            .clone()
            .unwrap();
        (
            cluster.server.unwrap(),
            cluster.certificate_authority_data.unwrap_or_default(),
        )
    }

    fn cluster_id(&self, context: &str) -> String {
        let doc = self.doc();
        managed::meta_of(doc.contexts.iter().find(|c| c.name == context).unwrap())
            .unwrap()
            .id
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        super::aws::use_test_context(None);
        super::use_test_context(None);
        catalog::use_test_paths(None);
        cli::use_test_env(None);
    }
}

type Events = Arc<Mutex<Vec<CatalogEvent>>>;

async fn refresh(ids: Option<Vec<String>>) -> Vec<CatalogEvent> {
    let events: Events = Arc::new(Mutex::new(Vec::new()));
    let log = events.clone();
    catalog::refresh(ids, Arc::new(move |e| log.lock().unwrap().push(e)))
        .await
        .unwrap();
    let events = events.lock().unwrap().clone();
    events
}

fn clusters_of(events: &[CatalogEvent], connection: &str) -> Vec<CatalogCluster> {
    events
        .iter()
        .find_map(|e| match e {
            CatalogEvent::Clusters {
                connection_id,
                clusters,
            } if connection_id == connection => Some(clusters.clone()),
            _ => None,
        })
        .unwrap_or_default()
}

fn args_of(exec: &ExecConfig) -> String {
    exec.args.clone().unwrap_or_default().join(" ")
}

#[tokio::test]
#[allow(clippy::await_holding_lock)]
async fn api_providers_connect_discover_add_and_mint() {
    let _guard = lock(&TEST_LOCK);
    let _vault = lock(&crate::secrets::TEST_VAULT_LOCK);
    let server = FakeServer::start(fake_clouds).await;
    let fx = Fixture::new(&server.url);

    // Tokens are validated, labelled from the account and kept in the vault.
    let token = |provider: &str, token: &str| ConnectionSpec::Token {
        provider: provider.into(),
        label: None,
        token: token.into(),
        project_id: None,
    };
    let digitalocean = connections::connection_create(token("digitalocean", " dop_v1_good "))
        .await
        .unwrap();
    assert_eq!(digitalocean.kind, ConnectionKind::Token);
    assert_eq!(digitalocean.label, "Acme");
    assert_eq!(digitalocean.identity.as_deref(), Some("sammy@example.com"));
    assert_eq!(digitalocean.status, ConnectionStatus::SignedIn);
    assert_eq!(
        fx.aws
            .store
            .get(&format!("conn:{}:api-token", digitalocean.id))
            .unwrap(),
        Some(json!({"token": "dop_v1_good"}))
    );
    let err = connections::connection_create(token("digitalocean", "dop_v1_wrong"))
        .await
        .unwrap_err();
    assert_eq!(err.code, AppErrorCode::InvalidInput);
    assert_eq!(err.field.as_deref(), Some("token"));
    assert!(err.message.contains("did not accept"), "{}", err.message);
    let err = connections::connection_create(token("exoscale", "x"))
        .await
        .unwrap_err();
    assert_eq!(err.field.as_deref(), Some("provider"));

    let linode = connections::connection_create(token("linode", "linode-good"))
        .await
        .unwrap();
    assert_eq!(linode.label, "lin-user");
    let civo = connections::connection_create(token("civo", "civo-good"))
        .await
        .unwrap();
    assert_eq!(civo.label, "Civo");
    let scaleway = connections::connection_create(ConnectionSpec::Token {
        provider: "scaleway".into(),
        label: None,
        token: "scw-good".into(),
        project_id: Some("11111111-1111-4111-8111-111111111111".into()),
    })
    .await
    .unwrap();
    assert_eq!(scaleway.label, "default");
    assert_eq!(
        scaleway.project_id.as_deref(),
        Some("11111111-1111-4111-8111-111111111111")
    );
    let vultr = connections::connection_create(token("vultr", "vultr-good"))
        .await
        .unwrap();
    assert_eq!(vultr.label, "Vultr Co");
    let exoscale = connections::connection_create(ConnectionSpec::ApiKey {
        provider: Some("exoscale".into()),
        label: None,
        key: "EXOgood".into(),
        secret: EXO_SECRET.into(),
        user: None,
        groups: None,
    })
    .await
    .unwrap();
    assert_eq!(exoscale.label, "Acme SA");
    assert_eq!(exoscale.kind, ConnectionKind::ApiKey);
    assert_eq!(
        exoscale.exoscale,
        Some(ExoscaleSettings {
            user: "jet-pilot".into(),
            groups: vec!["system:masters".into()]
        })
    );
    let err = connections::connection_create(ConnectionSpec::ApiKey {
        provider: None,
        label: None,
        key: "EXOgood".into(),
        secret: "wrong".into(),
        user: None,
        groups: None,
    })
    .await
    .unwrap_err();
    assert_eq!(err.field.as_deref(), Some("key"));
    // Exoscale zones all answer from the fake server: scan one.
    let exoscale = connections::connection_update(
        exoscale.id.clone(),
        ConnectionPatch {
            regions: Some(vec!["ch-gva-2".into()]),
            ..ConnectionPatch::default()
        },
    )
    .await
    .unwrap();
    assert_eq!(exoscale.regions, ["ch-gva-2"]);
    let file = std::fs::read_to_string(&fx.aws.connections_file).unwrap();
    for secret in SECRETS {
        assert!(!file.contains(secret), "{secret} in connections.json");
    }

    // Discovery of everything.
    let events = refresh(None).await;
    assert!(matches!(events.last(), Some(CatalogEvent::Done { .. })));
    let names = |id: &str| {
        let mut names: Vec<String> = clusters_of(&events, id)
            .into_iter()
            .map(|c| format!("{}/{}", c.region, c.name))
            .collect();
        names.sort();
        names
    };
    assert_eq!(names(&digitalocean.id), ["nyc1/prod"]);
    assert_eq!(names(&linode.id), ["us-east/api", "us-east/web"]);
    assert_eq!(names(&civo.id), ["LON1/k3s"]);
    assert_eq!(names(&scaleway.id), ["fr-par/kapsule"]);
    assert_eq!(names(&vultr.id), ["ewr/vke-a"]);
    assert_eq!(names(&exoscale.id), ["ch-gva-2/sks-prod"]);
    let do_cluster = &clusters_of(&events, &digitalocean.id)[0];
    assert_eq!(
        do_cluster.key,
        format!("digitalocean:{}:-:nyc1:do-c1", digitalocean.id)
    );
    assert_eq!(do_cluster.provider, "digitalocean");
    assert_eq!(do_cluster.status.as_deref(), Some("running"));
    assert!(events.iter().any(|e| matches!(e,
        CatalogEvent::Progress { connection_id, scope, region: Some(region), .. }
            if *connection_id == civo.id && scope == "Civo · LON1" && region == "LON1")));
    let catalog_text = std::fs::read_to_string(fx.dir.path().join("catalog.json")).unwrap();
    assert!(
        !catalog_text.contains("not-stored"),
        "kubeconfigs are not cached"
    );

    // Add them all.
    let keys: Vec<String> = catalog::catalog_get()
        .await
        .unwrap()
        .clusters
        .into_iter()
        .map(|c| c.key)
        .collect();
    assert_eq!(keys.len(), 7);
    let added = catalog::catalog_add(keys, None).await.unwrap();
    let mut contexts: Vec<&str> = added.added.iter().map(|r| r.context.as_str()).collect();
    contexts.sort();
    assert_eq!(
        contexts,
        [
            "civo-lon1-k3s",
            "do-nyc1-prod",
            "lke-us-east-web",
            "scw-fr-par-kapsule",
            "sks-ch-gva-2-sks-prod",
            "vke-ewr-vke-a"
        ]
    );
    assert_eq!(added.failed.len(), 1);
    assert_eq!(added.failed[0].message, "api is not ready yet (not_ready).");
    assert!(added.warnings.is_empty());

    let helper = jp_auth_core::paths::helper_path();
    let helper = helper.to_string_lossy();
    // DigitalOcean: the helper mints tokens; server + CA from the API.
    let exec = fx.exec_of("do-nyc1-prod");
    assert_eq!(exec.command.as_deref(), Some(helper.as_ref()));
    assert_eq!(
        args_of(&exec),
        format!(
            "credential digitalocean --connection {} --cluster do-c1",
            digitalocean.id
        )
    );
    assert_eq!(
        fx.server_of("do-nyc1-prod"),
        (
            "https://do-c1.k8s.ondigitalocean.com".to_string(),
            "Q0E=".to_string()
        )
    );
    // Exoscale: the helper mints certificates in the cluster's zone.
    let exec = fx.exec_of("sks-ch-gva-2-sks-prod");
    assert_eq!(
        args_of(&exec),
        format!(
            "credential exoscale --connection {} --zone ch-gva-2 --cluster x1",
            exoscale.id
        )
    );
    assert_eq!(
        fx.server_of("sks-ch-gva-2-sks-prod"),
        (
            "https://x1.sks-ch-gva-2.exo.io:443".to_string(),
            b64(CERT_PEM)
        )
    );
    // Static credentials: moved to the vault, the helper reads them.
    for (context, server) in [
        ("lke-us-east-web", "https://101.us-east-1.linodelke.net:443"),
        ("civo-lon1-k3s", "https://74.220.0.1:6443"),
        (
            "scw-fr-par-kapsule",
            "https://s1.api.k8s.fr-par.scw.cloud:6443",
        ),
        ("vke-ewr-vke-a", "https://v1.vultr-k8s.com:6443"),
    ] {
        let id = fx.cluster_id(context);
        let exec = fx.exec_of(context);
        assert_eq!(args_of(&exec), format!("credential static --id {id}"));
        assert_eq!(fx.server_of(context).0, server);
        let stored = fx
            .aws
            .store
            .get(&jp_auth_core::credentials::static_secret_id(&id))
            .unwrap()
            .unwrap();
        let stored: jp_auth_core::credentials::StaticCredential =
            serde_json::from_value(stored).unwrap();
        assert!(!stored.is_empty(), "{context}");
    }
    let lke = fx.cluster_id("lke-us-east-web");
    assert_eq!(
        crate::secrets::static_credential(&lke)
            .unwrap()
            .unwrap()
            .token
            .as_deref(),
        Some("lke-static-token-0123456789")
    );
    let civo_id = fx.cluster_id("civo-lon1-k3s");
    let civo_credential = crate::secrets::static_credential(&civo_id)
        .unwrap()
        .unwrap();
    assert_eq!(civo_credential.client_key_pem.as_deref(), Some(KEY_PEM));

    // The managed kubeconfig: no secrets, cloud metadata for the hub.
    let text = std::fs::read_to_string(&fx.managed).unwrap();
    for secret in SECRETS {
        assert!(!text.contains(secret), "{secret} in the managed kubeconfig");
    }
    let listed = managed::list(&fx.doc());
    let meta = |context: &str| {
        listed
            .iter()
            .find(|c| c.context == context)
            .unwrap()
            .cloud
            .clone()
            .unwrap()
    };
    assert_eq!(meta("vke-ewr-vke-a").provider, "vultr");
    assert_eq!(meta("vke-ewr-vke-a").native_id.as_deref(), Some("v1"));
    assert_eq!(meta("lke-us-east-web").native_id.as_deref(), Some("101"));
    assert_eq!(meta("scw-fr-par-kapsule").account_id, None);
    assert_eq!(meta("sks-ch-gva-2-sks-prod").region, "ch-gva-2");
    let snapshot = catalog::catalog_get().await.unwrap();
    assert_eq!(
        snapshot
            .clusters
            .iter()
            .filter(|c| c.state == catalog::CatalogState::Added)
            .count(),
        6
    );

    // In-app minting: the DigitalOcean token was cached when adding (no
    // new request); Exoscale mints a certificate for jet-pilot.
    let requests = server.requests().len();
    let credential =
        crate::auth::broker::mint(&fx.exec_of("do-nyc1-prod"), Duration::from_secs(10))
            .await
            .unwrap();
    assert_eq!(credential.token.as_deref(), Some("do-minted-token"));
    assert!(credential.expires_at.is_some());
    assert_eq!(server.requests().len(), requests);
    let credential = crate::auth::broker::mint(
        &fx.exec_of("sks-ch-gva-2-sks-prod"),
        Duration::from_secs(10),
    )
    .await
    .unwrap();
    assert_eq!(credential.client_key.as_deref(), Some(KEY_PEM));
    let posts: Vec<FakeRequest> = server
        .requests()
        .into_iter()
        .filter(|r| r.method == "POST")
        .collect();
    assert_eq!(posts.len(), 1);
    assert_eq!(posts[0].json()["user"], "jet-pilot");
    assert_eq!(posts[0].json()["groups"], json!(["system:masters"]));

    // Credential status: minted credentials expire; static ones are valid.
    let env = StatusEnv {
        home: Some(fx.dir.path().join("home")),
        aws_config_file: None,
        now: std::time::SystemTime::now(),
    };
    let target = |context: &str| ContextRef {
        kube_config: fx.managed.to_string_lossy().into_owned(),
        context: context.to_string(),
    };
    let result = statuses(
        vec![
            target("do-nyc1-prod"),
            target("sks-ch-gva-2-sks-prod"),
            target("lke-us-east-web"),
        ],
        &env,
    );
    for status in &result {
        assert_eq!(status.state, CredentialState::Valid, "{}", status.context);
        assert!(!status.can_sign_in, "{}", status.context);
    }
    assert!(result[0].expires_at.unwrap() > 4_000_000_000_000);
    assert!(result[1].expires_at.is_some());

    // A new certificate identity drops the cached certificates.
    let updated = connections::connection_update(
        exoscale.id.clone(),
        ConnectionPatch {
            exoscale: Some(ExoscaleSettings {
                user: "alice".into(),
                groups: vec!["devs".into()],
            }),
            ..ConnectionPatch::default()
        },
    )
    .await
    .unwrap();
    assert_eq!(updated.exoscale.unwrap().user, "alice");
    assert!(fx
        .aws
        .store
        .ids_with_prefix(&format!("cache:exoscale:{}:", exoscale.id))
        .unwrap()
        .is_empty());
    let err = connections::connection_update(
        vultr.id.clone(),
        ConnectionPatch {
            exoscale: Some(ExoscaleSettings::default()),
            ..ConnectionPatch::default()
        },
    )
    .await
    .unwrap_err();
    assert_eq!(err.field.as_deref(), Some("exoscale"));

    // Regions of the pickers (fetched where public).
    assert_eq!(
        super::provider_regions("linode".into()).await.unwrap(),
        ["us-east"]
    );
    assert_eq!(
        super::provider_regions("exoscale".into()).await.unwrap(),
        ["ch-gva-2", "de-fra-1"]
    );
    assert_eq!(
        super::provider_regions("scaleway".into()).await.unwrap(),
        ["fr-par", "nl-ams", "pl-waw"]
    );
    assert!(super::provider_regions("digitalocean".into())
        .await
        .unwrap()
        .contains(&"ams3".to_string()));
    assert!(super::provider_regions("nope".into()).await.is_err());

    // Removing a connection with its clusters forgets their credentials.
    connections::connection_delete(linode.id.clone(), true)
        .await
        .unwrap();
    assert!(fx
        .aws
        .store
        .get(&jp_auth_core::credentials::static_secret_id(&lke))
        .unwrap()
        .is_none());
    assert!(fx
        .aws
        .store
        .ids_with_prefix(&format!("conn:{}:", linode.id))
        .unwrap()
        .is_empty());
    assert!(!fx
        .doc()
        .contexts
        .iter()
        .any(|c| c.name == "lke-us-east-web"));
    connections::connection_delete(digitalocean.id.clone(), false)
        .await
        .unwrap();
    assert!(fx
        .aws
        .store
        .ids_with_prefix(&format!("cache:digitalocean:{}:", digitalocean.id))
        .unwrap()
        .is_empty());
}

/* ------------------------------------------------------------- CLIs */

#[cfg(unix)]
fn script(dir: &Path, name: &str, body: &str) -> PathBuf {
    use std::os::unix::fs::PermissionsExt;
    let path = dir.join(name);
    std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
    path
}

/// Fake CLIs: only shell built-ins (the test `PATH` has nothing else).
#[cfg(unix)]
fn fake_clis(bin: &Path, managed_bin: &Path, log: &Path) {
    let log = log.display();
    script(
        bin,
        "gcloud",
        &format!(
            r#"echo "gcloud $*" >> "{log}"
case "$*" in
  "version --format=json") printf '{{"Google Cloud SDK": "490.0.0"}}\n' ;;
  "auth list"*) printf '[{{"account": "me@example.com", "status": "ACTIVE"}}, {{"account": "ci@example.iam.gserviceaccount.com", "status": ""}}]\n' ;;
  "projects list"*) printf '[{{"projectId": "proj-a", "name": "Project A", "projectNumber": "11", "lifecycleState": "ACTIVE"}}, {{"projectId": "proj-b", "name": "Project B", "lifecycleState": "ACTIVE"}}, {{"projectId": "gone", "lifecycleState": "DELETE_REQUESTED"}}]\n' ;;
  "container clusters list --project=proj-a"*) printf '[{{"name": "gke-prod", "location": "europe-west1", "endpoint": "34.1.2.3", "masterAuth": {{"clusterCaCertificate": "Q0E="}}, "currentMasterVersion": "1.31.1-gke.1", "status": "RUNNING", "createTime": "2026-01-01T00:00:00+00:00", "selfLink": "https://container.googleapis.com/v1/projects/proj-a/locations/europe-west1/clusters/gke-prod"}}, {{"name": "gke-dev", "location": "europe-west1-b", "endpoint": "34.1.2.4", "masterAuth": {{"clusterCaCertificate": "Q0E="}}, "status": "RUNNING"}}]\n' ;;
  "container clusters list --project=proj-b"*) echo "ERROR: (gcloud.container.clusters.list) Kubernetes Engine API has not been used in project proj-b before or it is disabled." >&2; exit 1 ;;
  "auth login --brief --quiet") echo "Your browser has been opened to visit:" >&2; echo "    https://accounts.google.com/o/oauth2/auth?response_type=code&client_id=x&redirect_uri=http%3A%2F%2Flocalhost%3A8085%2F" >&2; echo "You are now logged in as [me@example.com]." >&2 ;;
  *) echo "ERROR: unexpected gcloud $*" >&2; exit 2 ;;
esac"#
        ),
    );
    let aad = "apiVersion: v1\nkind: Config\nclusters:\n- cluster:\n    certificate-authority-data: Q0E=\n    server: https://$name-dns.hcp.westeurope.azmk8s.io:443\n  name: $name\ncontexts:\n- context:\n    cluster: $name\n    user: clusterUser_rg-prod_$name\n  name: $name\ncurrent-context: $name\nusers:\n- name: clusterUser_rg-prod_$name\n  user:\n    exec:\n      apiVersion: client.authentication.k8s.io/v1beta1\n      command: kubelogin\n      args:\n      - get-token\n      - --environment\n      - AzurePublicCloud\n      - --server-id\n      - 6dae42f8-4368-4678-94ff-3960e28e3630\n      - --client-id\n      - 80faf920-1908-4b52-b5ef-a8e7bedfc67a\n      - --tenant-id\n      - 72f988bf-86f1-41af-91ab-2d7cd011db47\n      - --login\n      - devicecode\n";
    let local = format!(
        "apiVersion: v1\nkind: Config\nclusters:\n- cluster:\n    certificate-authority-data: Q0E=\n    server: https://aks-local-dns.hcp.westeurope.azmk8s.io:443\n  name: aks-local\ncontexts:\n- context:\n    cluster: aks-local\n    user: clusterUser_rg-prod_aks-local\n  name: aks-local\ncurrent-context: aks-local\nusers:\n- name: clusterUser_rg-prod_aks-local\n  user:\n    client-certificate-data: {}\n    client-key-data: {}\n    token: aks-local-token-0123456789\n",
        b64(CERT_PEM),
        b64(KEY_PEM)
    );
    let cluster = |name: &str| {
        format!(
            r#"{{"name": "{name}", "location": "westeurope", "resourceGroup": "rg-prod", "fqdn": "{name}-dns.hcp.westeurope.azmk8s.io", "currentKubernetesVersion": "1.30.5", "provisioningState": "Succeeded", "powerState": {{"code": "Running"}}, "id": "/subscriptions/00000000-0000-0000-0000-000000000001/resourcegroups/rg-prod/providers/Microsoft.ContainerService/managedClusters/{name}"}}"#
        )
    };
    script(
        bin,
        "az",
        &format!(
            r#"echo "az $*" >> "{log}"
file=""; name=""
for a in "$@"; do
  case "$a" in
    --file=*) file="${{a#--file=}}" ;;
    --name=*) name="${{a#--name=}}" ;;
  esac
done
case "$*" in
  "version -o json") printf '{{"azure-cli": "2.64.0"}}\n' ;;
  "account list -o json --only-show-errors") printf '[{{"id": "00000000-0000-0000-0000-000000000001", "name": "Sub One", "tenantId": "t1", "isDefault": true, "state": "Enabled", "user": {{"name": "me@example.com", "type": "user"}}}}, {{"id": "00000000-0000-0000-0000-000000000002", "name": "Disabled", "state": "Disabled", "user": {{"name": "me@example.com"}}}}]\n' ;;
  "aks list --subscription=00000000-0000-0000-0000-000000000001 -o json --only-show-errors") printf '[%s, %s, %s]\n' '{prod}' '{local_cluster}' '{nokl}' ;;
  "aks get-credentials"*)
    case "$name" in
      aks-local) printf '%s' '{local}' > "$file" ;;
      *) printf "{aad}" > "$file" ;;
    esac ;;
  "login --use-device-code --output none")
    echo "login experience: $AZURE_CORE_LOGIN_EXPERIENCE_V2"
    echo "WARNING: To sign in, use a web browser to open the page https://microsoft.com/devicelogin and enter the code ABCD1234 to authenticate." >&2 ;;
  *) echo "ERROR: unexpected az $*" >&2; exit 2 ;;
esac"#,
            prod = cluster("aks-prod"),
            local_cluster = cluster("aks-local"),
            nokl = cluster("aks-nokl"),
        ),
    );
    script(
        bin,
        "doctl",
        &format!(
            r#"echo "doctl $*" >> "{log}"
case "$*" in
  "version") echo "doctl version 1.110.0-release" ;;
  "auth list") printf 'default (current)\nwork\n' ;;
  "account get --output json") printf '{{"email": "sammy@example.com"}}\n' ;;
  "kubernetes cluster list --output json"*) printf '[{{"id": "d1-uuid", "name": "do-web", "region": "ams3", "version": "1.31.1-do.3", "status": {{"state": "running"}}, "endpoint": "https://d1-uuid.k8s.ondigitalocean.com", "created_at": "2026-01-01T00:00:00Z"}}]\n' ;;
  "kubernetes cluster kubeconfig show d1-uuid"*) printf 'apiVersion: v1\nclusters:\n- cluster:\n    certificate-authority-data: Q0E=\n    server: https://d1-uuid.k8s.ondigitalocean.com\n  name: do-ams3-do-web\nusers:\n- name: do-ams3-do-web-admin\n  user:\n    token: doctl-shown-token\n' ;;
  *) echo "Error: unexpected doctl $*" >&2; exit 2 ;;
esac"#
        ),
    );
    // Azure kubelogin, installed by JET Pilot.
    script(
        managed_bin,
        "kubelogin",
        &format!(
            r#"echo "kubelogin $*" >> "{log}"
case "$1" in
  --version) printf 'kubelogin version\ngit hash: v0.2.20/abc\n' ;;
  convert-kubeconfig) echo "converted by kubelogin: KUBECONFIG=$KUBECONFIG" >> "{log}" ;;
  *) exit 2 ;;
esac"#
        ),
    );
}

#[cfg(unix)]
#[tokio::test]
#[allow(clippy::await_holding_lock)]
async fn cli_connections_discover_and_add_with_standard_plugins() {
    use crate::clusters::providers::{azure, gcp};
    let _guard = lock(&TEST_LOCK);
    let _vault = lock(&crate::secrets::TEST_VAULT_LOCK);
    let server = FakeServer::start(|_| FakeResponse::json(500, json!({}))).await;
    let fx = Fixture::new(&server.url);
    let bin = fx.dir.path().join("bin");
    let managed_bin = fx.dir.path().join("jp-bin");
    std::fs::create_dir_all(&bin).unwrap();
    std::fs::create_dir_all(&managed_bin).unwrap();
    let log = fx.dir.path().join("cli.log");
    fake_clis(&bin, &managed_bin, &log);
    cli::use_test_env(Some(TestEnv {
        path: Some(bin.clone().into_os_string()),
        managed_bin: Some(managed_bin.clone()),
    }));

    // Statuses (never prompting).
    let gcloud = cli::cloud_cli_status("gcp".into()).await.unwrap();
    assert!(gcloud.installed && gcloud.signed_in, "{gcloud:?}");
    assert_eq!(gcloud.tool, "gcloud");
    assert_eq!(gcloud.version.as_deref(), Some("490.0.0"));
    assert_eq!(gcloud.account.as_deref(), Some("me@example.com"));
    assert_eq!(gcloud.accounts.len(), 2);
    let plugin = gcloud.auth_plugin.clone().unwrap();
    assert_eq!(plugin.name, "gke-gcloud-auth-plugin");
    assert!(!plugin.installed);
    let az = cli::cloud_cli_status("azure".into()).await.unwrap();
    assert_eq!(az.accounts, ["me@example.com"]);
    assert_eq!(az.version.as_deref(), Some("2.64.0"));
    let kubelogin = az.auth_plugin.clone().unwrap();
    assert!(kubelogin.installed && kubelogin.managed, "{kubelogin:?}");
    let doctl = cli::cloud_cli_status("digitalocean".into()).await.unwrap();
    assert_eq!(doctl.accounts, ["default", "work"]);
    assert_eq!(doctl.account.as_deref(), Some("default"));
    assert!(doctl.signed_in && doctl.auth_plugin.is_none());
    let json = serde_json::to_value(&gcloud).unwrap();
    assert_eq!(json["authPlugin"]["name"], "gke-gcloud-auth-plugin");
    assert_eq!(
        json["installUrl"],
        "https://cloud.google.com/sdk/docs/install"
    );
    assert!(cli::cloud_cli_status("aws".into()).await.is_err());

    // Connections.
    let cli_spec = |provider: &str, account: Option<&str>| ConnectionSpec::Cli {
        provider: provider.into(),
        label: None,
        cli_account: account.map(str::to_string),
    };
    let google = connections::connection_create(cli_spec("gcp", Some("me@example.com")))
        .await
        .unwrap();
    assert_eq!(google.kind, ConnectionKind::Cli);
    assert_eq!(google.status, ConnectionStatus::SignedIn);
    assert_eq!(google.label, "me@example.com");
    let err = connections::connection_create(cli_spec("gcp", Some("other@example.com")))
        .await
        .unwrap_err();
    assert_eq!(err.field.as_deref(), Some("cliAccount"));
    let err = connections::connection_create(cli_spec("gcp", Some("me@example.com")))
        .await
        .unwrap_err();
    assert!(err.message.contains("already connected"));
    let azure = connections::connection_create(cli_spec("azure", None))
        .await
        .unwrap();
    assert_eq!(azure.label, "me@example.com");
    let ocean = connections::connection_create(cli_spec("digitalocean", None))
        .await
        .unwrap();
    assert_eq!(ocean.label, "DigitalOcean (default)");
    let err = connections::connection_create(cli_spec("linode", None))
        .await
        .unwrap_err();
    assert_eq!(err.field.as_deref(), Some("provider"));

    // Scopes for the pickers.
    let projects = super::connection_scopes(google.id.clone()).await.unwrap();
    assert_eq!(
        projects.iter().map(|p| p.id.as_str()).collect::<Vec<_>>(),
        ["proj-a", "proj-b"]
    );
    assert_eq!(projects[0].name, "Project A");
    let subscriptions = super::connection_scopes(azure.id.clone()).await.unwrap();
    assert_eq!(subscriptions.len(), 1);
    assert_eq!(subscriptions[0].name, "Sub One");
    assert!(super::connection_scopes(ocean.id.clone()).await.is_err());

    // Discovery: proj-b without the GKE API is complete and empty.
    let events = refresh(None).await;
    let gke: Vec<CatalogCluster> = clusters_of(&events, &google.id);
    assert_eq!(gke.len(), 2);
    assert!(gke.iter().all(|c| c.account_id == "proj-a"));
    assert_eq!(gke[0].account_name.as_deref(), Some("Project A"));
    assert!(events.iter().any(|e| matches!(e,
        CatalogEvent::Progress { message: Some(m), account_id: Some(p), .. }
            if p == "proj-b" && m == "Kubernetes Engine is not enabled")));
    let aks = clusters_of(&events, &azure.id);
    assert_eq!(aks.len(), 3);
    assert_eq!(aks[0].status.as_deref(), Some("Running"));
    assert!(aks[0].key.starts_with(&format!(
        "azure:{}:00000000-0000-0000-0000-000000000001:westeurope:rg-prod/",
        azure.id
    )));
    let ocean_clusters = clusters_of(&events, &ocean.id);
    assert_eq!(ocean_clusters.len(), 1);
    let listed = connections::connections_list().await.unwrap();
    assert!(listed
        .iter()
        .all(|c| c.status == ConnectionStatus::SignedIn));
    let log_text = std::fs::read_to_string(&log).unwrap();
    assert!(log_text.contains("gcloud container clusters list --project=proj-a --format=json --quiet --verbosity=error --account=me@example.com"), "{log_text}");

    // Only proj-a and europe-west1 (zonal clusters included).
    let google = connections::connection_update(
        google.id.clone(),
        ConnectionPatch {
            targets: Some(vec![jp_auth_core::connections::SsoTarget {
                account_id: "proj-a".into(),
                account_name: Some("Project A".into()),
                role_name: String::new(),
            }]),
            regions: Some(vec!["europe-west1".into()]),
            ..ConnectionPatch::default()
        },
    )
    .await
    .unwrap();
    let events = refresh(Some(vec![google.id.clone()])).await;
    assert_eq!(clusters_of(&events, &google.id).len(), 2);

    let key = |clusters: &[CatalogCluster], name: &str| {
        clusters
            .iter()
            .find(|c| c.name == name)
            .unwrap()
            .key
            .clone()
    };

    // GKE without the plugin: added with the bare command and a warning.
    let added = catalog::catalog_add(vec![key(&gke, "gke-prod")], None)
        .await
        .unwrap();
    assert_eq!(added.added[0].context, "gke-europe-west1-gke-prod");
    assert_eq!(added.warnings.len(), 1);
    assert_eq!(added.warnings[0].message, gcp::PLUGIN_MISSING);
    let exec = fx.exec_of("gke-europe-west1-gke-prod");
    assert_eq!(exec.command.as_deref(), Some("gke-gcloud-auth-plugin"));
    assert!(exec.provide_cluster_info);
    assert_eq!(exec.install_hint.as_deref(), Some(gcp::INSTALL_HINT));
    assert_eq!(
        exec.api_version.as_deref(),
        Some("client.authentication.k8s.io/v1beta1")
    );
    assert_eq!(
        exec.env.clone().unwrap()[0]
            .get("value")
            .map(String::as_str),
        Some("me@example.com")
    );
    assert_eq!(
        fx.server_of("gke-europe-west1-gke-prod"),
        ("https://34.1.2.3".to_string(), "Q0E=".to_string())
    );
    // With the plugin: its absolute path.
    let plugin = script(&bin, "gke-gcloud-auth-plugin", "exit 0");
    let added = catalog::catalog_add(vec![key(&gke, "gke-dev")], None)
        .await
        .unwrap();
    assert!(added.warnings.is_empty());
    assert_eq!(added.added[0].context, "gke-europe-west1-b-gke-dev");
    assert_eq!(
        fx.exec_of("gke-europe-west1-b-gke-dev").command.as_deref(),
        plugin.to_str()
    );

    // AKS with Entra ID: get-credentials into a temp file, kubelogin
    // converts, the managed kubelogin runs with the Azure CLI login.
    let added = catalog::catalog_add(vec![key(&aks, "aks-prod"), key(&aks, "aks-local")], None)
        .await
        .unwrap();
    assert!(added.failed.is_empty(), "{:?}", added.failed);
    assert!(added.warnings.is_empty(), "{:?}", added.warnings);
    let exec = fx.exec_of("aks-westeurope-aks-prod");
    assert_eq!(
        exec.command.as_deref(),
        managed_bin.join("kubelogin").to_str()
    );
    assert_eq!(
        args_of(&exec),
        "get-token --login azurecli --server-id 6dae42f8-4368-4678-94ff-3960e28e3630"
    );
    assert_eq!(
        fx.server_of("aks-westeurope-aks-prod").0,
        "https://aks-prod-dns.hcp.westeurope.azmk8s.io:443"
    );
    let log_text = std::fs::read_to_string(&log).unwrap();
    assert!(
        log_text.contains("kubelogin convert-kubeconfig -l azurecli --kubeconfig "),
        "{log_text}"
    );
    assert!(log_text.contains("az aks get-credentials --resource-group=rg-prod --name=aks-prod --subscription=00000000-0000-0000-0000-000000000001 --file="));
    // Local accounts: the client certificate and token go to the vault.
    let exec = fx.exec_of("aks-westeurope-aks-local");
    let id = fx.cluster_id("aks-westeurope-aks-local");
    assert_eq!(args_of(&exec), format!("credential static --id {id}"));
    let stored = crate::secrets::static_credential(&id).unwrap().unwrap();
    assert_eq!(stored.token.as_deref(), Some("aks-local-token-0123456789"));
    assert_eq!(stored.client_certificate_pem.as_deref(), Some(CERT_PEM));
    let text = std::fs::read_to_string(&fx.managed).unwrap();
    assert!(!text.contains("aks-local-token"));
    assert!(!text.contains(&b64(KEY_PEM)));
    // Without kubelogin: converted in-process, with a warning.
    std::fs::remove_file(managed_bin.join("kubelogin")).unwrap();
    let added = catalog::catalog_add(vec![key(&aks, "aks-nokl")], None)
        .await
        .unwrap();
    assert_eq!(added.warnings.len(), 1);
    assert_eq!(added.warnings[0].message, azure::KUBELOGIN_MISSING);
    let exec = fx.exec_of("aks-westeurope-aks-nokl");
    assert_eq!(exec.command.as_deref(), Some("kubelogin"));
    assert_eq!(
        args_of(&exec),
        "get-token --login azurecli --server-id 6dae42f8-4368-4678-94ff-3960e28e3630"
    );
    // No temporary kubeconfig is left behind.
    let leftovers = std::fs::read_dir(std::env::temp_dir())
        .unwrap()
        .flatten()
        .filter(|e| {
            e.file_name()
                .to_string_lossy()
                .starts_with("jet-pilot-aks-")
        })
        .count();
    assert_eq!(leftovers, 0);

    // doctl: its own exec plugin with the current context.
    let added = catalog::catalog_add(vec![ocean_clusters[0].key.clone()], None)
        .await
        .unwrap();
    assert_eq!(added.added[0].context, "do-ams3-do-web");
    let exec = fx.exec_of("do-ams3-do-web");
    assert_eq!(exec.command.as_deref(), bin.join("doctl").to_str());
    assert_eq!(
        args_of(&exec),
        "kubernetes cluster kubeconfig exec-credential --version=v1beta1 --context=default d1-uuid"
    );
    assert_eq!(
        fx.server_of("do-ams3-do-web"),
        (
            "https://d1-uuid.k8s.ondigitalocean.com".to_string(),
            "Q0E=".to_string()
        )
    );
    let text = std::fs::read_to_string(&fx.managed).unwrap();
    assert!(!text.contains("doctl-shown-token"));

    // Credential status: GKE signs in with gcloud.
    let env = StatusEnv {
        home: Some(fx.dir.path().join("home")),
        aws_config_file: None,
        now: std::time::SystemTime::now(),
    };
    let status = &statuses(
        vec![ContextRef {
            kube_config: fx.managed.to_string_lossy().into_owned(),
            context: "gke-europe-west1-gke-prod".into(),
        }],
        &env,
    )[0];
    assert!(status.can_sign_in);
    assert_eq!(status.sign_in_label.as_deref(), Some("Sign in with gcloud"));
}

#[cfg(unix)]
#[tokio::test]
#[allow(clippy::await_holding_lock)]
async fn cli_sign_ins_stream_device_codes_and_urls() {
    use crate::auth::login::LoginEvent;
    let _guard = lock(&TEST_LOCK);
    let _vault = lock(&crate::secrets::TEST_VAULT_LOCK);
    let _env = lock(&crate::paths::TEST_ENV_LOCK);
    let server = FakeServer::start(|_| FakeResponse::json(500, json!({}))).await;
    let fx = Fixture::new(&server.url);
    // The sign-in refreshes contexts of the managed kubeconfig: a test one.
    std::env::set_var(jp_auth_core::paths::HOME_ENV, fx.dir.path());
    let bin = fx.dir.path().join("bin");
    let unused = fx.dir.path().join("jp-bin-unused");
    std::fs::create_dir_all(&bin).unwrap();
    std::fs::create_dir_all(&unused).unwrap();
    let log = fx.dir.path().join("cli.log");
    fake_clis(&bin, &unused, &log);
    cli::use_test_env(Some(TestEnv {
        path: Some(bin.clone().into_os_string()),
        managed_bin: None,
    }));

    let run = |tool: CliTool| {
        let events = Arc::new(Mutex::new(Vec::new()));
        let sink_events = events.clone();
        let sink: crate::auth::login::LoginSink = Arc::new(move |event| {
            sink_events.lock().unwrap().push(event);
            true
        });
        let (args, plan) = cli::sign_in_command(tool).unwrap();
        let id = cli::start_sign_in(tool, bin.join(tool.binary()), args, plan, sink);
        (id, events)
    };
    let wait = |events: &Arc<Mutex<Vec<LoginEvent>>>| {
        let events = events.clone();
        async move {
            for _ in 0..200 {
                let done =
                    events.lock().unwrap().iter().any(|e| {
                        matches!(e, LoginEvent::Succeeded { .. } | LoginEvent::Failed { .. })
                    });
                if done {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
            let events = events.lock().unwrap().clone();
            events
        }
    };

    let (id, events) = run(CliTool::Az);
    assert!(!id.is_empty());
    let events = wait(&events).await;
    assert_eq!(
        events.first(),
        Some(&LoginEvent::Started {
            command: "az login --use-device-code --output none".into()
        })
    );
    assert!(events.contains(&LoginEvent::DeviceCode {
        user_code: "ABCD1234".into(),
        verification_uri: "https://microsoft.com/devicelogin".into(),
        verification_uri_complete: None,
    }));
    // The subscription picker is off (it would wait for input).
    assert!(events.iter().any(|e| matches!(e,
        LoginEvent::Line { text, .. } if text == "login experience: off")));
    assert!(matches!(
        events.last(),
        Some(LoginEvent::Succeeded { expires_at: None })
    ));

    let (_, events) = run(CliTool::Gcloud);
    let events = wait(&events).await;
    assert!(events.iter().any(|e| matches!(e,
        LoginEvent::Url { url } if url.starts_with("https://accounts.google.com/o/oauth2/auth"))));
    assert!(matches!(events.last(), Some(LoginEvent::Succeeded { .. })));

    let err = cli::sign_in_command(CliTool::Doctl).unwrap_err();
    assert_eq!(err.code, AppErrorCode::InvalidInput);
    assert!(err.message.contains("API token"));

    std::env::remove_var(jp_auth_core::paths::HOME_ENV);
}

/// Windows finds the CLIs' `.cmd` shims (`gcloud.cmd`, `az.cmd`).
#[cfg(windows)]
#[test]
fn finds_cmd_shims_on_windows() {
    let _guard = lock(&TEST_LOCK);
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("gcloud.cmd"), "@echo off\r\n").unwrap();
    cli::use_test_env(Some(TestEnv {
        path: Some(dir.path().as_os_str().to_owned()),
        managed_bin: None,
    }));
    let found = cli::find("gcloud").unwrap();
    assert!(found
        .to_string_lossy()
        .to_ascii_lowercase()
        .ends_with("gcloud.cmd"));
    cli::use_test_env(None);
}

#[test]
fn cli_outputs_are_parsed() {
    let (contexts, current) = cli::parse_doctl_contexts("default\nwork (current)\n\nbad name\n");
    assert_eq!(contexts, ["default", "work"]);
    assert_eq!(current.as_deref(), Some("work"));
    assert_eq!(
        cli::parse_json("WARNING: something\n[{\"a\": 1}]\ntrailing"),
        Some(json!([{"a": 1}]))
    );
    assert_eq!(cli::parse_json("no json"), None);

    let mut exec = ExecConfig {
        command: Some("/usr/local/bin/kubelogin".into()),
        args: Some(
            [
                "get-token",
                "--environment",
                "AzurePublicCloud",
                "--server-id=abc",
                "--login",
                "devicecode",
            ]
            .map(String::from)
            .to_vec(),
        ),
        env: Some(vec![[
            ("name".to_string(), "AAD_LOGIN_METHOD".to_string()),
            ("value".to_string(), "devicecode".to_string()),
        ]
        .into()]),
        ..ExecConfig::default()
    };
    assert!(super::azure::to_azurecli(&mut exec));
    assert_eq!(args_of(&exec), "get-token --login azurecli --server-id abc");
    assert!(exec.env.is_none());
    let mut other = ExecConfig {
        command: Some("aws".into()),
        args: Some(vec!["eks".into(), "get-token".into()]),
        ..ExecConfig::default()
    };
    assert!(!super::azure::to_azurecli(&mut other));
    assert!(super::azure::valid_subscription_id(
        "00000000-0000-0000-0000-000000000001"
    ));
    assert!(!super::azure::valid_subscription_id("--subscription"));
    assert!(super::gcp::valid_project_id("example.com:my-project"));
    assert!(!super::gcp::valid_project_id("-x"));
    assert!(super::doctl::valid_context("default"));
    assert!(!super::doctl::valid_context("--access-token"));
}

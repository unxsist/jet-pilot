//! The cloud API clients against the fake server: pagination, auth
//! headers, retries, error mapping, minting and its vault cache, and the
//! Exoscale request signature.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use base64::Engine;
use serde_json::json;

use super::http::{allowed, ApiRequest};
use super::mint::{self, MintedCredential};
use super::*;
use crate::connections::{
    self as store, api_key_secret_id, api_token_secret_id, CloudConnection, ConnectionKind,
    ConnectionStatus, ExoscaleSettings,
};
use crate::fake::{FakeRequest, FakeResponse, FakeServer};
use crate::request::{DigitaloceanArgs, ExoscaleArgs};
use crate::vault::{KdfParams, MemoryKeychain, MemoryUnlockCache, VaultEnv};

const CERT_B64: &str =
    "LS0tLS1CRUdJTiBDRVJUSUZJQ0FURS0tLS0tCkNFUlQKLS0tLS1FTkQgQ0VSVElGSUNBVEUtLS0tLQo=";
const KEY_B64: &str =
    "LS0tLS1CRUdJTiBFQyBQUklWQVRFIEtFWS0tLS0tCktFWQotLS0tLUVORCBFQyBQUklWQVRFIEtFWS0tLS0tCg==";

fn b64(text: &str) -> String {
    base64::engine::general_purpose::STANDARD.encode(text)
}

fn context(dir: &std::path::Path, url: &str) -> CloudContext {
    let store = Store::new(
        VaultEnv {
            dir: dir.join("vault"),
            keychain: Arc::new(MemoryKeychain::new()),
            unlock_cache: Arc::new(MemoryUnlockCache::default()),
            kdf: KdfParams::INSECURE_FOR_TESTS,
        },
        None,
    );
    test_context(store, dir.join("connections.json"), url)
}

fn connection(id: &str, provider: &str, kind: ConnectionKind) -> CloudConnection {
    CloudConnection {
        id: id.into(),
        provider: provider.into(),
        kind,
        label: provider.into(),
        identity: None,
        sso: None,
        profile: None,
        region: None,
        regions: vec![],
        targets: vec![],
        cli_account: None,
        project_id: None,
        exoscale: None,
        status: ConnectionStatus::SignedIn,
        expires_at: None,
        message: None,
        created_at: 0,
    }
}

fn add_connection(ctx: &CloudContext, connection: CloudConnection) {
    store::update::<_, std::io::Error>(&ctx.connections_file, |list| {
        list.push(connection);
        Ok(())
    })
    .unwrap();
}

fn bearer(req: &FakeRequest) -> Option<&str> {
    req.header("authorization")?.strip_prefix("Bearer ")
}

#[test]
fn hosts_are_allowlisted_per_provider() {
    let dir = tempfile::tempdir().unwrap();
    let mut ctx = context(dir.path(), "http://127.0.0.1:9");
    ctx.endpoint = None;
    let ok = |p: Provider, url: &str| allowed(&ctx, p, url);
    assert!(ok(
        Provider::DigitalOcean,
        "https://api.digitalocean.com/v2/account"
    ));
    assert!(ok(
        Provider::DigitalOcean,
        "https://api.digitalocean.com:443/v2/account"
    ));
    assert!(!ok(
        Provider::DigitalOcean,
        "http://api.digitalocean.com/v2/account"
    ));
    assert!(!ok(
        Provider::DigitalOcean,
        "https://api.digitalocean.com:8443/v2"
    ));
    assert!(!ok(
        Provider::DigitalOcean,
        "https://api.linode.com/v4/profile"
    ));
    assert!(!ok(
        Provider::DigitalOcean,
        "https://evil@api.digitalocean.com/v2"
    ));
    assert!(!ok(
        Provider::DigitalOcean,
        "https://api.digitalocean.com.evil.io/v2"
    ));
    assert!(ok(
        Provider::Linode,
        "https://api.linode.com/v4/lke/clusters"
    ));
    assert!(ok(Provider::Civo, "https://api.civo.com/v2/regions"));
    assert!(ok(
        Provider::Scaleway,
        "https://api.scaleway.com/k8s/v1/regions/fr-par/clusters"
    ));
    assert!(ok(Provider::Vultr, "https://api.vultr.com/v2/account"));
    assert!(ok(
        Provider::Exoscale,
        "https://api-ch-gva-2.exoscale.com/v2/sks-cluster"
    ));
    assert!(ok(
        Provider::Exoscale,
        "https://api-de-fra-1.exoscale.com/v2/zone"
    ));
    assert!(!ok(
        Provider::Exoscale,
        "https://api-ch_gva.exoscale.com/v2"
    ));
    assert!(!ok(Provider::Exoscale, "https://api.exoscale.com.evil/v2"));
    assert!(!ok(
        Provider::Exoscale,
        "https://evil.com/api-ch-gva-2.exoscale.com/v2"
    ));

    // A test endpoint only covers URLs below it.
    let ctx = context(dir.path(), "http://127.0.0.1:4000");
    assert!(allowed(
        &ctx,
        Provider::Vultr,
        "http://127.0.0.1:4000/v2/account"
    ));
    assert!(!allowed(
        &ctx,
        Provider::Vultr,
        "http://127.0.0.1:40000/v2/account"
    ));

    assert_eq!(
        loopback_endpoint("http://127.0.0.1:8080/").as_deref(),
        Some("http://127.0.0.1:8080")
    );
    assert!(loopback_endpoint("http://localhost:1").is_some());
    for bad in [
        "https://127.0.0.1:8080",
        "http://10.0.0.1:80",
        "http://127.0.0.1",
        "http://evil.com:80",
        "http://127.0.0.1:80/x",
    ] {
        assert_eq!(loopback_endpoint(bad), None, "{bad}");
    }
}

/// Computed independently with Python's hmac (see the module docs of
/// `exoscale`): the messages are the two examples of the Exoscale
/// signature documentation, signed with a made-up secret:
///
/// ```text
/// python3 -c "import hmac,hashlib,base64; print(base64.b64encode(hmac.new(
///   b'Gjq2O4GmXbrVwWiwvSaXAX4pkXhJyK8Dl7zuvkJ8rIw',
///   b'GET /v2/resource/a02baf5a-a3e4-49a0-857b-8a08d276c1c0\n\nv1v2\n\n1599140767',
///   hashlib.sha256).digest()).decode())"
/// ```
#[test]
fn exoscale_signature_matches_the_documented_scheme() {
    let secret = "Gjq2O4GmXbrVwWiwvSaXAX4pkXhJyK8Dl7zuvkJ8rIw";
    assert_eq!(
        exoscale::authorization(
            "EXO29147e9f89102b7ac1e88514",
            secret,
            "GET",
            "/v2/resource/a02baf5a-a3e4-49a0-857b-8a08d276c1c0",
            &[("p2", "v2"), ("p1", "v1")],
            b"",
            1_599_140_767,
        ),
        "EXO2-HMAC-SHA256 credential=EXO29147e9f89102b7ac1e88514,signed-query-args=p1;p2,expires=1599140767,signature=iySgamuwvts0vmltyqBfonKPaMk6hdLUtE/jsf9Mac0="
    );
    assert_eq!(
        exoscale::authorization(
            "EXO29147e9f89102b7ac1e88514",
            secret,
            "POST",
            "/v2/security-group",
            &[],
            br#"{"name": "my-security-group"}"#,
            1_599_140_767,
        ),
        "EXO2-HMAC-SHA256 credential=EXO29147e9f89102b7ac1e88514,expires=1599140767,signature=NXg7zm51sncCLHq+vWfQ6aaJC06Lvr94RrdznIh8MvM="
    );
    // Multi-valued parameters are not signed.
    let header =
        exoscale::authorization("k", "s", "GET", "/v2/x", &[("a", "1"), ("a", "2")], b"", 1);
    assert!(!header.contains("signed-query-args"), "{header}");
}

#[tokio::test]
async fn digitalocean_lists_pages_mints_and_caches() {
    let calls = Arc::new(AtomicUsize::new(0));
    let counter = calls.clone();
    let server = FakeServer::start(move |req| {
        if bearer(req) != Some("dop_v1_secret") {
            return FakeResponse::json(401, json!({"id": "Unauthorized", "message": "Unable to authenticate you"}));
        }
        match req.path.as_str() {
            "/v2/account" => FakeResponse::json(200, json!({"account": {"email": "sammy@example.com", "team": {"name": "Acme"}}})),
            "/v2/kubernetes/clusters" if req.query_param("page") == Some("2") => FakeResponse::json(200, json!({
                "kubernetes_clusters": [{"id": "c2", "name": "dev", "region": "ams3", "version": "1.30.1-do.0", "status": {"state": "provisioning"}}],
                "links": {}
            })),
            "/v2/kubernetes/clusters" => FakeResponse::json(200, json!({
                "kubernetes_clusters": [{"id": "c1", "name": "prod", "region": "nyc1", "version": "1.31.1-do.3",
                    "endpoint": "https://c1.k8s.ondigitalocean.com", "status": {"state": "running"}, "created_at": "2026-01-02T03:04:05Z"}],
                "links": {"pages": {"next": "https://api.digitalocean.com/v2/kubernetes/clusters?page=2&per_page=200", "last": "x"}}
            })),
            "/v2/kubernetes/clusters/c1/credentials" => {
                counter.fetch_add(1, Ordering::SeqCst);
                assert_eq!(req.query_param("expiry_seconds"), Some("3600"));
                FakeResponse::json(200, json!({
                    "server": "https://c1.k8s.ondigitalocean.com",
                    "certificate_authority_data": "Q0E=",
                    "client_certificate_data": null,
                    "client_key_data": null,
                    "token": "minted-do-token",
                    "expires_at": "2099-01-01T00:00:00.123Z"
                }))
            }
            _ => FakeResponse::json(404, json!({"id": "not_found", "message": "The resource you requested could not be found."})),
        }
    })
    .await;
    let dir = tempfile::tempdir().unwrap();
    let ctx = context(dir.path(), &server.url);

    let account = digitalocean::account(&ctx, "dop_v1_secret").await.unwrap();
    assert_eq!(account.team.as_deref(), Some("Acme"));
    let err = digitalocean::account(&ctx, "wrong").await.unwrap_err();
    assert!(
        matches!(err, CloudError::Unauthorized(ref m) if m.contains("Unable to authenticate you")),
        "{err:?}"
    );

    let clusters = digitalocean::clusters(&ctx, "dop_v1_secret").await.unwrap();
    assert_eq!(clusters.len(), 2);
    assert_eq!(clusters[0].name, "prod");
    assert_eq!(clusters[0].status.as_deref(), Some("running"));
    assert_eq!(clusters[0].created_at, Some(1_767_323_045_000));
    assert_eq!(clusters[1].region, "ams3");

    // Minting: the token from the vault, cached until it expires.
    add_connection(
        &ctx,
        connection("do1", "digitalocean", ConnectionKind::Token),
    );
    ctx.store
        .put_and_remove(
            vec![(
                api_token_secret_id("do1"),
                json!({"token": "dop_v1_secret"}),
            )],
            &[],
        )
        .unwrap();
    let args = DigitaloceanArgs {
        connection: "do1".into(),
        cluster: "c1".into(),
    };
    let first = mint::digitalocean(&ctx, &args).await.unwrap();
    assert_eq!(first.token.as_deref(), Some("minted-do-token"));
    assert_eq!(first.expires_at, 4_070_908_800);
    let again = mint::digitalocean(&ctx, &args).await.unwrap();
    assert_eq!(again, first);
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    let exec = first
        .to_exec_credential("client.authentication.k8s.io/v1")
        .to_json();
    assert!(
        exec.contains(r#""expirationTimestamp":"2099-01-01T00:00:00Z""#),
        "{exec}"
    );

    // An unknown connection / the wrong kind.
    let err = mint::digitalocean(
        &ctx,
        &DigitaloceanArgs {
            connection: "nope".into(),
            cluster: "c1".into(),
        },
    )
    .await
    .unwrap_err();
    assert!(matches!(err, CloudError::NotFound(_)));
    add_connection(
        &ctx,
        connection("do2", "digitalocean", ConnectionKind::Token),
    );
    let err = mint::digitalocean(
        &ctx,
        &DigitaloceanArgs {
            connection: "do2".into(),
            cluster: "c1".into(),
        },
    )
    .await
    .unwrap_err();
    assert!(matches!(err, CloudError::MissingCredentials(_)), "{err:?}");
}

#[tokio::test]
async fn retries_rate_limits_and_server_errors() {
    let calls = Arc::new(AtomicUsize::new(0));
    let counter = calls.clone();
    let server = FakeServer::start(move |_| match counter.fetch_add(1, Ordering::SeqCst) {
        0 => FakeResponse {
            status: 429,
            headers: vec![("retry-after".into(), "0".into())],
            body: "{}".into(),
        },
        1 => FakeResponse::json(503, json!({"message": "busy"})),
        _ => FakeResponse::json(200, json!({"account": {"name": "Example Account"}})),
    })
    .await;
    let dir = tempfile::tempdir().unwrap();
    let ctx = context(dir.path(), &server.url);
    assert_eq!(
        vultr::account(&ctx, "key").await.unwrap().as_deref(),
        Some("Example Account")
    );
    assert_eq!(calls.load(Ordering::SeqCst), 3);

    // Out of attempts: the last answer's error.
    let server = FakeServer::start(|_| FakeResponse::json(500, json!({"error": "internal"}))).await;
    let ctx = context(dir.path(), &server.url);
    let err = vultr::account(&ctx, "key").await.unwrap_err();
    assert!(
        matches!(err, CloudError::Service { status: 500, ref message } if message == "Vultr: internal"),
        "{err:?}"
    );
    assert_eq!(server.requests().len(), 3);

    // Nothing listening.
    let ctx = context(dir.path(), "http://127.0.0.1:9");
    let err = vultr::account(&ctx, "key").await.unwrap_err();
    assert!(matches!(err, CloudError::Network(_)), "{err:?}");

    // Requests never leave the allowlist.
    let ctx = context(dir.path(), "http://127.0.0.1:9");
    let err = http::send(&ctx, Provider::Vultr, &|| {
        Ok(ApiRequest::get("https://example.com/x".into()))
    })
    .await
    .unwrap_err();
    assert!(
        matches!(err, CloudError::Invalid(ref m) if m.starts_with("Refusing")),
        "{err:?}"
    );
}

#[tokio::test]
async fn linode_civo_scaleway_and_vultr_list_and_fetch_kubeconfigs() {
    let kubeconfig = "apiVersion: v1\nkind: Config\n";
    let server = FakeServer::start(move |req| {
        let path = req.path.as_str();
        // Linode
        if path.starts_with("/v4/") {
            assert_eq!(bearer(req), Some("linode-token"));
            return match path {
                "/v4/profile" => FakeResponse::json(200, json!({"username": "lin-user"})),
                "/v4/lke/clusters" if req.query_param("page") == Some("1") => FakeResponse::json(200, json!({
                    "data": [{"id": 101, "label": "web", "region": "us-east", "k8s_version": "1.31", "status": "ready", "created": "2026-01-02T03:04:05"}],
                    "page": 1, "pages": 2, "results": 2})),
                "/v4/lke/clusters" => FakeResponse::json(200, json!({
                    "data": [{"id": 102, "label": "api", "region": "eu-west", "k8s_version": "1.30", "status": "not_ready"}],
                    "page": 2, "pages": 2, "results": 2})),
                "/v4/lke/clusters/101/kubeconfig" => FakeResponse::json(200, json!({"kubeconfig": b64(kubeconfig)})),
                "/v4/lke/clusters/102/kubeconfig" => FakeResponse::json(503, json!({"errors": [{"reason": "Cluster kubeconfig is not yet available."}]})),
                _ => FakeResponse::json(404, json!({"errors": [{"reason": "Not found"}]})),
            };
        }
        // Civo
        if path.starts_with("/v2/regions") || path.starts_with("/v2/kubernetes/clusters") && req.query_param("region").is_some() {
            if bearer(req) != Some("civo-key") {
                return FakeResponse::json(404, json!({"code": "database_account_not_found", "reason": "Failed to find the account within the internal database"}));
            }
            return match path {
                "/v2/regions" => FakeResponse::json(200, json!([
                    {"code": "LON1", "features": {"kubernetes": true}},
                    {"code": "NYC1", "features": {"kubernetes": true}},
                    {"code": "OLD1", "features": {"kubernetes": false}}])),
                "/v2/kubernetes/clusters" if req.query_param("region") == Some("LON1") && req.query_param("page") == Some("1") => FakeResponse::json(200, json!({
                    "page": 1, "per_page": 100, "pages": 2,
                    "items": [{"id": "cv1", "name": "lon-a", "status": "ACTIVE", "kubernetes_version": "1.30.5-k3s1", "api_endpoint": "https://74.220.0.1:6443", "created_at": "2026-02-01T00:00:00Z", "kubeconfig": "secret"}]})),
                "/v2/kubernetes/clusters" if req.query_param("region") == Some("LON1") => FakeResponse::json(200, json!({
                    "page": 2, "per_page": 100, "pages": 2,
                    "items": [{"id": "cv2", "name": "lon-b", "status": "BUILDING", "kubeconfig": null}]})),
                "/v2/kubernetes/clusters" => FakeResponse::json(200, json!({"page": 1, "pages": 1, "items": []})),
                "/v2/kubernetes/clusters/cv1" => FakeResponse::json(200, json!({"id": "cv1", "kubeconfig": kubeconfig})),
                "/v2/kubernetes/clusters/cv2" => FakeResponse::json(200, json!({"id": "cv2", "kubeconfig": null})),
                _ => FakeResponse::json(404, json!({"reason": "not found"})),
            };
        }
        // Scaleway
        if path.starts_with("/k8s/") || path.starts_with("/account/") {
            if req.header("x-auth-token") != Some("scw-secret") {
                return FakeResponse::json(401, json!({"message": "authentication is denied", "type": "denied_authentication"}));
            }
            return match path {
                "/k8s/v1/regions/fr-par/clusters" => {
                    assert_eq!(req.query_param("project_id"), Some("11111111-1111-4111-8111-111111111111"));
                    FakeResponse::json(200, json!({"total_count": 1, "clusters": [
                        {"id": "s1", "name": "kapsule", "region": "fr-par", "status": "ready", "version": "1.31.2",
                         "cluster_url": "https://s1.api.k8s.fr-par.scw.cloud:6443", "project_id": "11111111-1111-4111-8111-111111111111",
                         "created_at": "2026-03-01T00:00:00Z"}]}))
                }
                "/k8s/v1/regions/fr-par/clusters/s1/kubeconfig" => FakeResponse::json(200, json!({
                    "name": "kubeconfig", "content_type": "application/octet-stream", "content": b64(kubeconfig)})),
                "/account/v3/projects/11111111-1111-4111-8111-111111111111" => FakeResponse::json(200, json!({"name": "default"})),
                _ => FakeResponse::json(404, json!({"message": "resource is not found"})),
            };
        }
        // Vultr
        assert_eq!(bearer(req), Some("vultr-key"));
        match path {
            "/v2/kubernetes/clusters" if req.query_param("cursor").is_none() => FakeResponse::json(200, json!({
                "vke_clusters": [{"id": "v1", "label": "vke-a", "region": "ewr", "version": "v1.31.0+1", "status": "active",
                    "endpoint": "v1.vultr-k8s.com", "date_created": "2026-01-01T00:00:00+00:00"}],
                "meta": {"total": 2, "links": {"next": "bmV4dA==", "prev": ""}}})),
            "/v2/kubernetes/clusters" => {
                assert_eq!(req.query_param("cursor"), Some("bmV4dA%3D%3D"));
                FakeResponse::json(200, json!({
                    "vke_clusters": [{"id": "v2", "label": "vke-b", "region": "ams", "status": "pending"}],
                    "meta": {"total": 2, "links": {"next": "", "prev": "x"}}}))
            }
            "/v2/kubernetes/clusters/v1/config" => FakeResponse::json(200, json!({"kube_config": b64(kubeconfig)})),
            _ => FakeResponse::json(404, json!({"error": "not found"})),
        }
    })
    .await;
    let dir = tempfile::tempdir().unwrap();
    let ctx = context(dir.path(), &server.url);

    assert_eq!(
        linode::profile(&ctx, "linode-token")
            .await
            .unwrap()
            .as_deref(),
        Some("lin-user")
    );
    let lke = linode::clusters(&ctx, "linode-token").await.unwrap();
    assert_eq!(
        lke.iter().map(|c| c.id.as_str()).collect::<Vec<_>>(),
        ["101", "102"]
    );
    assert_eq!(lke[0].created_at, Some(1_767_323_045_000));
    assert_eq!(
        linode::kubeconfig(&ctx, "linode-token", "101")
            .await
            .unwrap(),
        kubeconfig
    );
    let err = linode::kubeconfig(&ctx, "linode-token", "102")
        .await
        .unwrap_err();
    assert!(matches!(err, CloudError::NotReady(_)), "{err:?}");
    assert!(linode::kubeconfig(&ctx, "linode-token", "../x")
        .await
        .is_err());

    assert_eq!(
        civo::regions(&ctx, "civo-key").await.unwrap(),
        ["LON1", "NYC1"]
    );
    let err = civo::regions(&ctx, "wrong").await.unwrap_err();
    assert!(matches!(err, CloudError::Unauthorized(_)), "{err:?}");
    let lon = civo::clusters(&ctx, "civo-key", "LON1").await.unwrap();
    assert_eq!(lon.len(), 2);
    assert_eq!(lon[0].region, "LON1");
    assert_eq!(lon[0].endpoint.as_deref(), Some("https://74.220.0.1:6443"));
    assert_eq!(
        civo::kubeconfig(&ctx, "civo-key", "LON1", "cv1")
            .await
            .unwrap(),
        kubeconfig
    );
    let err = civo::kubeconfig(&ctx, "civo-key", "LON1", "cv2")
        .await
        .unwrap_err();
    assert!(matches!(err, CloudError::NotReady(_)));

    let project = "11111111-1111-4111-8111-111111111111";
    let scw = scaleway::clusters(&ctx, "scw-secret", "fr-par", Some(project))
        .await
        .unwrap();
    assert_eq!(
        scw[0].endpoint.as_deref(),
        Some("https://s1.api.k8s.fr-par.scw.cloud:6443")
    );
    assert_eq!(scw[0].project_id.as_deref(), Some(project));
    assert_eq!(
        scaleway::kubeconfig(&ctx, "scw-secret", "fr-par", "s1")
            .await
            .unwrap(),
        kubeconfig
    );
    assert_eq!(
        scaleway::project_name(&ctx, "scw-secret", project)
            .await
            .unwrap()
            .as_deref(),
        Some("default")
    );
    let err = scaleway::clusters(&ctx, "wrong", "fr-par", Some(project))
        .await
        .unwrap_err();
    assert!(matches!(err, CloudError::Unauthorized(_)));
    assert!(scaleway::clusters(&ctx, "scw-secret", "us-east-1", None)
        .await
        .is_err());

    let vke = vultr::clusters(&ctx, "vultr-key").await.unwrap();
    assert_eq!(vke.len(), 2);
    assert_eq!(
        vke[0].endpoint.as_deref(),
        Some("https://v1.vultr-k8s.com:6443")
    );
    assert_eq!(vke[0].created_at, Some(1_767_225_600_000));
    assert_eq!(
        vultr::kubeconfig(&ctx, "vultr-key", "v1").await.unwrap(),
        kubeconfig
    );

    // The API keys never show up in an error message.
    for request in server.requests() {
        assert!(!format!("{request:?}").is_empty());
    }
}

#[tokio::test]
async fn exoscale_signs_lists_and_mints_client_certificates() {
    let secret = "exo-secret-value";
    let server = FakeServer::start(move |req| {
        // Verify the signature like Exoscale does.
        let header = req.header("authorization").unwrap_or_default().to_string();
        let expires: i64 = header
            .split(",expires=")
            .nth(1)
            .and_then(|r| r.split(',').next())
            .and_then(|e| e.parse().ok())
            .unwrap_or_default();
        let expected = exoscale::authorization("EXOkey", secret, &req.method, &req.path, &[], req.body.as_bytes(), expires);
        if header != expected || expires < crate::now_secs() {
            return FakeResponse::json(403, json!({"message": "Invalid key or request signature"}));
        }
        match (req.method.as_str(), req.path.as_str()) {
            ("GET", "/v2/sks-cluster") => FakeResponse::json(200, json!({"sks-clusters": [
                {"id": "x1", "name": "sks-prod", "version": "1.31.1", "state": "running",
                 "endpoint": "https://x1.sks-ch-gva-2.exo.io:443", "created-at": "2026-04-01T00:00:00Z"}]})),
            ("GET", "/v2/sks-cluster/x1/authority/control-plane/cert") => FakeResponse::json(200, json!({"cacert": CERT_B64})),
            ("GET", "/v2/organization") => FakeResponse::json(200, json!({"name": "Acme SA"})),
            ("POST", "/v2/sks-cluster-kubeconfig/x1") => {
                let body = req.json();
                assert_eq!(body["ttl"], 86_400);
                let user = body["user"].as_str().unwrap().to_string();
                let groups = body["groups"].clone();
                assert_eq!(req.header("content-type"), Some("application/json"));
                let config = format!(
                    "apiVersion: v1\nclusters:\n- cluster:\n    certificate-authority-data: {CERT_B64}\n    server: https://x1.sks-ch-gva-2.exo.io:443\n  name: sks-prod\nusers:\n- name: {user}\n  user:\n    client-certificate-data: {CERT_B64}\n    client-key-data: {KEY_B64}\n# groups {groups}\n"
                );
                FakeResponse::json(200, json!({"kubeconfig": b64(&config)}))
            }
            _ => FakeResponse::json(404, json!({"message": "not found"})),
        }
    })
    .await;
    let dir = tempfile::tempdir().unwrap();
    let ctx = context(dir.path(), &server.url);
    let key = ApiKey {
        key: "EXOkey".into(),
        secret: secret.into(),
    };
    assert_eq!(
        exoscale::organization(&ctx, &key).await.unwrap().as_deref(),
        Some("Acme SA")
    );
    let clusters = exoscale::clusters(&ctx, &key, "ch-gva-2").await.unwrap();
    assert_eq!(clusters[0].region, "ch-gva-2");
    assert_eq!(clusters[0].status.as_deref(), Some("running"));
    assert_eq!(
        exoscale::certificate_authority(&ctx, &key, "ch-gva-2", "x1")
            .await
            .unwrap(),
        CERT_B64
    );
    let wrong = ApiKey {
        key: "EXOkey".into(),
        secret: "nope".into(),
    };
    let err = exoscale::clusters(&ctx, &wrong, "ch-gva-2")
        .await
        .unwrap_err();
    assert!(
        matches!(err, CloudError::Unauthorized(ref m) if m.contains("Invalid key")),
        "{err:?}"
    );

    // Minting with the connection's user and groups, then the cache.
    let mut conn = connection("exo1", "exoscale", ConnectionKind::ApiKey);
    conn.exoscale = Some(ExoscaleSettings {
        user: "alice".into(),
        groups: vec!["devs".into(), "system:masters".into()],
    });
    add_connection(&ctx, conn);
    ctx.store
        .put_and_remove(
            vec![(
                api_key_secret_id("exo1"),
                json!({"key": "EXOkey", "secret": secret}),
            )],
            &[],
        )
        .unwrap();
    let args = ExoscaleArgs {
        connection: "exo1".into(),
        zone: "ch-gva-2".into(),
        cluster: "x1".into(),
    };
    let minted: MintedCredential = mint::exoscale(&ctx, &args).await.unwrap();
    assert!(minted
        .client_certificate_pem
        .as_deref()
        .unwrap()
        .starts_with("-----BEGIN CERTIFICATE-----"));
    assert!(minted
        .client_key_pem
        .as_deref()
        .unwrap()
        .contains("PRIVATE KEY"));
    assert!((minted.expires_at - crate::now_secs() - 86_400).abs() < 60);
    let posts = || {
        server
            .requests()
            .into_iter()
            .filter(|r| r.method == "POST")
            .collect::<Vec<_>>()
    };
    assert_eq!(posts().len(), 1);
    assert_eq!(posts()[0].json()["user"], "alice");
    assert_eq!(
        posts()[0].json()["groups"],
        json!(["devs", "system:masters"])
    );
    let again = mint::exoscale(&ctx, &args).await.unwrap();
    assert_eq!(again, minted);
    assert_eq!(posts().len(), 1);
    let ids = ctx.store.ids_with_prefix("cache:exoscale:exo1:").unwrap();
    assert_eq!(ids, ["cache:exoscale:exo1:x1"]);
}

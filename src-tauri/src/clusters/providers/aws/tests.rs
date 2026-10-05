//! Connections, catalog refresh/add, in-app minting and credential status
//! against a fake AWS (STS, SSO portal, EC2 DescribeRegions, EKS).

use std::sync::{Arc, Mutex};
use std::time::Duration;

use jp_auth_core::aws::cli_cache::SsoToken;
use jp_auth_core::aws::fake::{test_context, FakeRequest, FakeResponse, FakeServer};
use jp_auth_core::aws::session;
use jp_auth_core::connections::{ConnectionKind, ConnectionStatus, SsoTarget};
use serde_json::json;

use crate::auth::status::{statuses, CredentialState, StatusEnv};
use crate::clusters::catalog::{self, CatalogEvent, CatalogState, ProgressState};
use crate::clusters::connections::{self, ConnectionPatch, ConnectionSpec};
use crate::clusters::managed_kubeconfig as managed;
use crate::probe::ContextRef;
use crate::util::lock;

use crate::clusters::providers::TEST_LOCK;

const IDENTITY_XML: &str = r#"<GetCallerIdentityResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/">
  <GetCallerIdentityResult>
    <Arn>arn:aws:iam::123456789012:user/ci</Arn>
    <UserId>AIDAEXAMPLE</UserId>
    <Account>123456789012</Account>
  </GetCallerIdentityResult>
  <ResponseMetadata><RequestId>1</RequestId></ResponseMetadata>
</GetCallerIdentityResponse>"#;

fn signed_region(req: &FakeRequest) -> String {
    let auth = req.header("authorization").unwrap_or_default();
    auth.split("Credential=")
        .nth(1)
        .and_then(|c| c.split('/').nth(2))
        .unwrap_or_default()
        .to_string()
}

fn describe(name: &str, account: &str, region: &str) -> serde_json::Value {
    json!({"cluster": {
        "name": name,
        "arn": format!("arn:aws:eks:{region}:{account}:cluster/{name}"),
        "createdAt": 1_700_000_000.5,
        "version": "1.31",
        "endpoint": format!("https://{name}.gr7.{region}.eks.amazonaws.com"),
        "certificateAuthority": {"data": "Q0VSVA=="},
        "status": "ACTIVE",
    }})
}

fn fake_aws(req: &FakeRequest) -> FakeResponse {
    let region = signed_region(req);
    // Role credentials carry their account in the key id.
    let account = if req
        .header("authorization")
        .is_some_and(|a| a.contains("ASIAROLE"))
    {
        "111111111111"
    } else {
        "123456789012"
    };
    match (req.method.as_str(), req.path.as_str()) {
        ("POST", "/") if req.body.contains("Action=GetCallerIdentity") => FakeResponse::xml(200, IDENTITY_XML),
        ("GET", "/") if req.query.contains("Action=DescribeRegions") => FakeResponse::xml(
            200,
            "<DescribeRegionsResponse><regionInfo><item><regionName>eu-west-1</regionName></item><item><regionName>us-east-1</regionName></item></regionInfo></DescribeRegionsResponse>",
        ),
        ("GET", "/federation/credentials") => FakeResponse::json(
            200,
            json!({"roleCredentials": {
                "accessKeyId": "ASIAROLE",
                "secretAccessKey": "role-secret",
                "sessionToken": "role-session",
                "expiration": (jp_auth_core::aws::now() + 3600) * 1000,
            }}),
        ),
        ("GET", "/clusters") if region == "eu-west-1" => FakeResponse::json(200, json!({"clusters": ["prod", "dev"]})),
        ("GET", "/clusters") => FakeResponse::json(200, json!({"clusters": []})),
        ("GET", path) if path.starts_with("/clusters/") => {
            FakeResponse::json(200, describe(path.trim_start_matches("/clusters/"), account, &region))
        }
        _ => FakeResponse::error(404, "NotFound", "unknown path"),
    }
}

type EventSink = Arc<dyn Fn(CatalogEvent) + Send + Sync>;

fn collect() -> (EventSink, Arc<Mutex<Vec<CatalogEvent>>>) {
    let events = Arc::new(Mutex::new(Vec::new()));
    let log = events.clone();
    (
        Arc::new(move |event| log.lock().unwrap().push(event)),
        events,
    )
}

#[tokio::test]
#[allow(clippy::await_holding_lock)]
async fn connections_catalog_minting_and_status() {
    let _guard = lock(&TEST_LOCK);
    let server = FakeServer::start(fake_aws).await;
    let dir = tempfile::tempdir().unwrap();
    let ctx = test_context(dir.path(), &server.url);
    super::use_test_context(Some(ctx.clone()));
    let managed_path = dir.path().join("managed").join("config");
    catalog::use_test_paths(Some((
        dir.path().join("catalog.json"),
        managed_path.clone(),
    )));

    // Access keys: validated with GetCallerIdentity, kept in the vault.
    let keys = connections::connection_create(ConnectionSpec::Keys {
        label: None,
        access_key_id: "AKIAIOSFODNN7EXAMPLE".into(),
        secret_access_key: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY".into(),
        session_token: None,
        region: "eu-west-1".into(),
    })
    .await
    .unwrap();
    assert_eq!(keys.kind, ConnectionKind::Keys);
    assert_eq!(keys.label, "123456789012");
    assert_eq!(
        keys.identity.as_deref(),
        Some("arn:aws:iam::123456789012:user/ci")
    );
    assert_eq!(keys.status, ConnectionStatus::SignedIn);
    let file = std::fs::read_to_string(&ctx.connections_file).unwrap();
    assert!(
        !file.contains("wJalrXUtnFEMI"),
        "no secrets in connections.json"
    );

    // IAM Identity Center: not signed in yet.
    let sso = connections::connection_create(ConnectionSpec::Sso {
        label: Some("Acme".into()),
        start_url: "https://acme.awsapps.com/start".into(),
        region: "eu-west-1".into(),
    })
    .await
    .unwrap();
    assert_eq!(sso.status, ConnectionStatus::SignedOut);
    let err = connections::connection_create(ConnectionSpec::Sso {
        label: None,
        start_url: "https://acme.awsapps.com/start/".into(),
        region: "eu-west-1".into(),
    })
    .await
    .unwrap_err();
    assert_eq!(err.field.as_deref(), Some("startUrl"));
    let err = connections::connection_create(ConnectionSpec::Profile {
        label: None,
        profile: "nope".into(),
    })
    .await
    .unwrap_err();
    assert_eq!(err.field.as_deref(), Some("profile"));
    let sso = connections::connection_update(
        sso.id.clone(),
        ConnectionPatch {
            label: None,
            regions: Some(vec!["eu-west-1".into(), "eu-west-1".into()]),
            targets: Some(vec![SsoTarget {
                account_id: "111111111111".into(),
                account_name: Some("acme-prod".into()),
                role_name: "ReadOnly".into(),
            }]),
            exoscale: None,
        },
    )
    .await
    .unwrap();
    assert_eq!(sso.regions, vec!["eu-west-1"]);
    assert_eq!(
        super::sign_in_target(&sso.id).unwrap().start_url,
        "https://acme.awsapps.com/start"
    );

    // Refresh everything: the keys connection lists its enabled regions;
    // the SSO one is skipped (no sign-in) without prompting.
    let (sink, events) = collect();
    catalog::refresh(None, sink).await.unwrap();
    let events = events.lock().unwrap().clone();
    assert!(matches!(events.last(), Some(CatalogEvent::Done { .. })));
    assert!(events.iter().any(|e| matches!(e,
        CatalogEvent::Progress { connection_id, scope, state: ProgressState::Done, account_id: Some(account), region: Some(region), .. }
            if *connection_id == keys.id && scope == "123456789012 · eu-west-1" && account == "123456789012" && region == "eu-west-1")));
    assert!(events.iter().any(|e| matches!(e,
        CatalogEvent::Progress { connection_id, state: ProgressState::Error, message: Some(message), .. }
            if *connection_id == sso.id && message == "Sign in to Acme to discover its clusters")));
    let keys_clusters = events
        .iter()
        .find_map(|e| match e {
            CatalogEvent::Clusters {
                connection_id,
                clusters,
            } if *connection_id == keys.id => Some(clusters.clone()),
            _ => None,
        })
        .unwrap();
    let mut names: Vec<&str> = keys_clusters.iter().map(|c| c.name.as_str()).collect();
    names.sort();
    assert_eq!(names, ["dev", "prod"]);
    assert_eq!(keys_clusters[0].created_at, Some(1_700_000_000_500));
    assert_eq!(keys_clusters[0].status.as_deref(), Some("ACTIVE"));

    // Sign in (as a device flow would have stored it), refresh just SSO.
    session::save_token(
        &ctx,
        Some(&sso.id),
        &SsoToken {
            start_url: "https://acme.awsapps.com/start".into(),
            region: "eu-west-1".into(),
            access_token: "access".into(),
            expires_at: jp_auth_core::aws::now() + 4 * 3600,
            client_id: None,
            client_secret: None,
            registration_expires_at: None,
            refresh_token: None,
        },
    )
    .unwrap();
    let (sink, events) = collect();
    catalog::refresh(Some(vec![sso.id.clone()]), sink)
        .await
        .unwrap();
    let events = events.lock().unwrap().clone();
    assert!(events.iter().any(|e| matches!(e,
        CatalogEvent::Progress { scope, account_name: Some(name), .. } if scope == "acme-prod (111111111111) · eu-west-1" && name == "acme-prod")));
    let listed = connections::connections_list().await.unwrap();
    let sso_listed = listed.iter().find(|c| c.id == sso.id).unwrap();
    assert_eq!(sso_listed.status, ConnectionStatus::SignedIn);
    assert!(sso_listed.expires_at.is_some());

    // The catalog: ignore one, add another.
    let snapshot = catalog::catalog_get().await.unwrap();
    assert_eq!(snapshot.clusters.len(), 4);
    assert!(snapshot.refreshed_at.is_some());
    let key = |connection: &str, account: &str, name: &str| {
        catalog::catalog_key("aws", connection, account, "eu-west-1", name)
    };
    catalog::catalog_set_state(
        vec![key(&keys.id, "123456789012", "dev")],
        CatalogState::Ignored,
    )
    .await
    .unwrap();
    let added = catalog::catalog_add(
        vec![
            key(&keys.id, "123456789012", "prod"),
            key(&sso.id, "111111111111", "prod"),
        ],
        None,
    )
    .await
    .unwrap();
    assert!(added.failed.is_empty(), "{:?}", added.failed);
    assert_eq!(added.added.len(), 2);
    assert!(added.added[0].context.starts_with("eks-eu-west-1-prod"));
    assert_ne!(added.added[0].context, added.added[1].context);
    let snapshot = catalog::catalog_get().await.unwrap();
    let state = |k: &str| snapshot.clusters.iter().find(|c| c.key == k).unwrap().state;
    assert_eq!(
        state(&key(&keys.id, "123456789012", "dev")),
        CatalogState::Ignored
    );
    assert_eq!(
        state(&key(&keys.id, "123456789012", "prod")),
        CatalogState::Added
    );

    // In-app minting: no helper process, a presigned STS token.
    let doc = managed::read(&managed_path).unwrap();
    let exec_of = |context: &str| {
        let ctx = doc
            .contexts
            .iter()
            .find(|c| c.name == context)
            .unwrap()
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
    };
    for added in &added.added {
        let credential =
            crate::auth::broker::mint(&exec_of(&added.context), Duration::from_secs(10))
                .await
                .unwrap();
        let token = credential.token.unwrap();
        assert!(token.starts_with("k8s-aws-v1."), "{token}");
        let remaining = credential
            .expires_at
            .unwrap()
            .duration_since(std::time::SystemTime::now())
            .unwrap();
        assert!(
            remaining > Duration::from_secs(13 * 60) && remaining <= Duration::from_secs(14 * 60)
        );
    }

    // Credential status: keys are valid; SSO shows the session and can
    // sign in natively.
    let env = StatusEnv {
        home: Some(dir.path().join("home")),
        aws_config_file: None,
        now: std::time::SystemTime::now(),
    };
    let targets: Vec<ContextRef> = added
        .added
        .iter()
        .map(|r| ContextRef {
            kube_config: managed_path.to_string_lossy().into_owned(),
            context: r.context.clone(),
        })
        .collect();
    let result = statuses(targets, &env);
    let keys_status = &result[0];
    assert_eq!(keys_status.state, CredentialState::Valid);
    assert!(!keys_status.can_sign_in);
    let sso_status = &result[1];
    assert_eq!(sso_status.state, CredentialState::Valid);
    assert!(sso_status.can_sign_in);
    assert_eq!(
        sso_status.sign_in_label.as_deref(),
        Some("Sign in to AWS (Acme)")
    );
    assert!(sso_status.expires_at.is_some());

    // Removing the keys connection with its clusters.
    connections::connection_delete(keys.id.clone(), true)
        .await
        .unwrap();
    let doc = managed::read(&managed_path).unwrap();
    assert_eq!(doc.contexts.len(), 1);
    assert!(ctx
        .store
        .ids_with_prefix(&format!("conn:{}:", keys.id))
        .unwrap()
        .is_empty());
    assert!(catalog::catalog_get()
        .await
        .unwrap()
        .clusters
        .iter()
        .all(|c| c.connection_id != keys.id));
    assert_eq!(connections::connections_list().await.unwrap().len(), 1);

    super::use_test_context(None);
    catalog::use_test_paths(None);
}

#[tokio::test]
#[allow(clippy::await_holding_lock)]
async fn expired_sessions_are_not_signed_in_in_the_background() {
    let _guard = lock(&TEST_LOCK);
    let server =
        FakeServer::start(|_| FakeResponse::error(500, "Unexpected", "no calls expected")).await;
    let dir = tempfile::tempdir().unwrap();
    let ctx = test_context(dir.path(), &server.url);
    super::use_test_context(Some(ctx.clone()));
    catalog::use_test_paths(Some((
        dir.path().join("catalog.json"),
        dir.path().join("config"),
    )));

    let sso = connections::connection_create(ConnectionSpec::Sso {
        label: None,
        start_url: "https://corp.awsapps.com/start".into(),
        region: "us-east-1".into(),
    })
    .await
    .unwrap();
    assert_eq!(sso.label, "corp");
    session::save_token(
        &ctx,
        Some(&sso.id),
        &SsoToken {
            start_url: "https://corp.awsapps.com/start".into(),
            region: "us-east-1".into(),
            access_token: "old".into(),
            expires_at: jp_auth_core::aws::now() - 60,
            client_id: None,
            client_secret: None,
            registration_expires_at: None,
            refresh_token: None,
        },
    )
    .unwrap();
    let listed = connections::connections_list().await.unwrap();
    assert_eq!(listed[0].status, ConnectionStatus::Expired);

    let args = jp_auth_core::request::AwsEksArgs {
        connection: sso.id.clone(),
        account: Some("111111111111".into()),
        role: Some("ReadOnly".into()),
        profile: None,
        region: "us-east-1".into(),
        cluster: "prod".into(),
    };
    let err = super::mint_eks(&args).await.unwrap_err();
    assert!(
        matches!(err, jp_auth_core::aws::AwsError::SignInRequired(_)),
        "{err:?}"
    );
    let entry = super::compute_entry_status(&ctx, &args);
    assert!(entry.can_sign_in);
    assert!(matches!(entry.session, super::EntrySession::Expired(_)));
    let err = super::aws_sso_accounts(sso.id.clone()).await.unwrap_err();
    assert_eq!(
        err.code,
        crate::clusters::error::AppErrorCode::SignInRequired
    );
    assert!(server.requests().is_empty());

    super::use_test_context(None);
    catalog::use_test_paths(None);
}

#[tokio::test]
#[allow(clippy::await_holding_lock)]
async fn helper_contexts_sign_in_with_the_native_device_flow() {
    use crate::auth::login::{sign_in_plan, LoginEvent, LoginSink, SignInPlan};
    let _guard = lock(&TEST_LOCK);
    let server = FakeServer::start(|req| match req.path.as_str() {
        "/client/register" => FakeResponse::json(
            200,
            json!({"clientId": "c", "clientSecret": "s", "clientSecretExpiresAt": jp_auth_core::aws::now() + 86_400 * 90}),
        ),
        "/device_authorization" => FakeResponse::json(
            200,
            json!({"deviceCode": "d", "userCode": "ABCD-EFGH", "verificationUri": "https://device.sso.eu-west-1.amazonaws.com/",
                   "verificationUriComplete": "https://device.sso.eu-west-1.amazonaws.com/?user_code=ABCD-EFGH", "expiresIn": 600, "interval": 1}),
        ),
        "/token" => FakeResponse::json(200, json!({"accessToken": "a", "expiresIn": 3600, "refreshToken": "r"})),
        _ => FakeResponse::error(404, "NotFound", "unknown"),
    })
    .await;
    let dir = tempfile::tempdir().unwrap();
    let ctx = test_context(dir.path(), &server.url);
    super::use_test_context(Some(ctx.clone()));
    catalog::use_test_paths(Some((
        dir.path().join("catalog.json"),
        dir.path().join("config"),
    )));

    let sso = connections::connection_create(ConnectionSpec::Sso {
        label: Some("Acme".into()),
        start_url: "https://acme.awsapps.com/start".into(),
        region: "eu-west-1".into(),
    })
    .await
    .unwrap();
    let args = jp_auth_core::request::AwsEksArgs {
        connection: sso.id.clone(),
        account: Some("111111111111".into()),
        role: Some("ReadOnly".into()),
        profile: None,
        region: "eu-west-1".into(),
        cluster: "prod".into(),
    };
    let exec = managed::aws_eks_exec(
        &args,
        std::path::Path::new("/home/me/.kube/jet-pilot/bin/jetpilot-auth"),
    );
    let plan = sign_in_plan(&exec, None);
    assert_eq!(
        plan,
        SignInPlan::AwsNative {
            connection_id: sso.id.clone(),
            label: "Acme".into(),
            start_url: "https://acme.awsapps.com/start".into(),
            region: "eu-west-1".into(),
        }
    );
    assert_eq!(plan.label(), "Sign in to AWS (Acme)");

    let events = Arc::new(Mutex::new(Vec::new()));
    let log = events.clone();
    let sink: LoginSink = Arc::new(move |event| {
        log.lock().unwrap().push(event);
        true
    });
    let allowed = Mutex::new(Vec::new());
    let allow = |url: &str| allowed.lock().unwrap().push(url.to_string());
    let target = super::sign_in_target(&sso.id).unwrap();

    // Cancelled before anything was approved.
    let err = super::run_device_flow(&target, &sink, &allow, async {})
        .await
        .unwrap_err();
    assert_eq!(err, super::FlowError::Cancelled);

    events.lock().unwrap().clear();
    let expires_at = super::run_device_flow(&target, &sink, &allow, std::future::pending())
        .await
        .unwrap()
        .unwrap();
    assert!(expires_at > jp_auth_core::aws::now() * 1000);
    let events = events.lock().unwrap().clone();
    assert_eq!(
        events,
        vec![
            LoginEvent::Started {
                command: "AWS IAM Identity Center sign-in (https://acme.awsapps.com/start)".into()
            },
            LoginEvent::DeviceCode {
                user_code: "ABCD-EFGH".into(),
                verification_uri: "https://device.sso.eu-west-1.amazonaws.com/".into(),
                verification_uri_complete: Some(
                    "https://device.sso.eu-west-1.amazonaws.com/?user_code=ABCD-EFGH".into()
                ),
            },
        ]
    );
    assert!(allowed
        .lock()
        .unwrap()
        .contains(&"https://device.sso.eu-west-1.amazonaws.com/?user_code=ABCD-EFGH".to_string()));
    // Signed in: the aws CLI cache has it, and the connection says so.
    let cache = dir
        .path()
        .join("home")
        .join(".aws")
        .join("sso")
        .join("cache");
    assert_eq!(cache.read_dir().unwrap().count(), 1);
    let listed = connections::connections_list().await.unwrap();
    assert_eq!(listed[0].status, ConnectionStatus::SignedIn);

    super::use_test_context(None);
    catalog::use_test_paths(None);
}

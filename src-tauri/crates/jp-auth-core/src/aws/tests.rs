//! IAM Identity Center flows against the fake server.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::json;

use super::cli_cache::{self, SsoToken};
use super::fake::{test_context, FakeResponse, FakeServer};
use super::session::{self, SessionState};
use super::sso::{self, DeviceFlowError, Sleeper};
use super::{creds, AwsError};
use crate::connections::{self, CloudConnection, ConnectionKind, ConnectionStatus, SsoSettings};

const START_URL: &str = "https://acme.awsapps.com/start";

fn recording_sleeper() -> (Box<Sleeper>, Arc<Mutex<Vec<Duration>>>) {
    let slept = Arc::new(Mutex::new(Vec::new()));
    let log = slept.clone();
    let sleeper: Box<Sleeper> = Box::new(move |d| {
        log.lock().unwrap().push(d);
        Box::pin(async {})
    });
    (sleeper, slept)
}

fn registration_response() -> FakeResponse {
    FakeResponse::json(
        200,
        json!({
            "clientId": "client-1",
            "clientSecret": "client-secret-1",
            "clientIdIssuedAt": 1_700_000_000,
            "clientSecretExpiresAt": super::now() + 90 * 86_400,
        }),
    )
}

fn device_response() -> FakeResponse {
    FakeResponse::json(
        200,
        json!({
            "deviceCode": "device-code-1",
            "userCode": "WDKX-PQLM",
            "verificationUri": "https://device.sso.eu-west-1.amazonaws.com/",
            "verificationUriComplete": "https://device.sso.eu-west-1.amazonaws.com/?user_code=WDKX-PQLM",
            "expiresIn": 600,
            "interval": 5,
        }),
    )
}

fn token_response(access: &str, refresh: &str) -> FakeResponse {
    FakeResponse::json(
        200,
        json!({"accessToken": access, "tokenType": "Bearer", "expiresIn": 28_800, "refreshToken": refresh}),
    )
}

/// Pending, slow down, then a token (or `end` instead of the token).
async fn device_server(end: Option<(&'static str, &'static str)>) -> FakeServer {
    let polls = AtomicUsize::new(0);
    FakeServer::start(move |req| match req.path.as_str() {
        "/client/register" => registration_response(),
        "/device_authorization" => device_response(),
        "/token" => match polls.fetch_add(1, Ordering::SeqCst) {
            0 => FakeResponse::error(
                400,
                "AuthorizationPendingException",
                "authorization_pending",
            ),
            1 => FakeResponse::error(400, "SlowDownException", "slow_down"),
            _ => match end {
                Some((code, message)) => FakeResponse::error(400, code, message),
                None => token_response("access-1", "refresh-1"),
            },
        },
        _ => FakeResponse::error(404, "NotFound", "unknown path"),
    })
    .await
}

#[tokio::test]
async fn device_flow_polls_slows_down_and_stores_the_token() {
    let server = device_server(None).await;
    let dir = tempfile::tempdir().unwrap();
    let ctx = test_context(dir.path(), &server.url);
    let (sleeper, slept) = recording_sleeper();

    let pending = session::begin_sign_in(&ctx, Some("conn1"), "eu-west-1", START_URL)
        .await
        .unwrap();
    assert_eq!(pending.authorization.user_code, "WDKX-PQLM");
    assert_eq!(pending.authorization.interval, 5);
    let token = session::complete_sign_in(&ctx, Some("conn1"), &pending, &*sleeper)
        .await
        .unwrap();
    assert_eq!(token.access_token, "access-1");
    assert_eq!(token.refresh_token.as_deref(), Some("refresh-1"));
    // Pending: wait the interval; slow down: 5 s more.
    assert_eq!(
        *slept.lock().unwrap(),
        vec![Duration::from_secs(5), Duration::from_secs(10)]
    );

    let requests = server.requests();
    let register = requests
        .iter()
        .find(|r| r.path == "/client/register")
        .unwrap()
        .json();
    assert_eq!(register["clientName"], "JET Pilot");
    assert_eq!(register["clientType"], "public");
    assert_eq!(register["scopes"], json!(["sso:account:access"]));
    assert_eq!(
        register["grantTypes"],
        json!([
            "urn:ietf:params:oauth:grant-type:device_code",
            "refresh_token"
        ])
    );
    assert_eq!(register["issuerUrl"], START_URL);
    let start = requests
        .iter()
        .find(|r| r.path == "/device_authorization")
        .unwrap()
        .json();
    assert_eq!(start["startUrl"], START_URL);
    let poll = requests
        .iter()
        .rfind(|r| r.path == "/token")
        .unwrap()
        .json();
    assert_eq!(
        poll["grantType"],
        "urn:ietf:params:oauth:grant-type:device_code"
    );
    assert_eq!(poll["deviceCode"], "device-code-1");

    // The aws CLI cache (no ~/.aws/config: keyed by the start URL) and the
    // vault both have it.
    let cache = ctx.sso_cache_dir().unwrap();
    let cached = cli_cache::read(&cache, &cli_cache::cache_key(START_URL)).unwrap();
    assert_eq!(cached, token);
    let text =
        std::fs::read_to_string(cache.join(format!("{}.json", cli_cache::cache_key(START_URL))))
            .unwrap();
    assert!(text.starts_with(r#"{"startUrl": "https://acme.awsapps.com/start", "region": "eu-west-1", "accessToken": "access-1", "expiresAt": ""#));
    let stored: SsoToken = serde_json::from_value(
        ctx.store
            .get(&connections::sso_token_secret_id("conn1"))
            .unwrap()
            .unwrap(),
    )
    .unwrap();
    assert_eq!(stored, token);
    assert!(ctx
        .store
        .get(&connections::sso_client_secret_id("conn1"))
        .unwrap()
        .is_some());

    // A second sign-in reuses the registration.
    let server_requests = server.requests().len();
    session::begin_sign_in(&ctx, Some("conn1"), "eu-west-1", START_URL)
        .await
        .unwrap();
    let again = server.requests();
    assert!(!again[server_requests..]
        .iter()
        .any(|r| r.path == "/client/register"));
}

#[tokio::test]
async fn device_flow_ends_on_expired_or_denied_codes() {
    for (code, expected) in [
        ("ExpiredTokenException", DeviceFlowError::Expired),
        ("AccessDeniedException", DeviceFlowError::Denied),
    ] {
        let server = device_server(Some((code, "no"))).await;
        let dir = tempfile::tempdir().unwrap();
        let ctx = test_context(dir.path(), &server.url);
        let (sleeper, _) = recording_sleeper();
        let pending = session::begin_sign_in(&ctx, None, "eu-west-1", START_URL)
            .await
            .unwrap();
        let err = session::complete_sign_in(&ctx, None, &pending, &*sleeper)
            .await
            .unwrap_err();
        assert_eq!(err, expected);
        assert!(
            ctx.sso_cache_dir().unwrap().read_dir().is_err(),
            "nothing cached"
        );
    }
}

fn stored_token(expires_in: i64, refreshable: bool) -> SsoToken {
    SsoToken {
        start_url: START_URL.into(),
        region: "eu-west-1".into(),
        access_token: "old-access".into(),
        expires_at: super::now() + expires_in,
        client_id: refreshable.then(|| "client-1".into()),
        client_secret: refreshable.then(|| "client-secret-1".into()),
        registration_expires_at: refreshable.then(|| super::now() + 86_400),
        refresh_token: refreshable.then(|| "refresh-1".into()),
    }
}

#[tokio::test]
async fn near_expiry_tokens_are_refreshed_silently() {
    let server = FakeServer::start(|req| {
        assert_eq!(req.path, "/token");
        assert_eq!(req.json()["grantType"], "refresh_token");
        assert_eq!(req.json()["refreshToken"], "refresh-1");
        token_response("new-access", "refresh-2")
    })
    .await;
    let dir = tempfile::tempdir().unwrap();
    let ctx = test_context(dir.path(), &server.url);
    session::save_token(&ctx, Some("conn1"), &stored_token(120, true)).unwrap();
    assert!(matches!(
        SessionState::of(
            session::current_token(&ctx, Some("conn1"), START_URL).as_ref(),
            super::now()
        ),
        SessionState::Refreshable(_)
    ));

    let token = session::access_token(&ctx, Some("conn1"), START_URL)
        .await
        .unwrap();
    assert_eq!(token.access_token, "new-access");
    assert_eq!(token.refresh_token.as_deref(), Some("refresh-2"));
    assert_eq!(token.client_id.as_deref(), Some("client-1"));
    // Written back for the aws CLI and the next helper run.
    let cached = session::current_token(&ctx, Some("conn1"), START_URL).unwrap();
    assert_eq!(cached.access_token, "new-access");
    assert_eq!(server.requests().len(), 1);
    // Fresh now: no further refresh.
    session::access_token(&ctx, Some("conn1"), START_URL)
        .await
        .unwrap();
    assert_eq!(server.requests().len(), 1);
}

#[tokio::test]
async fn expired_sessions_need_a_sign_in() {
    let server =
        FakeServer::start(|_| FakeResponse::error(400, "InvalidGrantException", "invalid_grant"))
            .await;
    let dir = tempfile::tempdir().unwrap();
    let ctx = test_context(dir.path(), &server.url);

    let err = session::access_token(&ctx, Some("conn1"), START_URL)
        .await
        .unwrap_err();
    assert!(matches!(err, AwsError::SignInRequired(_)));

    // Expired without a refresh token.
    session::save_token(&ctx, Some("conn1"), &stored_token(-10, false)).unwrap();
    let err = session::access_token(&ctx, Some("conn1"), START_URL)
        .await
        .unwrap_err();
    assert!(matches!(err, AwsError::SignInRequired(_)));
    assert!(server.requests().is_empty());

    // The refresh token was revoked.
    session::save_token(&ctx, Some("conn1"), &stored_token(-10, true)).unwrap();
    let err = session::access_token(&ctx, Some("conn1"), START_URL)
        .await
        .unwrap_err();
    assert!(matches!(err, AwsError::SignInRequired(_)), "{err:?}");
    assert_eq!(server.requests().len(), 1);
}

fn sso_connection() -> CloudConnection {
    CloudConnection {
        id: "conn1".into(),
        provider: "aws".into(),
        kind: ConnectionKind::Sso,
        label: "Acme".into(),
        identity: None,
        sso: Some(SsoSettings {
            start_url: START_URL.into(),
            region: "eu-west-1".into(),
        }),
        profile: None,
        region: None,
        regions: vec![],
        targets: vec![],
        status: ConnectionStatus::SignedIn,
        expires_at: None,
        message: None,
        created_at: 0,
    }
}

#[tokio::test]
async fn role_credentials_are_fetched_once_and_cached() {
    let server = FakeServer::start(|req| {
        assert_eq!(req.path, "/federation/credentials");
        assert_eq!(req.query_param("account_id"), Some("123456789012"));
        assert_eq!(req.query_param("role_name"), Some("ReadOnly"));
        assert_eq!(req.header("x-amz-sso_bearer_token"), Some("old-access"));
        FakeResponse::json(
            200,
            json!({"roleCredentials": {
                "accessKeyId": "ASIAROLE",
                "secretAccessKey": "role-secret",
                "sessionToken": "role-session",
                "expiration": (super::now() + 3600) * 1000,
            }}),
        )
    })
    .await;
    let dir = tempfile::tempdir().unwrap();
    let ctx = test_context(dir.path(), &server.url);
    session::save_token(&ctx, Some("conn1"), &stored_token(3600 * 4, false)).unwrap();

    let connection = sso_connection();
    let first = creds::sso_role(&ctx, &connection, "123456789012", "ReadOnly")
        .await
        .unwrap();
    assert_eq!(first.access_key_id, "ASIAROLE");
    assert_eq!(first.session_token.as_deref(), Some("role-session"));
    let second = creds::sso_role(&ctx, &connection, "123456789012", "ReadOnly")
        .await
        .unwrap();
    assert_eq!(second, first);
    assert_eq!(server.requests().len(), 1);
    assert!(ctx
        .store
        .get(&creds::role_cache_id("conn1", "123456789012", "ReadOnly"))
        .unwrap()
        .is_some());
}

#[tokio::test]
async fn unauthorized_portal_calls_mean_signing_in() {
    let server = FakeServer::start(|_| {
        FakeResponse::error(
            401,
            "UnauthorizedException",
            "Session token not found or invalid",
        )
    })
    .await;
    let dir = tempfile::tempdir().unwrap();
    let ctx = test_context(dir.path(), &server.url);
    let err = sso::role_credentials(&ctx, "eu-west-1", "token", "123456789012", "ReadOnly")
        .await
        .unwrap_err();
    assert!(matches!(err, AwsError::SignInRequired(_)), "{err:?}");
}

#[tokio::test]
async fn accounts_and_roles_are_paginated_and_throttling_is_retried() {
    let throttled = AtomicUsize::new(0);
    let server = FakeServer::start(move |req| match req.path.as_str() {
        "/assignment/accounts" => match req.query_param("next_token") {
            None => FakeResponse::json(
                200,
                json!({"accountList": [{"accountId": "111111111111", "accountName": "zeta-prod", "emailAddress": "ops@acme.example"}], "nextToken": "page2"}),
            ),
            Some(_) => FakeResponse::json(200, json!({"accountList": [{"accountId": "222222222222", "accountName": "Alpha-dev"}]})),
        },
        "/assignment/roles" => {
            if req.query_param("account_id") == Some("111111111111") && throttled.fetch_add(1, Ordering::SeqCst) == 0 {
                return FakeResponse::error(429, "TooManyRequestsException", "slow down");
            }
            match (req.query_param("account_id"), req.query_param("next_token")) {
                (Some("111111111111"), None) => FakeResponse::json(
                    200,
                    json!({"roleList": [{"roleName": "ReadOnly", "accountId": "111111111111"}], "nextToken": "r2"}),
                ),
                (Some("111111111111"), Some(_)) => FakeResponse::json(
                    200,
                    json!({"roleList": [{"roleName": "Admin", "accountId": "111111111111"}]}),
                ),
                _ => FakeResponse::json(200, json!({"roleList": [{"roleName": "Developer", "accountId": "222222222222"}]})),
            }
        }
        _ => FakeResponse::error(404, "NotFound", "unknown path"),
    })
    .await;
    let dir = tempfile::tempdir().unwrap();
    let ctx = test_context(dir.path(), &server.url);
    let accounts = sso::accounts(&ctx, "eu-west-1", "token").await.unwrap();
    assert_eq!(
        accounts,
        vec![
            sso::SsoAccount {
                account_id: "222222222222".into(),
                account_name: "Alpha-dev".into(),
                email: None,
                roles: vec!["Developer".into()],
            },
            sso::SsoAccount {
                account_id: "111111111111".into(),
                account_name: "zeta-prod".into(),
                email: Some("ops@acme.example".into()),
                roles: vec!["Admin".into(), "ReadOnly".into()],
            },
        ]
    );
    let json = serde_json::to_value(&accounts[1]).unwrap();
    assert_eq!(json["accountId"], "111111111111");
    assert_eq!(json["email"], "ops@acme.example");
    assert!(server
        .requests()
        .iter()
        .all(|r| r.header("x-amz-sso_bearer_token") == Some("token")));
}

#[tokio::test]
async fn caller_identity_and_static_profiles() {
    let server = FakeServer::start(|req| {
        assert!(req.body.contains("Action=GetCallerIdentity"));
        assert!(req
            .header("authorization")
            .is_some_and(|a| a.starts_with("AWS4-HMAC-SHA256 Credential=AKIASTATIC/")));
        FakeResponse::xml(
            200,
            r#"<GetCallerIdentityResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/">
  <GetCallerIdentityResult>
    <Arn>arn:aws:iam::123456789012:user/jane</Arn>
    <UserId>AIDAEXAMPLE</UserId>
    <Account>123456789012</Account>
  </GetCallerIdentityResult>
  <ResponseMetadata><RequestId>1</RequestId></ResponseMetadata>
</GetCallerIdentityResponse>"#,
        )
    })
    .await;
    let dir = tempfile::tempdir().unwrap();
    let mut ctx = test_context(dir.path(), &server.url);
    let config = dir.path().join("config");
    let credentials = dir.path().join("credentials");
    std::fs::write(&config, "[profile dev]\nregion = eu-west-1\n").unwrap();
    std::fs::write(
        &credentials,
        "[dev]\naws_access_key_id = AKIASTATIC\naws_secret_access_key = static-secret\n",
    )
    .unwrap();
    ctx.config_file = Some(config);
    ctx.credentials_file = Some(credentials);

    let resolved = creds::profile(&ctx, "conn2", "dev").await.unwrap();
    assert_eq!(resolved.access_key_id, "AKIASTATIC");
    assert_eq!(resolved.expires_at, None);
    let (account, arn) = creds::caller_identity(&ctx, &resolved, "eu-west-1")
        .await
        .unwrap();
    assert_eq!(account, "123456789012");
    assert_eq!(arn, "arn:aws:iam::123456789012:user/jane");

    let err = creds::profile(&ctx, "conn2", "missing").await.unwrap_err();
    assert!(matches!(err, AwsError::NotFound(_)));
}

#[tokio::test]
async fn mfa_profiles_need_a_code_first() {
    let dir = tempfile::tempdir().unwrap();
    let mut ctx = test_context(dir.path(), "http://127.0.0.1:9");
    let config = dir.path().join("config");
    std::fs::write(
        &config,
        "[profile base]\naws_access_key_id = AKIA\naws_secret_access_key = s\n[profile admin]\nrole_arn = arn:aws:iam::1:role/a\nsource_profile = base\nmfa_serial = arn:aws:iam::1:mfa/me\n",
    )
    .unwrap();
    ctx.config_file = Some(config);
    let err = creds::profile(&ctx, "conn3", "admin").await.unwrap_err();
    assert!(matches!(err, AwsError::MfaRequired(_)), "{err:?}");
    let err = creds::mfa_sign_in(&ctx, "conn3", "admin", "12ab")
        .await
        .unwrap_err();
    assert!(matches!(err, AwsError::Invalid(_)));
}

/// The real thing over TLS (rustls + ring, system roots): IAM Identity
/// Center rejects a made-up client with a service error (so TLS, endpoint
/// resolution and error parsing work). Needs the network:
/// `cargo test -p jp-auth-core --features aws -- --ignored real_tls`.
#[tokio::test]
#[ignore]
async fn real_tls_reaches_aws() {
    let dir = tempfile::tempdir().unwrap();
    let mut ctx = test_context(dir.path(), "unused");
    ctx.endpoints = super::Endpoints::default();
    let registration = sso::Registration {
        client_id: "not-a-real-client".into(),
        client_secret: "not-a-real-secret".into(),
        expires_at: super::now() + 3600,
        region: "eu-west-1".into(),
        start_url: START_URL.into(),
        scopes: vec![],
    };
    let err = sso::start_device_authorization(&ctx, &registration, START_URL)
        .await
        .unwrap_err();
    assert!(
        matches!(&err, AwsError::Service { code: Some(code), .. }
            if code == "InvalidClientException" || code == "InvalidRequestException"),
        "{err:?}"
    );
}

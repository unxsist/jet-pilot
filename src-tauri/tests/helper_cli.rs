//! End-to-end tests of the `jetpilot-auth` binary against a passphrase vault
//! in a temporary JET Pilot home (no OS keychain, no kernel keyring): stdout
//! is exactly an ExecCredential and stderr never shows a secret.

use std::path::Path;
use std::process::{Command, Output};
use std::sync::Arc;

use jp_auth_core::vault::{KdfParams, NoKeychain, NoUnlockCache, Vault, VaultEnv};
use serde_json::{json, Value};

const PASSPHRASE: &str = "integration passphrase";
const TOKEN: &str = "super-secret-token-value";
const KEY: &str =
    "-----BEGIN EC PRIVATE KEY-----\nS0VZLVNFQ1JFVA==\n-----END EC PRIVATE KEY-----\n";
const CERT: &str = "-----BEGIN CERTIFICATE-----\nQ0VSVA==\n-----END CERTIFICATE-----\n";
const ENV_SECRET: &str = "env-secret-value";

fn setup() -> tempfile::TempDir {
    let home = tempfile::tempdir().unwrap();
    let env = VaultEnv {
        dir: home.path().join("vault"),
        keychain: Arc::new(NoKeychain {
            reason: "tests".into(),
        }),
        unlock_cache: Arc::new(NoUnlockCache),
        kdf: KdfParams::INSECURE_FOR_TESTS,
    };
    let key = Vault::init_passphrase(&env, PASSPHRASE).unwrap();
    let mut vault = Vault::open_with(&env, Some(&key)).unwrap();
    vault
        .put_many(vec![
            ("cluster:tok1:static".into(), json!({ "token": TOKEN })),
            (
                "cluster:cert1:static".into(),
                json!({ "clientCertificatePem": CERT, "clientKeyPem": KEY }),
            ),
            (
                "cluster:wrap1:env".into(),
                json!({ "MY_SECRET": ENV_SECRET }),
            ),
        ])
        .unwrap();
    home
}

fn helper(home: &Path, args: &[&str], passphrase: Option<&str>) -> Output {
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_jetpilot-auth"));
    cmd.args(args)
        .env("JET_PILOT_HOME", home)
        .env("JET_PILOT_NO_KEYCHAIN", "1")
        .env("JET_PILOT_NO_KEYUTILS", "1")
        .env_remove("JET_PILOT_VAULT_PASSPHRASE")
        .env_remove("KUBERNETES_EXEC_INFO");
    if let Some(passphrase) = passphrase {
        cmd.env("JET_PILOT_VAULT_PASSPHRASE", passphrase);
    }
    cmd.output().unwrap()
}

fn stderr(output: &Output) -> String {
    String::from_utf8_lossy(&output.stderr).into_owned()
}

fn assert_no_secrets(text: &str) {
    for secret in [TOKEN, "S0VZLVNFQ1JFVA", ENV_SECRET, PASSPHRASE] {
        assert!(!text.contains(secret), "secret {secret:?} in: {text}");
    }
}

#[test]
fn static_credential_prints_only_an_exec_credential() {
    let home = setup();
    let output = helper(
        home.path(),
        &["credential", "static", "--id", "tok1"],
        Some(PASSPHRASE),
    );
    assert_eq!(output.status.code(), Some(0), "{}", stderr(&output));
    assert!(output.stderr.is_empty(), "{}", stderr(&output));
    let stdout = String::from_utf8(output.stdout).unwrap();
    assert_eq!(stdout.lines().count(), 1);
    let credential: Value = serde_json::from_str(&stdout).unwrap();
    assert_eq!(
        credential,
        json!({
            "apiVersion": "client.authentication.k8s.io/v1",
            "kind": "ExecCredential",
            "status": { "token": TOKEN }
        })
    );

    // The apiVersion of the request is echoed; certificates come as PEM.
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_jetpilot-auth"));
    let output = cmd
        .args(["credential", "static", "--id", "cert1"])
        .env("JET_PILOT_HOME", home.path())
        .env("JET_PILOT_NO_KEYCHAIN", "1")
        .env("JET_PILOT_NO_KEYUTILS", "1")
        .env("JET_PILOT_VAULT_PASSPHRASE", PASSPHRASE)
        .env(
            "KUBERNETES_EXEC_INFO",
            r#"{"apiVersion":"client.authentication.k8s.io/v1beta1","kind":"ExecCredential","spec":{"interactive":false}}"#,
        )
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(0), "{}", stderr(&output));
    let credential: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(
        credential["apiVersion"],
        "client.authentication.k8s.io/v1beta1"
    );
    assert_eq!(credential["status"]["clientCertificateData"], CERT);
    assert_eq!(credential["status"]["clientKeyData"], KEY);
    assert!(credential["status"].get("token").is_none());
}

#[test]
fn failures_use_exit_codes_and_never_leak() {
    let home = setup();

    // Locked: no passphrase and no unlock cache.
    let output = helper(home.path(), &["credential", "static", "--id", "tok1"], None);
    assert_eq!(output.status.code(), Some(4));
    assert!(output.stdout.is_empty());
    assert!(stderr(&output).contains("locked"), "{}", stderr(&output));
    assert_no_secrets(&stderr(&output));

    // Wrong passphrase.
    let output = helper(
        home.path(),
        &["credential", "static", "--id", "tok1"],
        Some("not the passphrase"),
    );
    assert_eq!(output.status.code(), Some(4));
    assert!(output.stdout.is_empty());
    assert_no_secrets(&stderr(&output));

    // Nothing stored for this cluster.
    let output = helper(
        home.path(),
        &["credential", "static", "--id", "unknown1"],
        Some(PASSPHRASE),
    );
    assert_eq!(output.status.code(), Some(3));
    assert!(output.stdout.is_empty());
    assert_no_secrets(&stderr(&output));

    // Usage errors.
    for args in [
        &["credential", "static"][..],
        &["frobnicate"],
        &[],
        &["credential", "static", "--id", "UPPER"],
    ] {
        let output = helper(home.path(), args, Some(PASSPHRASE));
        assert_eq!(output.status.code(), Some(2), "{args:?}");
        assert!(output.stdout.is_empty());
        assert!(stderr(&output).contains("Usage"));
    }

    // A vault that was never set up.
    let empty = tempfile::tempdir().unwrap();
    let output = helper(
        empty.path(),
        &["credential", "static", "--id", "tok1"],
        None,
    );
    assert_eq!(output.status.code(), Some(3), "{}", stderr(&output));
}

#[cfg(unix)]
#[test]
fn wrap_exec_adds_the_secret_env_and_passes_stdout_through() {
    let home = setup();
    let script = r#"printf '{"apiVersion":"client.authentication.k8s.io/v1beta1","kind":"ExecCredential","status":{"token":"%s-%s"}}' "$MY_SECRET" "$PLAIN""#;
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_jetpilot-auth"));
    let output = cmd
        .args([
            "credential",
            "wrap-exec",
            "--id",
            "wrap1",
            "--",
            "/bin/sh",
            "-c",
            script,
        ])
        .env("JET_PILOT_HOME", home.path())
        .env("JET_PILOT_NO_KEYCHAIN", "1")
        .env("JET_PILOT_NO_KEYUTILS", "1")
        .env("JET_PILOT_VAULT_PASSPHRASE", PASSPHRASE)
        .env("PLAIN", "plain")
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(0), "{}", stderr(&output));
    let credential: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(credential["status"]["token"], format!("{ENV_SECRET}-plain"));

    // A missing plugin is reported without leaking the env.
    let output = helper(
        home.path(),
        &[
            "credential",
            "wrap-exec",
            "--id",
            "wrap1",
            "--",
            "/definitely/not/a/plugin",
        ],
        Some(PASSPHRASE),
    );
    assert_eq!(output.status.code(), Some(5));
    assert!(stderr(&output).contains("was not found"));
    assert_no_secrets(&stderr(&output));
}

#[test]
fn doctor_and_version_describe_without_secrets() {
    let home = setup();
    let output = helper(home.path(), &["doctor"], Some(PASSPHRASE));
    assert_eq!(output.status.code(), Some(0));
    let text = String::from_utf8(output.stdout).unwrap();
    assert!(text.contains(&home.path().display().to_string()));
    assert!(text.contains("passphrase"));
    assert!(text.contains("locked"));
    assert!(text.contains("disabled"), "{text}");
    assert_no_secrets(&text);

    let output = helper(home.path(), &["version"], None);
    assert_eq!(output.status.code(), Some(0));
    assert!(String::from_utf8_lossy(&output.stdout).starts_with("jetpilot-auth "));

    let output = helper(home.path(), &["lock"], None);
    assert_eq!(output.status.code(), Some(0));
}

/// kube-rs (like kubectl) runs the helper from a managed-style kubeconfig
/// entry and sends the token it prints.
#[cfg(unix)]
#[tokio::test]
async fn kube_client_uses_the_helper_as_an_exec_plugin() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let home = setup();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        while let Ok((mut socket, _)) = listener.accept().await {
            let mut buf = vec![0u8; 8192];
            let n = socket.read(&mut buf).await.unwrap_or(0);
            let request = String::from_utf8_lossy(&buf[..n]).to_ascii_lowercase();
            let authorized = request.contains(&format!("authorization: bearer {TOKEN}"));
            let (status, body) = if authorized {
                (
                    "200 OK",
                    r#"{"major":"1","minor":"31","gitVersion":"v1.31.0-e2e","gitCommit":"x","gitTreeState":"clean","buildDate":"2026-01-01T00:00:00Z","goVersion":"go1","compiler":"gc","platform":"linux/amd64"}"#,
                )
            } else {
                (
                    "401 Unauthorized",
                    r#"{"kind":"Status","apiVersion":"v1","status":"Failure","reason":"Unauthorized","code":401}"#,
                )
            };
            let response = format!(
                "HTTP/1.1 {status}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                body.len()
            );
            let _ = socket.write_all(response.as_bytes()).await;
        }
    });

    let yaml = format!(
        r#"
apiVersion: v1
kind: Config
current-context: e2e
clusters:
- name: jetpilot-tok1
  cluster: {{server: "http://127.0.0.1:{port}"}}
contexts:
- name: e2e
  context: {{cluster: jetpilot-tok1, user: jetpilot-tok1}}
users:
- name: jetpilot-tok1
  user:
    exec:
      apiVersion: client.authentication.k8s.io/v1
      command: "{helper}"
      args: [credential, static, --id, tok1]
      interactiveMode: Never
      env:
      - {{name: JET_PILOT_HOME, value: "{home}"}}
      - {{name: JET_PILOT_NO_KEYCHAIN, value: "1"}}
      - {{name: JET_PILOT_NO_KEYUTILS, value: "1"}}
      - {{name: JET_PILOT_VAULT_PASSPHRASE, value: "{PASSPHRASE}"}}
"#,
        helper = env!("CARGO_BIN_EXE_jetpilot-auth"),
        home = home.path().display(),
    );
    let kubeconfig = kube::config::Kubeconfig::from_yaml(&yaml).unwrap();
    let config = kube::Config::from_custom_kubeconfig(kubeconfig, &Default::default())
        .await
        .unwrap();
    let client = kube::Client::try_from(config).unwrap();
    let version = client.apiserver_version().await.unwrap();
    assert_eq!(version.git_version, "v1.31.0-e2e");
}

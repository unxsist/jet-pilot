//! Credential status of contexts (`auth_credential_status`), for the
//! clusters hub and the sign-in notices. Never runs a plugin, never returns
//! a secret. Sources:
//!
//! - the broker's cached credential (exec plugins): expiry and mint time;
//! - a static token's JWT `exp` (decoded, not verified);
//! - a client certificate's `notAfter`;
//! - for `aws eks get-token` with an SSO profile: `~/.aws/config` (the
//!   profile's `sso_session` / `sso_start_url`) and the `expiresAt` of the
//!   matching `~/.aws/sso/cache/*.json` (tokens are never read into IPC);
//! - recent auth issues (`needsLogin`).

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use kube::config::{AuthInfo, ExecConfig, Kubeconfig};
use secrecy::ExposeSecret;
use serde::{Deserialize, Serialize};

use super::broker::{self, system_time_ms, CredentialKey};
use super::center;
use super::classify::{classify_auth, InteractiveClass};
use super::login::{self, SignInPlan};
use super::ContextRef;
use crate::kubernetes::client::{read_kubeconfig, resolve_kubeconfig_path};

/// Credentials expiring within this are `expiringSoon`.
const EXPIRING_SOON: Duration = Duration::from_secs(15 * 60);
/// Files bigger than this are not read (SSO cache entries are tiny).
const MAX_FILE: u64 = 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum AuthKind {
    Token,
    ClientCert,
    Exec,
    AuthProvider,
    Basic,
    None,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum CredentialState {
    Valid,
    ExpiringSoon,
    Expired,
    NeedsLogin,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CredentialStatus {
    /// As requested.
    pub kube_config: String,
    pub context: String,
    pub kind: AuthKind,
    /// Basename of the exec plugin.
    pub command: Option<String>,
    /// `AWS_PROFILE` of `aws eks get-token` users.
    pub aws_profile: Option<String>,
    pub interactive: InteractiveClass,
    pub state: CredentialState,
    /// Unix ms.
    pub expires_at: Option<i64>,
    pub can_sign_in: bool,
    pub sign_in_label: Option<String>,
}

/// The credential status of each context (in order).
#[tauri::command]
pub async fn auth_credential_status(contexts: Vec<ContextRef>) -> Result<Vec<CredentialStatus>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let env = StatusEnv {
            home: home_dir(),
            aws_config_file: process_aws_config_file(),
            now: SystemTime::now(),
        };
        statuses(contexts, &env)
    })
    .await
    .map_err(|e| e.to_string())
}

pub(crate) struct StatusEnv {
    pub home: Option<PathBuf>,
    /// `AWS_CONFIG_FILE` of the app's environment.
    pub aws_config_file: Option<PathBuf>,
    pub now: SystemTime,
}

pub(crate) fn process_aws_config_file() -> Option<PathBuf> {
    std::env::var_os("AWS_CONFIG_FILE")
        .filter(|path| !path.is_empty())
        .map(PathBuf::from)
}

pub(crate) fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .filter(|home| !home.is_empty())
        .map(PathBuf::from)
}

pub(crate) fn statuses(contexts: Vec<ContextRef>, env: &StatusEnv) -> Vec<CredentialStatus> {
    let mut configs: HashMap<String, Option<Kubeconfig>> = HashMap::new();
    let mut aws_configs: HashMap<PathBuf, Option<AwsConfig>> = HashMap::new();
    contexts
        .into_iter()
        .map(|target| {
            let path = resolve_kubeconfig_path(Some(&target.kube_config));
            let config = configs
                .entry(path.clone())
                .or_insert_with(|| read_kubeconfig(Some(&path)).ok());
            status_of(&target, &path, config.as_ref(), env, &mut aws_configs)
        })
        .collect()
}

/// A context's user as kube-rs resolves it (a missing user = no
/// credentials) and its cluster's server.
pub(crate) struct ContextAuth {
    pub user: String,
    pub auth: AuthInfo,
    pub server: Option<String>,
}

pub(crate) fn context_auth(config: &Kubeconfig, context: &str) -> Option<ContextAuth> {
    let context = config.contexts.iter().find(|c| c.name == context)?.context.as_ref()?;
    let user = context.user.clone().unwrap_or_default();
    let auth = config
        .auth_infos
        .iter()
        .find(|a| a.name == user)
        .and_then(|a| a.auth_info.clone())
        .unwrap_or_default();
    let server = config
        .clusters
        .iter()
        .find(|c| c.name == context.cluster)
        .and_then(|c| c.cluster.as_ref())
        .and_then(|c| c.server.clone());
    Some(ContextAuth { user, auth, server })
}

/// Which credential kube-rs uses for `auth` (its precedence).
pub fn auth_kind(auth: &AuthInfo) -> AuthKind {
    if auth.auth_provider.is_some() {
        AuthKind::AuthProvider
    } else if auth.username.is_some() && auth.password.is_some() {
        AuthKind::Basic
    } else if auth.token.is_some() || auth.token_file.is_some() {
        AuthKind::Token
    } else if auth.exec.is_some() {
        AuthKind::Exec
    } else if auth.client_certificate.is_some() || auth.client_certificate_data.is_some() {
        AuthKind::ClientCert
    } else {
        AuthKind::None
    }
}

fn state_for(expires_at: SystemTime, now: SystemTime) -> CredentialState {
    if expires_at <= now {
        CredentialState::Expired
    } else if expires_at <= now + EXPIRING_SOON {
        CredentialState::ExpiringSoon
    } else {
        CredentialState::Valid
    }
}

fn status_of(
    target: &ContextRef,
    path: &str,
    config: Option<&Kubeconfig>,
    env: &StatusEnv,
    aws_configs: &mut HashMap<PathBuf, Option<AwsConfig>>,
) -> CredentialStatus {
    let mut status = CredentialStatus {
        kube_config: target.kube_config.clone(),
        context: target.context.clone(),
        kind: AuthKind::None,
        command: None,
        aws_profile: None,
        interactive: InteractiveClass::Unknown,
        state: CredentialState::Unknown,
        expires_at: None,
        can_sign_in: false,
        sign_in_label: None,
    };
    let Some(found) = config.and_then(|config| context_auth(config, &target.context)) else {
        return status;
    };
    let auth = &found.auth;
    status.kind = auth_kind(auth);
    status.interactive = classify_auth(auth);

    let mut expires_at: Option<SystemTime> = None;
    // A broker credential without expiry that is still in use.
    let mut fresh_without_expiry = false;
    let mut minted_at: Option<SystemTime> = None;

    match status.kind {
        AuthKind::Exec => {
            let exec = auth.exec.as_ref().expect("exec kind has an exec config");
            let command = broker::display_command(exec);
            status.command = Some(command.clone()).filter(|c| !c.is_empty());
            if command.eq_ignore_ascii_case("aws") {
                status.aws_profile = login::aws_profile(exec);
            }
            let aws = aws_config_for(exec, env, aws_configs);
            let plan = login::sign_in_plan(exec, aws.as_ref());
            status.can_sign_in = true;
            status.sign_in_label = Some(plan.label());

            let key = CredentialKey::with_server(path, &found.user, exec, found.server.as_deref());
            let meta = broker::cached_meta(&key);
            minted_at = meta.map(|m| m.minted_at);

            if let SignInPlan::AwsSso { sso, .. } = &plan {
                if let Some(cache) = env.home.as_ref().map(|home| home.join(".aws").join("sso").join("cache")) {
                    if let Some(token) = sso_token(&cache, &sso.start_url) {
                        // The aws CLI refreshes a token that has a refresh
                        // token by itself: its expiry says little then.
                        let refreshes = token.refreshable && token.expires_at <= env.now + EXPIRING_SOON;
                        if !refreshes {
                            expires_at = Some(token.expires_at);
                        }
                    }
                }
            }
            if expires_at.is_none() {
                if let Some(meta) = meta {
                    match meta.expires_at {
                        Some(at) => expires_at = Some(at),
                        None => fresh_without_expiry = meta.fresh,
                    }
                }
            }
        }
        AuthKind::Token => {
            let token = match (&auth.token, &auth.token_file) {
                (Some(token), _) => Some(token.expose_secret().to_string()),
                (None, Some(file)) => read_small(Path::new(file)).map(|bytes| String::from_utf8_lossy(&bytes).into_owned()),
                _ => None,
            };
            expires_at = token.as_deref().and_then(jwt_expiry);
        }
        AuthKind::ClientCert => {
            let pem = match (&auth.client_certificate_data, &auth.client_certificate) {
                (Some(data), _) => {
                    use base64::Engine;
                    base64::engine::general_purpose::STANDARD.decode(data.trim()).ok()
                }
                (None, Some(file)) => read_small(Path::new(file)),
                _ => None,
            };
            expires_at = pem.as_deref().and_then(certificate_not_after);
        }
        AuthKind::AuthProvider | AuthKind::Basic | AuthKind::None => {}
    }

    status.expires_at = expires_at.map(system_time_ms);
    let issue = center::recent_issue(path, &target.context).filter(|(kind, at)| {
        // An issue older than the credential minted since is stale.
        kind.needs_login() && minted_at.is_none_or(|minted| *at > system_time_ms(minted))
    });
    status.state = if issue.is_some() {
        CredentialState::NeedsLogin
    } else if let Some(expires_at) = expires_at {
        state_for(expires_at, env.now)
    } else if fresh_without_expiry {
        CredentialState::Valid
    } else {
        CredentialState::Unknown
    };
    status
}

fn read_small(path: &Path) -> Option<Vec<u8>> {
    let metadata = std::fs::metadata(path).ok()?;
    if !metadata.is_file() || metadata.len() > MAX_FILE {
        return None;
    }
    std::fs::read(path).ok()
}

/// The `exp` of a JWT (not verified). None for other tokens.
pub fn jwt_expiry(token: &str) -> Option<SystemTime> {
    use base64::Engine;
    let mut parts = token.trim().split('.');
    let (_header, payload, _signature) = (parts.next()?, parts.next()?, parts.next()?);
    if parts.next().is_some() {
        return None;
    }
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(payload.trim_end_matches('='))
        .ok()?;
    let claims: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
    let exp = claims.get("exp")?;
    let seconds = exp.as_u64().or_else(|| exp.as_f64().filter(|s| *s >= 0.0).map(|s| s as u64))?;
    UNIX_EPOCH.checked_add(Duration::from_secs(seconds))
}

/// `notAfter` of the first certificate in PEM data.
pub fn certificate_not_after(pem_data: &[u8]) -> Option<SystemTime> {
    use x509_cert::der::Decode;
    let blocks = pem::parse_many(pem_data).ok()?;
    let block = blocks.iter().find(|block| block.tag() == "CERTIFICATE")?;
    let certificate = x509_cert::Certificate::from_der(block.contents()).ok()?;
    let not_after = certificate.tbs_certificate.validity.not_after.to_unix_duration();
    UNIX_EPOCH.checked_add(not_after)
}

/* -------------------------------------------------------------------- AWS */

fn exec_env(exec: &ExecConfig, name: &str) -> Option<String> {
    exec.env
        .as_ref()?
        .iter()
        .find(|env| env.get("name").map(String::as_str) == Some(name))
        .and_then(|env| env.get("value").cloned())
}

/// `~/.aws/config` of an aws exec plugin: `AWS_CONFIG_FILE` from its env,
/// then from ours (`process_file`).
pub(crate) fn aws_config_path(exec: &ExecConfig, home: Option<&Path>, process_file: Option<PathBuf>) -> Option<PathBuf> {
    exec_env(exec, "AWS_CONFIG_FILE")
        .filter(|path| !path.trim().is_empty())
        .map(PathBuf::from)
        .or(process_file)
        .or_else(|| home.map(|home| home.join(".aws").join("config")))
}

fn aws_config_for(
    exec: &ExecConfig,
    env: &StatusEnv,
    cache: &mut HashMap<PathBuf, Option<AwsConfig>>,
) -> Option<AwsConfig> {
    if !broker::display_command(exec).eq_ignore_ascii_case("aws") {
        return None;
    }
    let path = aws_config_path(exec, env.home.as_deref(), env.aws_config_file.clone())?;
    cache
        .entry(path.clone())
        .or_insert_with(|| AwsConfig::read(&path))
        .clone()
}

/// The SSO settings a profile signs in with.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AwsSso {
    /// The profile that holds the SSO configuration (the requested one, or
    /// the `source_profile` it assumes a role from).
    pub login_profile: String,
    pub start_url: String,
    pub session: Option<String>,
}

/// The parts of `~/.aws/config` needed to find SSO profiles. Holds no
/// secrets (those live in `~/.aws/credentials`, which is never read).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct AwsConfig {
    profiles: HashMap<String, HashMap<String, String>>,
    sessions: HashMap<String, HashMap<String, String>>,
}

impl AwsConfig {
    pub fn read(path: &Path) -> Option<Self> {
        let bytes = read_small(path)?;
        Some(Self::parse(&String::from_utf8_lossy(&bytes)))
    }

    pub fn parse(text: &str) -> Self {
        enum Section {
            Profile(String),
            Session(String),
            Other,
        }
        let mut config = AwsConfig::default();
        let mut section = Section::Other;
        for line in text.lines() {
            let trimmed = line.trim();
            if trimmed.is_empty() || trimmed.starts_with('#') || trimmed.starts_with(';') {
                continue;
            }
            if let Some(header) = trimmed.strip_prefix('[').and_then(|h| h.strip_suffix(']')) {
                let header = header.trim();
                section = if header == "default" {
                    Section::Profile("default".to_string())
                } else if let Some(name) = header.strip_prefix("profile ") {
                    Section::Profile(name.trim().to_string())
                } else if let Some(name) = header.strip_prefix("sso-session ") {
                    Section::Session(name.trim().to_string())
                } else {
                    Section::Other
                };
                continue;
            }
            // Indented lines belong to nested settings (e.g. `s3 =`).
            if line.starts_with(char::is_whitespace) {
                continue;
            }
            let Some((key, value)) = trimmed.split_once('=') else { continue };
            let (key, value) = (key.trim().to_ascii_lowercase(), value.trim().to_string());
            let map = match &section {
                Section::Profile(name) => config.profiles.entry(name.clone()).or_default(),
                Section::Session(name) => config.sessions.entry(name.clone()).or_default(),
                Section::Other => continue,
            };
            map.insert(key, value);
        }
        config
    }

    /// The SSO settings of `profile`, following `source_profile` (role
    /// profiles on top of an SSO profile).
    pub fn sso(&self, profile: &str) -> Option<AwsSso> {
        let mut name = profile.to_string();
        let mut seen = HashSet::new();
        while seen.insert(name.clone()) {
            let section = self.profiles.get(&name)?;
            if let Some(session) = section.get("sso_session").filter(|s| !s.is_empty()) {
                let start_url = self.sessions.get(session)?.get("sso_start_url")?.clone();
                return Some(AwsSso {
                    login_profile: name,
                    start_url,
                    session: Some(session.clone()),
                });
            }
            if let Some(start_url) = section.get("sso_start_url").filter(|s| !s.is_empty()) {
                return Some(AwsSso {
                    login_profile: name,
                    start_url: start_url.clone(),
                    session: None,
                });
            }
            name = section.get("source_profile")?.clone();
        }
        None
    }

    /// Every profile one `aws sso login` for `sso` signs in (same start URL).
    pub fn profiles_sharing(&self, sso: &AwsSso) -> HashSet<String> {
        self.profiles
            .keys()
            .filter(|profile| {
                self.sso(profile)
                    .is_some_and(|other| same_start_url(&other.start_url, &sso.start_url))
            })
            .cloned()
            .collect()
    }
}

fn same_start_url(a: &str, b: &str) -> bool {
    a.trim().trim_end_matches('/').eq_ignore_ascii_case(b.trim().trim_end_matches('/'))
}

/// Expiry of the cached SSO token of a start URL.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SsoToken {
    pub expires_at: SystemTime,
    /// The cache entry has a refresh token: the CLI renews it silently.
    pub refreshable: bool,
}

/// Only these fields are read; the access / refresh tokens are skipped.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SsoCacheEntry {
    start_url: Option<String>,
    expires_at: Option<String>,
    refresh_token: Option<serde::de::IgnoredAny>,
}

/// The newest `~/.aws/sso/cache/*.json` entry for `start_url`.
pub fn sso_token(cache_dir: &Path, start_url: &str) -> Option<SsoToken> {
    let entries = std::fs::read_dir(cache_dir).ok()?;
    entries
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.extension().is_some_and(|ext| ext == "json"))
        .filter_map(|path| {
            let bytes = read_small(&path)?;
            let entry: SsoCacheEntry = serde_json::from_slice(&bytes).ok()?;
            if !same_start_url(entry.start_url.as_deref()?, start_url) {
                return None;
            }
            Some(SsoToken {
                expires_at: broker::parse_timestamp(entry.expires_at.as_deref()?)?,
                refreshable: entry.refresh_token.is_some(),
            })
        })
        .max_by_key(|token| token.expires_at)
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine;

    fn env(home: &Path) -> StatusEnv {
        StatusEnv {
            home: Some(home.to_path_buf()),
            aws_config_file: None,
            now: SystemTime::now(),
        }
    }

    fn jwt(exp: i64) -> String {
        let encode = |v: serde_json::Value| base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(v.to_string());
        format!(
            "{}.{}.c2ln",
            encode(serde_json::json!({"alg": "RS256"})),
            encode(serde_json::json!({"sub": "jane", "exp": exp}))
        )
    }

    fn target(kube_config: &Path, context: &str) -> ContextRef {
        ContextRef {
            kube_config: kube_config.to_string_lossy().into_owned(),
            context: context.to_string(),
        }
    }

    #[test]
    fn jwt_and_certificate_expiry() {
        let exp = 2_000_000_000;
        assert_eq!(jwt_expiry(&jwt(exp)), UNIX_EPOCH.checked_add(Duration::from_secs(exp as u64)));
        assert_eq!(jwt_expiry("not-a-jwt"), None);
        assert_eq!(jwt_expiry("a.b.c"), None);

        let not_after = certificate_not_after(broker_cert().as_bytes()).unwrap();
        // 2030-01-01T00:00:00Z
        assert_eq!(system_time_ms(not_after), 1_893_456_000_000);
        assert_eq!(certificate_not_after(b"garbage"), None);
    }

    #[cfg(unix)]
    fn broker_cert() -> &'static str {
        broker::tests::TEST_CERT
    }

    #[cfg(not(unix))]
    fn broker_cert() -> &'static str {
        "-----BEGIN CERTIFICATE-----\nMIIBhzCCAS2gAwIBAgIUOrS+sgTIWrd/hAXe4UxQrhHc9OMwCgYIKoZIzj0EAwIw\nGTEXMBUGA1UEAwwOamV0LXBpbG90LXRlc3QwHhcNMjUwMTAxMDAwMDAwWhcNMzAw\nMTAxMDAwMDAwWjAZMRcwFQYDVQQDDA5qZXQtcGlsb3QtdGVzdDBZMBMGByqGSM49\nAgEGCCqGSM49AwEHA0IABCxPFjRZeT9KYTmv/fPTjJq0fUdSLVs14eCaRBcY0Ikd\nCCxkoquo5P8QRdnDuytGmpwd7QUbm04XSgEo73yh9tKjUzBRMB0GA1UdDgQWBBTx\nJ2AUjmTMCNZS2gdswKAE/+uJyjAfBgNVHSMEGDAWgBTxJ2AUjmTMCNZS2gdswKAE\n/+uJyjAPBgNVHRMBAf8EBTADAQH/MAoGCCqGSM49BAMCA0gAMEUCIBBf6BAu0HjU\nmzSEC27qsiodM9vwCUOhXwczup/MMsQMAiEAz/eV+M7juzawEwVcyA+p2fT+DYp4\nES5J8EfC6QB0T5U=\n-----END CERTIFICATE-----\n"
    }

    const AWS_CONFIG: &str = "\
[default]
region = eu-west-1

[profile prod-admin]
sso_session = corp
sso_account_id = 111111111111
sso_role_name = Admin
region = eu-west-1
s3 =
  max_concurrent_requests = 10

[profile dev]
sso_session = corp
sso_account_id = 222222222222

[profile legacy]
sso_start_url = https://legacy.awsapps.com/start
sso_region = us-east-1

[profile deploy]
role_arn = arn:aws:iam::111111111111:role/deploy
source_profile = prod-admin

[profile keys]
region = us-east-1

; a comment
[sso-session corp]
sso_start_url = https://corp.awsapps.com/start/
sso_region = eu-west-1
";

    #[test]
    fn aws_config_finds_sso_profiles() {
        let config = AwsConfig::parse(AWS_CONFIG);
        assert_eq!(
            config.sso("prod-admin"),
            Some(AwsSso {
                login_profile: "prod-admin".into(),
                start_url: "https://corp.awsapps.com/start/".into(),
                session: Some("corp".into()),
            })
        );
        assert_eq!(config.sso("legacy").unwrap().start_url, "https://legacy.awsapps.com/start");
        assert_eq!(config.sso("deploy").unwrap().login_profile, "prod-admin");
        assert_eq!(config.sso("keys"), None);
        assert_eq!(config.sso("missing"), None);
        assert_eq!(
            config.profiles_sharing(&config.sso("dev").unwrap()),
            HashSet::from(["prod-admin".to_string(), "dev".to_string(), "deploy".to_string()])
        );
    }

    fn write_kubeconfig(dir: &Path, users: &str, contexts: &[(&str, &str)]) -> PathBuf {
        let mut yaml = String::from(
            "apiVersion: v1\nkind: Config\nclusters:\n- name: c\n  cluster:\n    server: https://k8s.example\ncontexts:\n",
        );
        for (name, user) in contexts {
            yaml.push_str(&format!("- name: {name}\n  context:\n    cluster: c\n    user: {user}\n"));
        }
        yaml.push_str("users:\n");
        yaml.push_str(users);
        let path = dir.join("kubeconfig.yaml");
        std::fs::write(&path, yaml).unwrap();
        path
    }

    #[test]
    fn statuses_from_tokens_certificates_and_aws_sso() {
        let home = tempfile::tempdir().unwrap();
        let aws = home.path().join(".aws");
        std::fs::create_dir_all(aws.join("sso").join("cache")).unwrap();
        std::fs::write(aws.join("config"), AWS_CONFIG).unwrap();
        let in_two_hours = chrono::Utc::now() + chrono::Duration::hours(2);
        std::fs::write(
            aws.join("sso").join("cache").join("0123abcd.json"),
            serde_json::json!({
                "startUrl": "https://corp.awsapps.com/start",
                "region": "eu-west-1",
                "accessToken": "sso-access-token-secret",
                "expiresAt": in_two_hours.format("%Y-%m-%dT%H:%M:%SZ").to_string(),
            })
            .to_string(),
        )
        .unwrap();
        // Another start URL, expired.
        std::fs::write(
            aws.join("sso").join("cache").join("legacy.json"),
            r#"{"startUrl":"https://legacy.awsapps.com/start","accessToken":"x","expiresAt":"2020-01-01T00:00:00UTC"}"#,
        )
        .unwrap();
        std::fs::write(aws.join("sso").join("cache").join("botocore-client-id-eu-west-1.json"), r#"{"clientId":"c"}"#).unwrap();

        let soon = chrono::Utc::now().timestamp() + 600;
        let cert = base64::engine::general_purpose::STANDARD.encode(broker_cert());
        let users = format!(
            "- name: aws\n  user:\n    exec:\n      apiVersion: client.authentication.k8s.io/v1beta1\n      command: aws\n      args: [eks, get-token, --cluster-name, prod]\n      env:\n      - name: AWS_PROFILE\n        value: prod-admin\n\
             - name: aws-legacy\n  user:\n    exec:\n      apiVersion: client.authentication.k8s.io/v1beta1\n      command: aws\n      args: [eks, get-token, --cluster-name, old, --profile, legacy]\n\
             - name: jwt\n  user:\n    token: {}\n\
             - name: opaque\n  user:\n    token: just-a-static-token\n\
             - name: cert\n  user:\n    client-certificate-data: {cert}\n    client-key-data: a2V5\n\
             - name: kubelogin\n  user:\n    exec:\n      apiVersion: client.authentication.k8s.io/v1beta1\n      command: kubelogin\n      args: [get-token, --login, devicecode, --server-id, x]\n\
             - name: gke\n  user:\n    exec:\n      apiVersion: client.authentication.k8s.io/v1beta1\n      command: gke-gcloud-auth-plugin\n\
             - name: oidc\n  user:\n    auth-provider:\n      name: oidc\n      config:\n        idp-issuer-url: https://issuer\n",
            jwt(soon)
        );
        let path = write_kubeconfig(
            home.path(),
            &users,
            &[
                ("aws", "aws"),
                ("aws-legacy", "aws-legacy"),
                ("jwt", "jwt"),
                ("opaque", "opaque"),
                ("cert", "cert"),
                ("kubelogin", "kubelogin"),
                ("gke", "gke"),
                ("oidc", "oidc"),
                ("no-user", "nobody"),
            ],
        );
        let names = ["aws", "aws-legacy", "jwt", "opaque", "cert", "kubelogin", "gke", "oidc", "no-user", "missing"];
        let result = statuses(names.iter().map(|n| target(&path, n)).collect(), &env(home.path()));
        let by_name: HashMap<&str, &CredentialStatus> = result.iter().map(|s| (s.context.as_str(), s)).collect();

        let aws = by_name["aws"];
        assert_eq!(aws.kind, AuthKind::Exec);
        assert_eq!(aws.command.as_deref(), Some("aws"));
        assert_eq!(aws.aws_profile.as_deref(), Some("prod-admin"));
        assert_eq!(aws.state, CredentialState::Valid);
        assert_eq!(aws.expires_at.map(|ms| ms / 1000), Some(in_two_hours.timestamp()));
        assert!(aws.can_sign_in);
        assert_eq!(aws.sign_in_label.as_deref(), Some("Sign in with AWS SSO (profile prod-admin)"));

        let legacy = by_name["aws-legacy"];
        assert_eq!(legacy.aws_profile.as_deref(), Some("legacy"));
        assert_eq!(legacy.state, CredentialState::Expired);

        assert_eq!(by_name["jwt"].kind, AuthKind::Token);
        assert_eq!(by_name["jwt"].state, CredentialState::ExpiringSoon);
        assert_eq!(by_name["jwt"].expires_at, Some(soon * 1000));
        assert!(!by_name["jwt"].can_sign_in);
        assert_eq!(by_name["opaque"].state, CredentialState::Unknown);

        assert_eq!(by_name["cert"].kind, AuthKind::ClientCert);
        assert_eq!(by_name["cert"].expires_at, Some(1_893_456_000_000));

        assert_eq!(by_name["kubelogin"].interactive, InteractiveClass::Interactive);
        assert_eq!(by_name["kubelogin"].state, CredentialState::Unknown);
        assert_eq!(by_name["kubelogin"].sign_in_label.as_deref(), Some("Sign in with kubelogin"));
        assert_eq!(by_name["gke"].sign_in_label.as_deref(), Some("Sign in with gcloud"));
        assert_eq!(by_name["oidc"].kind, AuthKind::AuthProvider);
        assert!(!by_name["oidc"].can_sign_in);
        assert_eq!(by_name["no-user"].kind, AuthKind::None);
        assert_eq!(by_name["missing"].state, CredentialState::Unknown);

        let json = serde_json::to_string(&result).unwrap();
        assert!(!json.contains("sso-access-token-secret"));
        assert!(!json.contains("just-a-static-token"));
        assert!(json.contains("\"expiringSoon\""));
        assert!(json.contains("\"signInLabel\""));

        // A recent sign-in problem wins.
        center::report(center::AuthIssue {
            kube_config: path.to_string_lossy().into_owned(),
            context: "jwt".into(),
            kind: center::AuthErrorKind::Unauthorized,
            source: center::IssueSource::Api,
            message: "401".into(),
            command: None,
        });
        let jwt_status = statuses(vec![target(&path, "jwt")], &env(home.path()));
        assert_eq!(jwt_status[0].state, CredentialState::NeedsLogin);
    }

    #[test]
    fn refreshable_sso_tokens_and_broker_credentials() {
        let home = tempfile::tempdir().unwrap();
        let cache = home.path().join("cache");
        std::fs::create_dir_all(&cache).unwrap();
        std::fs::write(
            cache.join("a.json"),
            r#"{"startUrl":"https://corp.awsapps.com/start","accessToken":"x","refreshToken":"r","expiresAt":"2020-01-01T00:00:00Z"}"#,
        )
        .unwrap();
        let token = sso_token(&cache, "https://corp.awsapps.com/start/").unwrap();
        assert!(token.refreshable);
        assert_eq!(sso_token(&cache, "https://other.awsapps.com/start"), None);

        // Broker cache: a credential minted for the context's key.
        let path = write_kubeconfig(
            home.path(),
            "- name: plugin\n  user:\n    exec:\n      apiVersion: client.authentication.k8s.io/v1beta1\n      command: /opt/get-token\n",
            &[("status-broker", "plugin")],
        );
        let config = read_kubeconfig(Some(&path.to_string_lossy())).unwrap();
        let found = context_auth(&config, "status-broker").unwrap();
        let key = CredentialKey::with_server(
            &path.to_string_lossy(),
            "plugin",
            found.auth.exec.as_ref().unwrap(),
            found.server.as_deref(),
        );
        broker::slot(&key).store(broker::Credential {
            token: Some("t".into()),
            client_certificate: None,
            client_key: None,
            expires_at: Some(SystemTime::now() + Duration::from_secs(3600)),
            minted_at: SystemTime::now(),
        });
        let status = &statuses(vec![target(&path, "status-broker")], &env(home.path()))[0];
        assert_eq!(status.state, CredentialState::Valid);
        assert!(status.expires_at.is_some());
        assert_eq!(status.sign_in_label.as_deref(), Some("Sign in with get-token"));
    }
}

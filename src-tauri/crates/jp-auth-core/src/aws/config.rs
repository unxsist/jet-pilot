//! `~/.aws/config` and `~/.aws/credentials` (or `AWS_CONFIG_FILE` /
//! `AWS_SHARED_CREDENTIALS_FILE`): profile names, kinds and SSO settings.
//! Values of secret keys are never kept: only whether they are present.

use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::path::Path;

use serde::Serialize;

use super::AwsContext;

const MAX_FILE: u64 = 1024 * 1024;

/// Keys whose values are secrets: parsed as "present", never stored.
const SECRET_KEYS: &[&str] = &[
    "aws_secret_access_key",
    "aws_session_token",
    "aws_security_token",
];

type Section = BTreeMap<String, String>;

#[derive(Debug, Clone, Default, PartialEq)]
pub struct AwsFiles {
    /// `[default]` / `[profile x]` of the config file, merged with the
    /// `[x]` sections of the credentials file (config wins).
    pub profiles: BTreeMap<String, Section>,
    pub sessions: BTreeMap<String, Section>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ProfileKind {
    Sso,
    AssumeRole,
    Static,
    CredentialProcess,
    WebIdentity,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileInfo {
    pub name: String,
    pub kind: ProfileKind,
    pub region: Option<String>,
    pub sso_session: Option<String>,
    pub sso_start_url: Option<String>,
    pub sso_region: Option<String>,
    pub mfa: bool,
}

/// The IAM Identity Center settings a profile signs in with (following
/// `source_profile` to an SSO profile).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProfileSso {
    pub profile: String,
    pub start_url: String,
    pub region: Option<String>,
    pub session: Option<String>,
}

fn read_small(path: &Path) -> Option<String> {
    let meta = std::fs::metadata(path).ok()?;
    if !meta.is_file() || meta.len() > MAX_FILE {
        return None;
    }
    std::fs::read_to_string(path).ok()
}

/// `[section]` headers and `key = value` lines; indented lines (nested
/// settings such as `s3 =`) and comments are skipped.
fn sections(text: &str) -> Vec<(String, Section)> {
    let mut out: Vec<(String, Section)> = Vec::new();
    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') || trimmed.starts_with(';') {
            continue;
        }
        if let Some(header) = trimmed.strip_prefix('[').and_then(|h| h.split_once(']')) {
            out.push((header.0.trim().to_string(), Section::new()));
            continue;
        }
        if line.starts_with(char::is_whitespace) {
            continue;
        }
        let Some((key, value)) = trimmed.split_once('=') else {
            continue;
        };
        let Some((_, section)) = out.last_mut() else {
            continue;
        };
        let key = key.trim().to_ascii_lowercase();
        let value = if SECRET_KEYS.contains(&key.as_str()) {
            "<set>".to_string()
        } else {
            // Inline comments after whitespace (`value ; comment`).
            let value = value.trim();
            let cut = [" #", " ;", "\t#", "\t;"]
                .iter()
                .filter_map(|marker| value.find(marker))
                .min()
                .unwrap_or(value.len());
            value[..cut].trim().to_string()
        };
        section.insert(key, value);
    }
    out
}

impl AwsFiles {
    pub fn parse(config: &str, credentials: &str) -> AwsFiles {
        let mut files = AwsFiles::default();
        for (header, section) in sections(config) {
            let (kind, name) = match header.split_once(char::is_whitespace) {
                Some((kind, name)) => (kind.trim(), name.trim()),
                None => ("", header.as_str()),
            };
            let target = match (kind, name) {
                ("", "default") | ("profile", _) => {
                    files.profiles.entry(name.to_string()).or_default()
                }
                ("sso-session", _) => files.sessions.entry(name.to_string()).or_default(),
                _ => continue,
            };
            target.extend(section);
        }
        for (name, section) in sections(credentials) {
            let target = files.profiles.entry(name.trim().to_string()).or_default();
            for (key, value) in section {
                target.entry(key).or_insert(value);
            }
        }
        files
    }

    /// The files of `ctx` (missing files are empty).
    pub fn load(ctx: &AwsContext) -> AwsFiles {
        let config = ctx
            .aws_config_path()
            .and_then(|p| read_small(&p))
            .unwrap_or_default();
        let credentials = ctx
            .aws_credentials_path()
            .and_then(|p| read_small(&p))
            .unwrap_or_default();
        AwsFiles::parse(&config, &credentials)
    }

    fn get<'a>(&'a self, profile: &str, key: &str) -> Option<&'a str> {
        self.profiles
            .get(profile)?
            .get(key)
            .map(String::as_str)
            .filter(|v| !v.is_empty())
    }

    pub fn has_profile(&self, profile: &str) -> bool {
        self.profiles.contains_key(profile)
    }

    pub fn kind(&self, profile: &str) -> ProfileKind {
        let has = |key: &str| self.get(profile, key).is_some();
        if has("role_arn") {
            if has("web_identity_token_file") && !has("source_profile") && !has("credential_source")
            {
                ProfileKind::WebIdentity
            } else {
                ProfileKind::AssumeRole
            }
        } else if has("sso_session") || has("sso_start_url") {
            ProfileKind::Sso
        } else if has("aws_access_key_id") {
            ProfileKind::Static
        } else if has("credential_process") {
            ProfileKind::CredentialProcess
        } else {
            ProfileKind::Unknown
        }
    }

    /// The SSO settings of `profile`, following `source_profile`.
    pub fn sso(&self, profile: &str) -> Option<ProfileSso> {
        let mut name = profile.to_string();
        let mut seen = HashSet::new();
        while seen.insert(name.clone()) {
            if let Some(session) = self.get(&name, "sso_session") {
                let section = self.sessions.get(session)?;
                return Some(ProfileSso {
                    profile: name.clone(),
                    start_url: section.get("sso_start_url")?.clone(),
                    region: section.get("sso_region").cloned(),
                    session: Some(session.to_string()),
                });
            }
            if let Some(start_url) = self.get(&name, "sso_start_url") {
                return Some(ProfileSso {
                    profile: name.clone(),
                    start_url: start_url.to_string(),
                    region: self.get(&name, "sso_region").map(str::to_string),
                    session: None,
                });
            }
            name = self.get(&name, "source_profile")?.to_string();
        }
        None
    }

    /// `[sso-session x]` names whose start URL is `start_url`.
    pub fn sessions_for(&self, start_url: &str) -> Vec<String> {
        self.sessions
            .iter()
            .filter(|(_, s)| {
                s.get("sso_start_url")
                    .is_some_and(|u| same_start_url(u, start_url))
            })
            .map(|(name, _)| name.clone())
            .collect()
    }

    /// Whether a legacy profile (`sso_start_url` in the profile itself)
    /// signs in at `start_url`.
    pub fn legacy_profiles_use(&self, start_url: &str) -> bool {
        self.profiles.keys().any(|p| {
            self.get(p, "sso_session").is_none()
                && self
                    .get(p, "sso_start_url")
                    .is_some_and(|u| same_start_url(u, start_url))
        })
    }

    /// Every profile, sorted by name.
    pub fn profile_infos(&self) -> Vec<ProfileInfo> {
        let names: BTreeSet<&String> = self.profiles.keys().collect();
        names
            .into_iter()
            .map(|name| {
                let sso = self.sso(name);
                ProfileInfo {
                    name: name.clone(),
                    kind: self.kind(name),
                    region: self.get(name, "region").map(str::to_string),
                    sso_session: sso.as_ref().and_then(|s| s.session.clone()),
                    sso_start_url: sso.as_ref().map(|s| s.start_url.clone()),
                    sso_region: sso.as_ref().and_then(|s| s.region.clone()),
                    mfa: self.get(name, "mfa_serial").is_some(),
                }
            })
            .collect()
    }

    /// `region` of a profile.
    pub fn region(&self, profile: &str) -> Option<String> {
        self.get(profile, "region").map(str::to_string)
    }

    /// The assume-role settings of a profile that needs an MFA code.
    pub fn mfa_role(&self, profile: &str) -> Option<MfaRole> {
        Some(MfaRole {
            role_arn: self.get(profile, "role_arn")?.to_string(),
            source_profile: self.get(profile, "source_profile")?.to_string(),
            mfa_serial: self.get(profile, "mfa_serial")?.to_string(),
            external_id: self.get(profile, "external_id").map(str::to_string),
            session_name: self.get(profile, "role_session_name").map(str::to_string),
            duration_seconds: self
                .get(profile, "duration_seconds")
                .and_then(|d| d.parse().ok()),
        })
    }
}

/// `role_arn` + `source_profile` + `mfa_serial` of a profile.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MfaRole {
    pub role_arn: String,
    pub source_profile: String,
    pub mfa_serial: String,
    pub external_id: Option<String>,
    pub session_name: Option<String>,
    pub duration_seconds: Option<i32>,
}

pub fn same_start_url(a: &str, b: &str) -> bool {
    a.trim()
        .trim_end_matches('/')
        .eq_ignore_ascii_case(b.trim().trim_end_matches('/'))
}

#[cfg(test)]
mod tests {
    use super::*;

    const CONFIG: &str = r#"
[default]
region = eu-west-1

[sso-session acme]
sso_start_url = https://acme.awsapps.com/start/
sso_region = eu-west-1
sso_registration_scopes = sso:account:access

[profile prod-admin]
sso_session = acme
sso_account_id = 111111111111
sso_role_name = AdministratorAccess
region = eu-central-1   # main region

[profile legacy]
sso_start_url = https://legacy.awsapps.com/start
sso_region = us-east-1
sso_account_id = 222222222222
sso_role_name = ReadOnly

[profile deploy]
role_arn = arn:aws:iam::333333333333:role/deploy
source_profile = prod-admin

[profile mfa-role]
role_arn = arn:aws:iam::444444444444:role/admin
source_profile = default
mfa_serial = arn:aws:iam::555555555555:mfa/jane
duration_seconds = 7200

[profile vault]
credential_process = /usr/local/bin/aws-vault export --format=json vault
s3 =
  max_concurrent_requests = 20

[profile ci]
role_arn = arn:aws:iam::666666666666:role/ci
web_identity_token_file = /var/run/token

[services ignored]
x = y
"#;

    const CREDENTIALS: &str = "
[default]
aws_access_key_id = AKIAEXAMPLE
aws_secret_access_key = super-secret-value

[keys-only]
aws_access_key_id = AKIAOTHER
aws_secret_access_key = another-secret
aws_session_token = and-a-token
";

    #[test]
    fn profiles_are_classified_without_secrets() {
        let files = AwsFiles::parse(CONFIG, CREDENTIALS);
        let infos = files.profile_infos();
        let by = |n: &str| infos.iter().find(|p| p.name == n).unwrap().clone();
        let names: Vec<&str> = infos.iter().map(|p| p.name.as_str()).collect();
        assert_eq!(
            names,
            [
                "ci",
                "default",
                "deploy",
                "keys-only",
                "legacy",
                "mfa-role",
                "prod-admin",
                "vault"
            ]
        );

        let prod = by("prod-admin");
        assert_eq!(prod.kind, ProfileKind::Sso);
        assert_eq!(prod.sso_session.as_deref(), Some("acme"));
        assert_eq!(
            prod.sso_start_url.as_deref(),
            Some("https://acme.awsapps.com/start/")
        );
        assert_eq!(prod.sso_region.as_deref(), Some("eu-west-1"));
        assert_eq!(prod.region.as_deref(), Some("eu-central-1"));

        let legacy = by("legacy");
        assert_eq!(legacy.kind, ProfileKind::Sso);
        assert_eq!(legacy.sso_session, None);
        assert_eq!(legacy.sso_region.as_deref(), Some("us-east-1"));

        // A role on top of an SSO profile: its sign-in is the SSO one.
        let deploy = by("deploy");
        assert_eq!(deploy.kind, ProfileKind::AssumeRole);
        assert_eq!(deploy.sso_session.as_deref(), Some("acme"));
        assert!(!deploy.mfa);

        let mfa = by("mfa-role");
        assert_eq!(mfa.kind, ProfileKind::AssumeRole);
        assert!(mfa.mfa);
        assert_eq!(mfa.sso_start_url, None);
        let role = files.mfa_role("mfa-role").unwrap();
        assert_eq!(role.duration_seconds, Some(7200));
        assert_eq!(role.source_profile, "default");

        assert_eq!(by("vault").kind, ProfileKind::CredentialProcess);
        assert_eq!(by("ci").kind, ProfileKind::WebIdentity);
        assert_eq!(by("keys-only").kind, ProfileKind::Static);
        // The config's [default] merged with the credentials' [default].
        assert_eq!(by("default").kind, ProfileKind::Static);
        assert_eq!(by("default").region.as_deref(), Some("eu-west-1"));

        let json = serde_json::to_string(&infos).unwrap();
        for secret in ["super-secret-value", "another-secret", "and-a-token"] {
            assert!(!json.contains(secret));
            assert!(!format!("{files:?}").contains(secret));
        }
        assert!(json.contains("\"kind\":\"assumeRole\""));
        assert!(json.contains("\"ssoStartUrl\""));

        assert_eq!(
            files.sessions_for("https://ACME.awsapps.com/start"),
            vec!["acme".to_string()]
        );
        assert!(files
            .sessions_for("https://legacy.awsapps.com/start")
            .is_empty());
        assert!(files.legacy_profiles_use("https://legacy.awsapps.com/start/"));
        assert!(!files.legacy_profiles_use("https://acme.awsapps.com/start"));
    }

    #[test]
    fn source_profile_loops_end() {
        let files = AwsFiles::parse(
            "[profile a]\nsource_profile = b\nrole_arn = x\n[profile b]\nsource_profile = a\nrole_arn = y\n",
            "",
        );
        assert_eq!(files.sso("a"), None);
    }
}

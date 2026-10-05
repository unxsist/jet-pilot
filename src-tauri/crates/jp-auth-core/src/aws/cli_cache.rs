//! The aws CLI's SSO token cache, `~/.aws/sso/cache/<sha1>.json`.
//!
//! A JET Pilot sign-in writes the token there exactly like `aws sso login`
//! (device flow) does, so the aws CLI, SDKs and tools reading the cache
//! (aws-config, botocore, ...) share the session:
//!
//! - key: SHA-1 (hex) of the `[sso-session <name>]` whose `sso_start_url`
//!   is the start URL, else of the start URL itself (legacy profiles);
//! - contents: Python `json.dumps` style (`", "` / `": "` separators,
//!   non-ASCII escaped), keys in the CLI's order: `startUrl`, `region`,
//!   `accessToken`, `expiresAt`, `clientId`, `clientSecret`,
//!   `registrationExpiresAt`, `refreshToken`; timestamps
//!   `%Y-%m-%dT%H:%M:%SZ` (UTC);
//! - 0600, replaced atomically.
//!
//! `~/.aws/config` is never written.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha1::{Digest, Sha1};
use zeroize::Zeroize;

use super::config::{same_start_url, AwsFiles};
use crate::time::{format_rfc3339, parse_rfc3339};

const MAX_FILE: u64 = 1024 * 1024;

/// An IAM Identity Center access token with what refreshing it needs.
/// Stored as is (camelCase, unix seconds) in the vault.
#[derive(Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SsoToken {
    pub start_url: String,
    pub region: String,
    pub access_token: String,
    /// Unix seconds.
    pub expires_at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_secret: Option<String>,
    /// Unix seconds.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub registration_expires_at: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub refresh_token: Option<String>,
}

impl Drop for SsoToken {
    fn drop(&mut self) {
        self.access_token.zeroize();
        self.client_secret.zeroize();
        self.refresh_token.zeroize();
    }
}

impl std::fmt::Debug for SsoToken {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SsoToken")
            .field("start_url", &self.start_url)
            .field("region", &self.region)
            .field("expires_at", &self.expires_at)
            .field("refreshable", &self.can_refresh(crate::now_secs()))
            .finish()
    }
}

impl SsoToken {
    /// It has a refresh token and a client registration that hasn't
    /// expired at `now`.
    pub fn can_refresh(&self, now: i64) -> bool {
        self.refresh_token.as_deref().is_some_and(|t| !t.is_empty())
            && self.client_id.is_some()
            && self.client_secret.is_some()
            && self.registration_expires_at.is_some_and(|at| at > now)
    }

    /// The aws CLI's file contents.
    pub fn to_cli_json(&self) -> String {
        let mut fields: Vec<(&str, String)> = vec![
            ("startUrl", self.start_url.clone()),
            ("region", self.region.clone()),
            ("accessToken", self.access_token.clone()),
            ("expiresAt", format_rfc3339(self.expires_at)),
        ];
        if let (Some(id), Some(secret)) = (&self.client_id, &self.client_secret) {
            fields.push(("clientId", id.clone()));
            fields.push(("clientSecret", secret.clone()));
            if let Some(at) = self.registration_expires_at {
                fields.push(("registrationExpiresAt", format_rfc3339(at)));
            }
        }
        if let Some(refresh) = &self.refresh_token {
            fields.push(("refreshToken", refresh.clone()));
        }
        let mut out = String::from("{");
        for (i, (key, value)) in fields.iter_mut().enumerate() {
            if i > 0 {
                out.push_str(", ");
            }
            python_json_string(&mut out, key);
            out.push_str(": ");
            python_json_string(&mut out, value);
            value.zeroize();
        }
        out.push('}');
        out
    }

    /// Parses a cache file (None for other files in the directory, e.g.
    /// client registrations).
    pub fn from_cli_json(bytes: &[u8]) -> Option<SsoToken> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Raw {
            start_url: Option<String>,
            region: Option<String>,
            access_token: Option<String>,
            expires_at: Option<String>,
            client_id: Option<String>,
            client_secret: Option<String>,
            registration_expires_at: Option<String>,
            refresh_token: Option<String>,
        }
        let raw: Raw = serde_json::from_slice(bytes).ok()?;
        Some(SsoToken {
            start_url: raw.start_url.unwrap_or_default(),
            region: raw.region.unwrap_or_default(),
            access_token: raw.access_token.filter(|t| !t.is_empty())?,
            expires_at: parse_rfc3339(raw.expires_at.as_deref()?)?,
            client_id: raw.client_id,
            client_secret: raw.client_secret,
            registration_expires_at: raw
                .registration_expires_at
                .as_deref()
                .and_then(parse_rfc3339),
            refresh_token: raw.refresh_token,
        })
    }
}

/// Appends `value` as a JSON string the way Python's `json.dumps` writes it
/// (`ensure_ascii=True`).
fn python_json_string(out: &mut String, value: &str) {
    out.push('"');
    for c in value.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\u{8}' => out.push_str("\\b"),
            '\u{c}' => out.push_str("\\f"),
            ' '..='~' => out.push(c),
            _ => {
                let mut units = [0u16; 2];
                for unit in c.encode_utf16(&mut units) {
                    out.push_str(&format!("\\u{unit:04x}"));
                }
            }
        }
    }
    out.push('"');
}

/// SHA-1 hex of `input`: the cache key of a session name / start URL.
pub fn cache_key(input: &str) -> String {
    Sha1::digest(input.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// Where a token for `start_url` goes, with the start URL to record in
/// each file: one entry per matching `[sso-session]` (its name hashed)
/// and per distinct legacy-profile spelling of the URL; the URL itself
/// when nothing in `~/.aws/config` refers to it.
pub fn cache_targets(files: &AwsFiles, start_url: &str) -> Vec<(String, String)> {
    fn push(targets: &mut Vec<(String, String)>, key: String, url: String) {
        if !targets.iter().any(|(k, _)| *k == key) {
            targets.push((key, url));
        }
    }
    let mut targets: Vec<(String, String)> = Vec::new();
    for session in files.sessions_for(start_url) {
        let url = files
            .sessions
            .get(&session)
            .and_then(|s| s.get("sso_start_url").cloned())
            .unwrap_or_else(|| start_url.to_string());
        push(&mut targets, cache_key(&session), url);
    }
    for section in files.profiles.values() {
        if section.contains_key("sso_session") {
            continue;
        }
        if let Some(url) = section
            .get("sso_start_url")
            .filter(|u| same_start_url(u, start_url))
        {
            push(&mut targets, cache_key(url), url.clone());
        }
    }
    if targets.is_empty() {
        push(&mut targets, cache_key(start_url), start_url.to_string());
    }
    targets
}

fn read_small(path: &Path) -> Option<Vec<u8>> {
    let meta = std::fs::metadata(path).ok()?;
    if !meta.is_file() || meta.len() > MAX_FILE {
        return None;
    }
    std::fs::read(path).ok()
}

/// The cache file of `key`.
pub fn read(dir: &Path, key: &str) -> Option<SsoToken> {
    SsoToken::from_cli_json(&read_small(&dir.join(format!("{key}.json")))?)
}

/// The cached token for `start_url` that expires last (any file whose
/// `startUrl` matches).
pub fn read_best(dir: &Path, start_url: &str) -> Option<SsoToken> {
    let entries = std::fs::read_dir(dir).ok()?;
    entries
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.extension().is_some_and(|ext| ext == "json"))
        .filter_map(|path| SsoToken::from_cli_json(&read_small(&path)?))
        .filter(|token| same_start_url(&token.start_url, start_url))
        .max_by_key(|token| token.expires_at)
}

/// Writes `token` under `key` (creating the cache directory).
pub fn write(dir: &Path, key: &str, token: &SsoToken) -> std::io::Result<PathBuf> {
    crate::paths::ensure_private_dir(dir)?;
    let path = dir.join(format!("{key}.json"));
    let mut text = token.to_cli_json();
    let result = crate::fsutil::write_atomic(&path, text.as_bytes(), 0o600);
    text.zeroize();
    result.map(|_| path)
}

/// Writes `token` to every cache file the aws CLI would read it from.
pub fn write_all(dir: &Path, files: &AwsFiles, token: &SsoToken) -> std::io::Result<Vec<PathBuf>> {
    cache_targets(files, &token.start_url)
        .into_iter()
        .map(|(key, url)| {
            let mut copy = token.clone();
            copy.start_url = url;
            write(dir, &key, &copy)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn token() -> SsoToken {
        SsoToken {
            start_url: "https://acme.awsapps.com/start".into(),
            region: "eu-west-1".into(),
            access_token: "aoaAAAAAGaccess".into(),
            expires_at: 1_791_201_600,
            client_id: Some("clientIdValue".into()),
            client_secret: Some("eyJraWQiOiJrZXktMTU2NDAyODA5OSIsImFsZyI6IkhTMzg0In0".into()),
            registration_expires_at: Some(1_798_977_600),
            refresh_token: Some("aorAAAAAGrefresh".into()),
        }
    }

    /// What the aws CLI v2 writes after `aws sso login --use-device-code`
    /// (`SSOTokenFetcher._create_token_attempt`, `_sso_json_dumps`): the
    /// same token, produced by Python's `json.dumps`.
    const CLI_SAMPLE: &str = r#"{"startUrl": "https://acme.awsapps.com/start", "region": "eu-west-1", "accessToken": "aoaAAAAAGaccess", "expiresAt": "2026-10-05T12:00:00Z", "clientId": "clientIdValue", "clientSecret": "eyJraWQiOiJrZXktMTU2NDAyODA5OSIsImFsZyI6IkhTMzg0In0", "registrationExpiresAt": "2027-01-03T12:00:00Z", "refreshToken": "aorAAAAAGrefresh"}"#;

    #[test]
    fn writes_the_cli_format_byte_for_byte() {
        assert_eq!(token().to_cli_json(), CLI_SAMPLE);
        assert_eq!(
            SsoToken::from_cli_json(CLI_SAMPLE.as_bytes()),
            Some(token())
        );

        // Python escapes non-ASCII and control characters.
        let mut out = String::new();
        python_json_string(&mut out, "a\"b\\c\nd\u{7f}\u{e9}\u{1f600}/");
        assert_eq!(out, r#""a\"b\\c\nd\u007f\u00e9\ud83d\ude00/""#);

        // Without a refresh token / registration (older CLI entries).
        let mut bare = token();
        bare.client_id = None;
        bare.client_secret = None;
        bare.registration_expires_at = None;
        bare.refresh_token = None;
        assert_eq!(
            bare.to_cli_json(),
            r#"{"startUrl": "https://acme.awsapps.com/start", "region": "eu-west-1", "accessToken": "aoaAAAAAGaccess", "expiresAt": "2026-10-05T12:00:00Z"}"#
        );
        assert!(!format!("{:?}", token()).contains("aoaAAAAAGaccess"));
    }

    #[test]
    fn keys_follow_the_cli() {
        // hashlib.sha1(b"acme").hexdigest() / sha1(start URL).
        assert_eq!(
            cache_key("acme"),
            "293abb6b76d7791c0732cc517d38c4b5c734b87f"
        );
        assert_eq!(
            cache_key("https://acme.awsapps.com/start"),
            "40169cea58ca6cbf23fb27b2542923fb5f524af0"
        );

        let files = AwsFiles::parse(
            "[sso-session acme]\nsso_start_url = https://acme.awsapps.com/start/\nsso_region = eu-west-1\n\
             [profile old]\nsso_start_url = https://ACME.awsapps.com/start\nsso_region = eu-west-1\n",
            "",
        );
        let targets = cache_targets(&files, "https://acme.awsapps.com/start");
        assert_eq!(
            targets,
            vec![
                (
                    cache_key("acme"),
                    "https://acme.awsapps.com/start/".to_string()
                ),
                (
                    cache_key("https://ACME.awsapps.com/start"),
                    "https://ACME.awsapps.com/start".to_string()
                ),
            ]
        );
        // Nothing in ~/.aws/config: the start URL.
        let empty = AwsFiles::default();
        assert_eq!(
            cache_targets(&empty, "https://other.awsapps.com/start"),
            vec![(
                cache_key("https://other.awsapps.com/start"),
                "https://other.awsapps.com/start".to_string()
            )]
        );
    }

    #[test]
    fn write_read_and_pick_the_newest() {
        let dir = tempfile::tempdir().unwrap();
        let cache = dir.path().join("sso").join("cache");
        let files = AwsFiles::parse(
            "[sso-session acme]\nsso_start_url = https://acme.awsapps.com/start\n",
            "",
        );
        let paths = write_all(&cache, &files, &token()).unwrap();
        assert_eq!(
            paths,
            vec![cache.join(format!("{}.json", cache_key("acme")))]
        );
        assert_eq!(std::fs::read_to_string(&paths[0]).unwrap(), CLI_SAMPLE);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&paths[0]).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
        }
        assert_eq!(read(&cache, &cache_key("acme")), Some(token()));

        // A registration file and an older token for the same URL.
        std::fs::write(
            cache.join("reg.json"),
            r#"{"clientId": "x", "clientSecret": "y", "expiresAt": "2027-01-01T00:00:00Z"}"#,
        )
        .unwrap();
        let mut older = token();
        older.expires_at -= 3600;
        write(&cache, "older", &older).unwrap();
        assert_eq!(
            read_best(&cache, "https://acme.awsapps.com/start/"),
            Some(token())
        );
        assert_eq!(read_best(&cache, "https://nope.awsapps.com/start"), None);
    }
}

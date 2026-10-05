//! Cloud connections: `~/.kube/jet-pilot/connections.json` (0600, atomic
//! writes under `connections.lock`). They hold no secrets: SSO tokens,
//! client registrations and access keys live in the vault (and the
//! standard `~/.aws/sso/cache`). The helper reads this file to find the
//! IAM Identity Center start URL of a connection.

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::fsutil;

pub const FILE_NAME: &str = "connections.json";
const LOCK_NAME: &str = "connections.lock";
const LOCK_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_FILE: u64 = 4 * 1024 * 1024;

/// `~/.kube/jet-pilot/connections.json`.
pub fn default_path() -> PathBuf {
    crate::paths::jet_pilot_home().join(FILE_NAME)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ConnectionKind {
    /// IAM Identity Center, signed in by JET Pilot (device flow).
    Sso,
    /// A profile of `~/.aws/config` / `~/.aws/credentials`.
    Profile,
    /// Access keys in the vault.
    Keys,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ConnectionStatus {
    SignedIn,
    Expired,
    #[default]
    SignedOut,
    Error,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SsoSettings {
    pub start_url: String,
    /// The IAM Identity Center region.
    pub region: String,
}

/// An account + role pair to scan (SSO connections).
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SsoTarget {
    pub account_id: String,
    #[serde(default)]
    pub account_name: Option<String>,
    pub role_name: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudConnection {
    pub id: String,
    /// `aws`
    pub provider: String,
    pub kind: ConnectionKind,
    pub label: String,
    /// The signed-in email, or the ARN `GetCallerIdentity` returned.
    #[serde(default)]
    pub identity: Option<String>,
    #[serde(default)]
    pub sso: Option<SsoSettings>,
    #[serde(default)]
    pub profile: Option<String>,
    /// The home region for API calls that need one (access keys: as
    /// entered; profiles: the profile's `region`). SSO connections use the
    /// Identity Center region.
    #[serde(default)]
    pub region: Option<String>,
    /// Regions to scan; empty = every region enabled for the account.
    #[serde(default)]
    pub regions: Vec<String>,
    #[serde(default)]
    pub targets: Vec<SsoTarget>,
    /// Stored: the last known state (`error` with `message` after a failed
    /// discovery). Listing recomputes it from the credentials.
    #[serde(default)]
    pub status: ConnectionStatus,
    /// Unix ms.
    #[serde(default)]
    pub expires_at: Option<i64>,
    #[serde(default)]
    pub message: Option<String>,
    /// Unix ms.
    pub created_at: i64,
}

impl CloudConnection {
    /// The region for calls that need one: the connection's, the SSO
    /// region, else `us-east-1`.
    pub fn home_region(&self) -> String {
        self.region
            .clone()
            .filter(|r| !r.is_empty())
            .or_else(|| self.sso.as_ref().map(|s| s.region.clone()))
            .unwrap_or_else(|| "us-east-1".to_string())
    }

    pub fn display_name(&self) -> String {
        if !self.label.trim().is_empty() {
            return self.label.clone();
        }
        match (&self.sso, &self.profile) {
            (Some(sso), _) => sso.start_url.clone(),
            (_, Some(profile)) => format!("profile {profile}"),
            _ => self.id.clone(),
        }
    }
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct File {
    #[serde(default)]
    version: u32,
    #[serde(default)]
    connections: Vec<CloudConnection>,
}

/// Secret ids of a connection in the vault.
pub fn sso_client_secret_id(id: &str) -> String {
    format!("conn:{id}:sso-client")
}

pub fn sso_token_secret_id(id: &str) -> String {
    format!("conn:{id}:sso-token")
}

pub fn keys_secret_id(id: &str) -> String {
    format!("conn:{id}:aws-keys")
}

pub fn mfa_session_secret_id(id: &str) -> String {
    format!("conn:{id}:mfa-session")
}

/// Every vault id prefix that belongs to a connection (its secrets and
/// its cached role credentials).
pub fn secret_prefixes(id: &str) -> Vec<String> {
    vec![format!("conn:{id}:"), format!("cache:aws:{id}:")]
}

/// Connection ids are `[a-z0-9-]`, 1-64 characters (like cluster ids).
pub fn valid_id(id: &str) -> bool {
    crate::request::valid_cluster_id(id)
}

/// Reads the connections; a missing file is empty.
pub fn load(path: &Path) -> std::io::Result<Vec<CloudConnection>> {
    match std::fs::metadata(path) {
        Ok(meta) if meta.len() > MAX_FILE => {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "the connections file is too large",
            ))
        }
        Ok(_) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(e),
    }
    let text = std::fs::read_to_string(path)?;
    if text.trim().is_empty() {
        return Ok(Vec::new());
    }
    let file: File = serde_json::from_str(&text).map_err(|e| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("the connections file is not valid ({e})"),
        )
    })?;
    Ok(file.connections)
}

/// One connection by id.
pub fn find(path: &Path, id: &str) -> std::io::Result<Option<CloudConnection>> {
    Ok(load(path)?.into_iter().find(|c| c.id == id))
}

/// Read-modify-write under the lock. `change` returns a value; nothing is
/// written when it fails.
pub fn update<T, E: From<std::io::Error>>(
    path: &Path,
    change: impl FnOnce(&mut Vec<CloudConnection>) -> Result<T, E>,
) -> Result<T, E> {
    let dir = path.parent().unwrap_or(Path::new("."));
    crate::paths::ensure_private_dir(dir)?;
    let _lock = fsutil::lock_file(&dir.join(LOCK_NAME), LOCK_TIMEOUT)?;
    let mut connections = load(path)?;
    let result = change(&mut connections)?;
    let file = File {
        version: 1,
        connections,
    };
    let mut text = serde_json::to_string_pretty(&file).map_err(std::io::Error::other)?;
    text.push('\n');
    fsutil::write_atomic(path, text.as_bytes(), 0o600)?;
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn connection(id: &str) -> CloudConnection {
        CloudConnection {
            id: id.into(),
            provider: "aws".into(),
            kind: ConnectionKind::Sso,
            label: "Acme".into(),
            identity: None,
            sso: Some(SsoSettings {
                start_url: "https://acme.awsapps.com/start".into(),
                region: "eu-west-1".into(),
            }),
            profile: None,
            region: None,
            regions: vec![],
            targets: vec![SsoTarget {
                account_id: "123456789012".into(),
                account_name: Some("acme-prod".into()),
                role_name: "ReadOnly".into(),
            }],
            status: ConnectionStatus::SignedOut,
            expires_at: None,
            message: None,
            created_at: 1,
        }
    }

    #[test]
    fn round_trip_with_camel_case_and_private_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("jp").join(FILE_NAME);
        assert!(load(&path).unwrap().is_empty());
        update::<_, std::io::Error>(&path, |list| {
            list.push(connection("abc"));
            Ok(())
        })
        .unwrap();
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(text.contains("\"startUrl\": \"https://acme.awsapps.com/start\""));
        assert!(text.contains("\"accountId\": \"123456789012\""));
        assert!(text.contains("\"status\": \"signedOut\""));
        assert_eq!(load(&path).unwrap(), vec![connection("abc")]);
        assert_eq!(
            find(&path, "abc").unwrap().unwrap().home_region(),
            "eu-west-1"
        );
        assert!(find(&path, "nope").unwrap().is_none());

        // A failing change writes nothing.
        let err = update::<(), std::io::Error>(&path, |list| {
            list.clear();
            Err(std::io::Error::other("no"))
        });
        assert!(err.is_err());
        assert_eq!(load(&path).unwrap().len(), 1);

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
        }
    }
}

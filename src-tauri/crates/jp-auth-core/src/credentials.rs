//! What the vault stores per cluster, and the ids it stores it under:
//! - `cluster:<id>:static` → [`StaticCredential`] (token and/or client
//!   certificate + key, as PEM);
//! - `cluster:<id>:env` → [`EnvSecrets`] (secret environment variables of
//!   a wrapped exec plugin, e.g. `AWS_SECRET_ACCESS_KEY`).

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use zeroize::Zeroize;

use crate::exec_credential::{ExecCredential, ExecCredentialStatus};

pub fn static_secret_id(cluster_id: &str) -> String {
    format!("cluster:{cluster_id}:static")
}

pub fn env_secret_id(cluster_id: &str) -> String {
    format!("cluster:{cluster_id}:env")
}

/// A token and/or a client certificate with its key.
#[derive(Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StaticCredential {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub token: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_certificate_pem: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_key_pem: Option<String>,
}

impl Drop for StaticCredential {
    fn drop(&mut self) {
        self.token.zeroize();
        self.client_certificate_pem.zeroize();
        self.client_key_pem.zeroize();
    }
}

impl std::fmt::Debug for StaticCredential {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("StaticCredential")
            .field("token", &self.token.is_some())
            .field(
                "client_certificate_pem",
                &self.client_certificate_pem.is_some(),
            )
            .field("client_key_pem", &self.client_key_pem.is_some())
            .finish()
    }
}

impl StaticCredential {
    /// Neither a token nor a complete certificate + key pair.
    pub fn is_empty(&self) -> bool {
        self.token.as_deref().is_none_or(str::is_empty) && !self.has_client_certificate()
    }

    pub fn has_client_certificate(&self) -> bool {
        self.client_certificate_pem
            .as_deref()
            .is_some_and(|c| !c.is_empty())
            && self
                .client_key_pem
                .as_deref()
                .is_some_and(|k| !k.is_empty())
    }

    pub fn to_exec_credential(&self, api_version: &str) -> ExecCredential {
        let (cert, key) = if self.has_client_certificate() {
            (
                self.client_certificate_pem.clone(),
                self.client_key_pem.clone(),
            )
        } else {
            (None, None)
        };
        ExecCredential::new(
            api_version,
            ExecCredentialStatus {
                expiration_timestamp: None,
                token: self.token.clone().filter(|t| !t.is_empty()),
                client_certificate_data: cert,
                client_key_data: key,
            },
        )
    }
}

/// Secret environment variables of a wrapped exec plugin.
pub type EnvSecrets = BTreeMap<String, String>;

/// Whether an exec env variable holds a secret: names containing `SECRET`,
/// `TOKEN` or `PASSWORD` (any case), which covers `AWS_SECRET_ACCESS_KEY`
/// and `AWS_SESSION_TOKEN`.
pub fn is_secret_env_name(name: &str) -> bool {
    let upper = name.to_ascii_uppercase();
    ["SECRET", "TOKEN", "PASSWORD", "PASSWD", "API_KEY", "APIKEY"]
        .iter()
        .any(|needle| upper.contains(needle))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_and_secret_env_names() {
        assert_eq!(static_secret_id("abc"), "cluster:abc:static");
        assert_eq!(env_secret_id("abc"), "cluster:abc:env");
        for name in [
            "AWS_SECRET_ACCESS_KEY",
            "AWS_SESSION_TOKEN",
            "db_password",
            "Token",
            "OPENAI_API_KEY",
        ] {
            assert!(is_secret_env_name(name), "{name}");
        }
        for name in [
            "AWS_PROFILE",
            "AWS_REGION",
            "KUBECONFIG",
            "AWS_ACCESS_KEY_ID",
        ] {
            assert!(!is_secret_env_name(name), "{name}");
        }
    }

    #[test]
    fn static_credential_round_trip_and_exec_credential() {
        let credential = StaticCredential {
            token: Some("t0ken".into()),
            client_certificate_pem: Some("CERT".into()),
            client_key_pem: None,
        };
        let json = serde_json::to_value(&credential).unwrap();
        assert_eq!(
            json,
            serde_json::json!({"token": "t0ken", "clientCertificatePem": "CERT"})
        );
        let back: StaticCredential = serde_json::from_value(json).unwrap();
        assert_eq!(back, credential);
        assert!(!format!("{credential:?}").contains("t0ken"));

        // A certificate without its key is not sent.
        let exec = credential.to_exec_credential("client.authentication.k8s.io/v1");
        let status = exec.status.unwrap();
        assert_eq!(status.token.as_deref(), Some("t0ken"));
        assert_eq!(status.client_certificate_data, None);
        assert!(!credential.is_empty());
        assert!(StaticCredential::default().is_empty());
    }
}

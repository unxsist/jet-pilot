//! The `ExecCredential` document a kubectl credential plugin prints on
//! stdout (`client.authentication.k8s.io/v1` and `v1beta1`).

use serde::{Deserialize, Serialize};

pub const API_VERSION_V1: &str = "client.authentication.k8s.io/v1";
pub const API_VERSION_V1BETA1: &str = "client.authentication.k8s.io/v1beta1";
pub const KIND: &str = "ExecCredential";
/// The environment variable client-go passes the request in.
pub const EXEC_INFO_ENV: &str = "KUBERNETES_EXEC_INFO";

#[derive(Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ExecCredential {
    pub api_version: String,
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<ExecCredentialStatus>,
}

#[derive(Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ExecCredentialStatus {
    /// RFC 3339; absent = valid until the server rejects it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expiration_timestamp: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub token: Option<String>,
    /// PEM.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_certificate_data: Option<String>,
    /// PEM.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_key_data: Option<String>,
}

impl std::fmt::Debug for ExecCredential {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ExecCredential")
            .field("api_version", &self.api_version)
            .field("status", &self.status)
            .finish()
    }
}

impl std::fmt::Debug for ExecCredentialStatus {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let present = |v: &Option<String>| if v.is_some() { "<set>" } else { "<none>" };
        f.debug_struct("ExecCredentialStatus")
            .field("expiration_timestamp", &self.expiration_timestamp)
            .field("token", &present(&self.token))
            .field(
                "client_certificate_data",
                &present(&self.client_certificate_data),
            )
            .field("client_key_data", &present(&self.client_key_data))
            .finish()
    }
}

impl ExecCredential {
    pub fn new(api_version: impl Into<String>, status: ExecCredentialStatus) -> ExecCredential {
        ExecCredential {
            api_version: api_version.into(),
            kind: KIND.to_string(),
            status: Some(status),
        }
    }

    /// Compact JSON for stdout.
    pub fn to_json(&self) -> String {
        serde_json::to_string(self).expect("an ExecCredential always serializes")
    }
}

/// The apiVersion to answer with: the one of the `KUBERNETES_EXEC_INFO`
/// request when it is a known version, else v1.
pub fn api_version_for(exec_info: Option<&str>) -> String {
    exec_info
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(raw).ok())
        .and_then(|info| info.get("apiVersion")?.as_str().map(str::to_string))
        .filter(|v| v == API_VERSION_V1 || v == API_VERSION_V1BETA1)
        .unwrap_or_else(|| API_VERSION_V1.to_string())
}

/// [`api_version_for`] the current process environment.
pub fn api_version_from_env() -> String {
    api_version_for(std::env::var(EXEC_INFO_ENV).ok().as_deref())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn echoes_known_api_versions() {
        let info = r#"{"apiVersion":"client.authentication.k8s.io/v1beta1","kind":"ExecCredential","spec":{"interactive":false}}"#;
        assert_eq!(api_version_for(Some(info)), API_VERSION_V1BETA1);
        assert_eq!(api_version_for(None), API_VERSION_V1);
        assert_eq!(api_version_for(Some("not json")), API_VERSION_V1);
        assert_eq!(
            api_version_for(Some(r#"{"apiVersion":"client.authentication.k8s.io/v9"}"#)),
            API_VERSION_V1
        );
    }

    #[test]
    fn serializes_only_present_fields_and_debug_hides_secrets() {
        let credential = ExecCredential::new(
            API_VERSION_V1,
            ExecCredentialStatus {
                token: Some("secret-token".into()),
                ..Default::default()
            },
        );
        assert_eq!(
            credential.to_json(),
            r#"{"apiVersion":"client.authentication.k8s.io/v1","kind":"ExecCredential","status":{"token":"secret-token"}}"#
        );
        assert!(!format!("{credential:?}").contains("secret-token"));
    }
}

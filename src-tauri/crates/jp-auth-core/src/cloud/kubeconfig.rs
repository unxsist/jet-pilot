//! The parts of a provider-made kubeconfig the helper needs, without a YAML
//! library: kubeconfigs from the cloud APIs are machine-written with one
//! cluster and one user, `key: value` per line (JSON works too). The app
//! parses kubeconfigs fully (kube-rs); this keeps `jetpilot-auth` small.

use serde_json::Value;

use super::{base64_text, CloudError};

#[derive(Default, Clone, PartialEq)]
pub struct KubeconfigParts {
    pub server: Option<String>,
    /// base64 PEM.
    pub certificate_authority_data: Option<String>,
    /// base64 PEM.
    pub client_certificate_data: Option<String>,
    /// base64 PEM.
    pub client_key_data: Option<String>,
    pub token: Option<String>,
}

impl std::fmt::Debug for KubeconfigParts {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("KubeconfigParts")
            .field("server", &self.server)
            .field(
                "client_certificate_data",
                &self.client_certificate_data.is_some(),
            )
            .field("client_key_data", &self.client_key_data.is_some())
            .field("token", &self.token.is_some())
            .finish()
    }
}

const KEYS: [&str; 5] = [
    "server",
    "certificate-authority-data",
    "client-certificate-data",
    "client-key-data",
    "token",
];

fn slot<'a>(parts: &'a mut KubeconfigParts, key: &str) -> Option<&'a mut Option<String>> {
    Some(match key {
        "server" => &mut parts.server,
        "certificate-authority-data" => &mut parts.certificate_authority_data,
        "client-certificate-data" => &mut parts.client_certificate_data,
        "client-key-data" => &mut parts.client_key_data,
        "token" => &mut parts.token,
        _ => return None,
    })
}

fn from_json(value: &Value) -> KubeconfigParts {
    let mut parts = KubeconfigParts::default();
    let first = |list: &str, inner: &str| value.get(list)?.as_array()?.first()?.get(inner).cloned();
    let cluster = first("clusters", "cluster").unwrap_or(Value::Null);
    let user = first("users", "user").unwrap_or(Value::Null);
    for key in KEYS {
        let source = if matches!(key, "server" | "certificate-authority-data") {
            &cluster
        } else {
            &user
        };
        if let (Some(target), Some(found)) = (
            slot(&mut parts, key),
            source.get(key).and_then(Value::as_str),
        ) {
            *target = Some(found.trim().to_string()).filter(|v| !v.is_empty());
        }
    }
    parts
}

fn unquote(value: &str) -> &str {
    let value = value.trim();
    for quote in ['"', '\''] {
        if let Some(inner) = value
            .strip_prefix(quote)
            .and_then(|v| v.strip_suffix(quote))
        {
            return inner;
        }
    }
    value
}

/// Reads the first `server`, `certificate-authority-data`,
/// `client-certificate-data`, `client-key-data` and `token`.
pub fn parse(text: &str) -> KubeconfigParts {
    if let Ok(value) = serde_json::from_str::<Value>(text) {
        return from_json(&value);
    }
    let mut parts = KubeconfigParts::default();
    for line in text.lines() {
        let line = line.trim_start();
        let line = line.strip_prefix("- ").unwrap_or(line).trim_start();
        if line.starts_with('#') {
            continue;
        }
        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        let key = unquote(key);
        let value = unquote(value);
        if value.is_empty() {
            continue;
        }
        if let Some(target) = slot(&mut parts, key) {
            if target.is_none() {
                *target = Some(value.to_string());
            }
        }
    }
    parts
}

/// The client certificate and key (PEM) of a kubeconfig.
pub fn client_certificate(text: &str) -> Result<(String, String), CloudError> {
    let parts = parse(text);
    let (Some(cert), Some(key)) = (parts.client_certificate_data, parts.client_key_data) else {
        return Err(CloudError::Invalid(
            "The kubeconfig has no client certificate.".into(),
        ));
    };
    Ok((
        base64_text(&cert, "client certificate")?,
        base64_text(&key, "client key")?,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    const YAML: &str = r#"apiVersion: v1
kind: Config
clusters:
- cluster:
    certificate-authority-data: Q0EtREFUQQ==
    server: "https://abc.sks-ch-gva-2.exo.io:443"
  name: prod
contexts:
- context:
    cluster: prod
    user: jet-pilot
  name: prod
current-context: prod
users:
- name: jet-pilot
  user:
    client-certificate-data: LS0tLS1CRUdJTiBDRVJUSUZJQ0FURS0tLS0tCkNFUlQKLS0tLS1FTkQgQ0VSVElGSUNBVEUtLS0tLQo=
    client-key-data: 'LS0tLS1CRUdJTiBFQyBQUklWQVRFIEtFWS0tLS0tCktFWQotLS0tLUVORCBFQyBQUklWQVRFIEtFWS0tLS0tCg=='
"#;

    #[test]
    fn reads_machine_written_yaml_and_json() {
        let parts = parse(YAML);
        assert_eq!(
            parts.server.as_deref(),
            Some("https://abc.sks-ch-gva-2.exo.io:443")
        );
        assert_eq!(
            parts.certificate_authority_data.as_deref(),
            Some("Q0EtREFUQQ==")
        );
        assert!(parts.token.is_none());
        let (cert, key) = client_certificate(YAML).unwrap();
        assert!(cert.starts_with("-----BEGIN CERTIFICATE-----\nCERT"));
        assert!(key.starts_with("-----BEGIN EC PRIVATE KEY-----\nKEY"));
        assert!(!format!("{parts:?}").contains("LS0t"));

        let json = r#"{"apiVersion":"v1","clusters":[{"name":"c","cluster":{"server":"https://1.2.3.4"}}],
            "users":[{"name":"u","user":{"token":"tok-123"}}]}"#;
        let parts = parse(json);
        assert_eq!(parts.server.as_deref(), Some("https://1.2.3.4"));
        assert_eq!(parts.token.as_deref(), Some("tok-123"));
        assert!(client_certificate(json).is_err());
    }
}

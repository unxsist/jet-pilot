//! When the certificates in TLS Secrets expire, for the Health page's
//! Risks tab (`tls_certificates`).
//!
//! The Secrets are listed and parsed here, so certificates and private keys
//! never reach the web view: only names, dates and the DNS names a
//! certificate covers cross IPC.

use std::time::Duration;

use k8s_openapi::api::core::v1::Secret;
use kube::api::{Api, ListParams};
use serde::Serialize;
use x509_cert::der::oid::AssociatedOid;
use x509_cert::der::Decode;
use x509_cert::ext::pkix::name::GeneralName;
use x509_cert::ext::pkix::SubjectAltName;

use crate::helm::{bad_request, valid_namespace};
use crate::kubernetes::client::{api_error, client_with_context, SerializableKubeError};

const LIST_TIMEOUT: Duration = Duration::from_secs(45);
const TLS_SELECTOR: &str = "type=kubernetes.io/tls";
/// cert-manager names the Certificate that issued a Secret here.
const CERTIFICATE_ANNOTATION: &str = "cert-manager.io/certificate-name";
/// DNS names returned per certificate (enough to recognise it).
const MAX_NAMES: usize = 5;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TlsCertificate {
    pub name: String,
    pub namespace: String,
    /// Unix ms.
    pub not_after: Option<i64>,
    pub not_before: Option<i64>,
    /// The subject's common name.
    pub subject: Option<String>,
    pub dns_names: Vec<String>,
    /// The cert-manager Certificate that keeps it renewed.
    pub certificate: Option<String>,
    /// Why the certificate couldn't be read.
    pub error: Option<String>,
}

#[derive(Debug, PartialEq)]
struct Parsed {
    not_after: i64,
    not_before: i64,
    subject: Option<String>,
    dns_names: Vec<String>,
}

/// The common name of an RFC 4514 name ("CN=api.acme.dev,O=Acme").
fn common_name(name: &str) -> Option<String> {
    name.split(',').find_map(|part| part.trim().strip_prefix("CN=")).map(|cn| cn.replace('\\', ""))
}

/// The first certificate of PEM data (the leaf of a chain).
fn parse_certificate(pem_data: &[u8]) -> Result<Parsed, String> {
    let blocks = pem::parse_many(pem_data).map_err(|e| format!("tls.crt isn't PEM: {e}"))?;
    let block = blocks
        .iter()
        .find(|block| block.tag() == "CERTIFICATE")
        .ok_or_else(|| "tls.crt has no certificate".to_string())?;
    let certificate =
        x509_cert::Certificate::from_der(block.contents()).map_err(|e| format!("tls.crt isn't a certificate: {e}"))?;
    let tbs = &certificate.tbs_certificate;
    let ms = |duration: Duration| i64::try_from(duration.as_millis()).unwrap_or(i64::MAX);
    let dns_names = tbs
        .extensions
        .iter()
        .flatten()
        .filter(|extension| extension.extn_id == SubjectAltName::OID)
        .filter_map(|extension| SubjectAltName::from_der(extension.extn_value.as_bytes()).ok())
        .flat_map(|names| names.0)
        .filter_map(|name| match name {
            GeneralName::DnsName(dns) => Some(dns.to_string()),
            _ => None,
        })
        .take(MAX_NAMES)
        .collect();
    Ok(Parsed {
        not_after: ms(tbs.validity.not_after.to_unix_duration()),
        not_before: ms(tbs.validity.not_before.to_unix_duration()),
        subject: common_name(&tbs.subject.to_string()),
        dns_names,
    })
}

fn describe(secret: Secret) -> TlsCertificate {
    let meta = secret.metadata;
    let mut row = TlsCertificate {
        name: meta.name.unwrap_or_default(),
        namespace: meta.namespace.unwrap_or_default(),
        not_after: None,
        not_before: None,
        subject: None,
        dns_names: Vec::new(),
        certificate: meta.annotations.and_then(|mut a| a.remove(CERTIFICATE_ANNOTATION)),
        error: None,
    };
    // Only tls.crt is read; the key stays in this function's Secret.
    let pem = secret.data.and_then(|mut data| data.remove("tls.crt")).map(|bytes| bytes.0).unwrap_or_default();
    if pem.iter().all(u8::is_ascii_whitespace) {
        row.error = Some("tls.crt is empty".into());
        return row;
    }
    match parse_certificate(&pem) {
        Ok(parsed) => {
            row.not_after = Some(parsed.not_after);
            row.not_before = Some(parsed.not_before);
            row.subject = parsed.subject;
            row.dns_names = parsed.dns_names;
        }
        Err(e) => row.error = Some(e),
    }
    row
}

/// The certificate of every TLS Secret in `namespaces` (`["all"]` or empty:
/// every namespace), sorted by expiry.
#[tauri::command]
pub async fn tls_certificates(
    context: &str,
    kube_config: Option<String>,
    namespaces: Vec<String>,
) -> Result<Vec<TlsCertificate>, SerializableKubeError> {
    if let Some(bad) = namespaces.iter().find(|n| *n != "all" && !valid_namespace(n)) {
        return Err(bad_request(format!("'{bad}' is not a namespace")));
    }
    let client = client_with_context(context, kube_config.as_deref()).await?;
    let scopes: Vec<Option<&str>> = if namespaces.is_empty() || namespaces.iter().any(|n| n == "all") {
        vec![None]
    } else {
        namespaces.iter().map(|n| Some(n.as_str())).collect()
    };
    let params = ListParams::default().fields(TLS_SELECTOR);
    let work = futures::future::try_join_all(scopes.into_iter().map(|scope| {
        let api: Api<Secret> = match scope {
            Some(ns) => Api::namespaced(client.clone(), ns),
            None => Api::all(client.clone()),
        };
        let params = params.clone();
        async move { api.list(&params).await }
    }));
    let lists = tokio::time::timeout(LIST_TIMEOUT, work)
        .await
        .map_err(|_| SerializableKubeError {
            message: format!("Reading TLS secrets took longer than {} seconds", LIST_TIMEOUT.as_secs()),
            code: Some(504),
            reason: Some("Timeout".into()),
            details: None,
            auth: None,
        })?
        .map_err(|e| api_error(e, kube_config.as_deref(), context))?;
    let mut rows: Vec<TlsCertificate> = lists.into_iter().flat_map(|list| list.items).map(describe).collect();
    rows.sort_by_key(|row| (row.not_after.unwrap_or(i64::MAX), row.namespace.clone(), row.name.clone()));
    Ok(rows)
}

#[cfg(test)]
mod tests {
    use super::*;
    use k8s_openapi::ByteString;
    use std::collections::BTreeMap;

    /// Throwaway self-signed certificate (O=Acme, CN=api.acme.dev; DNS
    /// api.acme.dev and www.acme.dev, IP 10.0.0.1), valid 2026-01-01 to
    /// 2026-12-31.
    const CERT: &str = "-----BEGIN CERTIFICATE-----
MIIBzjCCAXWgAwIBAgIUTGQjTh/6MtHq3GgYLD83GqJ8w2wwCgYIKoZIzj0EAwIw
JjENMAsGA1UECgwEQWNtZTEVMBMGA1UEAwwMYXBpLmFjbWUuZGV2MB4XDTI2MDEw
MTAwMDAwMFoXDTI2MTIzMTAwMDAwMFowJjENMAsGA1UECgwEQWNtZTEVMBMGA1UE
AwwMYXBpLmFjbWUuZGV2MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEpVi0nim8
cnL/NN0291At+ywTrrOAZ99g1t0OW1Xg/uUI5ccgJgt0h7HuXV4GR0FJ9IlSYhgK
zbnL7JhQ19MzwqOBgDB+MB0GA1UdDgQWBBStfzWpXjcTu0TUpLaxYjFu+7h8lDAf
BgNVHSMEGDAWgBStfzWpXjcTu0TUpLaxYjFu+7h8lDAPBgNVHRMBAf8EBTADAQH/
MCsGA1UdEQQkMCKCDGFwaS5hY21lLmRldoIMd3d3LmFjbWUuZGV2hwQKAAABMAoG
CCqGSM49BAMCA0cAMEQCIA1955OhkIVtLNfYs/1Rr0DN8YYwMR13ItT635tmYbLe
AiAQFJ4uN1N14U+rPHgm9I+6RYoe8cSMcYH+NsObXLMDvQ==
-----END CERTIFICATE-----
";

    fn secret(data: Option<&str>, annotations: &[(&str, &str)]) -> Secret {
        let mut secret = Secret::default();
        secret.metadata.name = Some("api-tls".into());
        secret.metadata.namespace = Some("shop".into());
        secret.metadata.annotations =
            Some(annotations.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect());
        secret.data = data.map(|crt| {
            BTreeMap::from([
                ("tls.crt".to_string(), ByteString(crt.as_bytes().to_vec())),
                ("tls.key".to_string(), ByteString(b"-----BEGIN PRIVATE KEY-----".to_vec())),
            ])
        });
        secret
    }

    #[test]
    fn reads_dates_and_names_of_the_leaf() {
        let chain = format!("{CERT}{CERT}");
        let parsed = parse_certificate(chain.as_bytes()).unwrap();
        assert_eq!(parsed.not_after, 1_798_675_200_000);
        assert_eq!(parsed.not_before, 1_767_225_600_000);
        assert_eq!(parsed.subject.as_deref(), Some("api.acme.dev"));
        assert_eq!(parsed.dns_names, vec!["api.acme.dev", "www.acme.dev"]);
    }

    #[test]
    fn describes_a_secret_without_its_key() {
        let row = describe(secret(Some(CERT), &[(CERTIFICATE_ANNOTATION, "api")]));
        assert_eq!(row.name, "api-tls");
        assert_eq!(row.namespace, "shop");
        assert_eq!(row.not_after, Some(1_798_675_200_000));
        assert_eq!(row.certificate.as_deref(), Some("api"));
        assert_eq!(row.error, None);
        let json = serde_json::to_string(&row).unwrap();
        assert!(!json.contains("PRIVATE KEY"));
        assert!(!json.contains("BEGIN CERTIFICATE"));
    }

    #[test]
    fn unreadable_certificates_say_why() {
        assert_eq!(describe(secret(Some("  \n"), &[])).error.as_deref(), Some("tls.crt is empty"));
        assert_eq!(describe(secret(None, &[])).error.as_deref(), Some("tls.crt is empty"));
        let garbage = describe(secret(Some("-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n"), &[]));
        assert!(garbage.error.unwrap().starts_with("tls.crt isn't a certificate"));
        assert_eq!(garbage.not_after, None);
    }

    #[test]
    fn common_names() {
        assert_eq!(common_name("CN=api.acme.dev,O=Acme"), Some("api.acme.dev".into()));
        assert_eq!(common_name("O=Acme"), None);
    }
}

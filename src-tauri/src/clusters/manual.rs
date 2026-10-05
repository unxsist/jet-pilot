//! Adding a cluster by hand (server, CA, token or client certificate) and
//! testing such a connection before saving it. The test builds a kube
//! client in memory (no files) and asks `GET /version` within 8 s.

use std::collections::HashSet;
use std::error::Error as StdError;
use std::path::Path;
use std::time::Duration;

use base64::Engine;
use kube::config::{
    AuthInfo, Cluster, Context, KubeConfigOptions, Kubeconfig, NamedAuthInfo, NamedCluster,
    NamedContext,
};
use serde::{Deserialize, Serialize};

use jp_auth_core::credentials::{static_secret_id, StaticCredential};

use super::error::AppError;
use super::import::Known;
use super::managed_kubeconfig::{self as managed, ClusterMeta};
use super::naming;
use crate::probe::ContextRef;

const TEST_TIMEOUT: Duration = Duration::from_secs(8);

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManualClusterSpec {
    pub name: String,
    pub server: String,
    pub ca: CaSpec,
    pub auth: ManualAuth,
    #[serde(default)]
    pub namespace: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum CaSpec {
    /// The system trust store.
    System,
    Pem {
        pem: String,
    },
    File {
        path: String,
    },
    /// No certificate verification.
    Insecure,
}

#[derive(Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ManualAuth {
    Token {
        token: String,
    },
    ClientCert {
        #[serde(rename = "certPem")]
        cert_pem: String,
        #[serde(rename = "keyPem")]
        key_pem: String,
    },
    None,
}

impl std::fmt::Debug for ManualAuth {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            ManualAuth::Token { .. } => "Token(<redacted>)",
            ManualAuth::ClientCert { .. } => "ClientCert(<redacted>)",
            ManualAuth::None => "None",
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionTest {
    pub ok: bool,
    pub server_version: Option<String>,
    pub message: Option<String>,
}

/// A validated spec.
pub(crate) struct ValidSpec {
    pub name: String,
    pub server: String,
    /// base64 PEM for `certificate-authority-data`.
    pub ca_data: Option<String>,
    pub insecure: bool,
    pub credential: StaticCredential,
    pub namespace: Option<String>,
}

fn pem_blocks(text: &str, field: &str, what: &str) -> Result<Vec<pem::Pem>, AppError> {
    let blocks = pem::parse_many(text.trim())
        .map_err(|_| AppError::invalid(field, format!("The {what} is not valid PEM.")))?;
    if blocks.is_empty() {
        return Err(AppError::invalid(
            field,
            format!("Paste the {what} in PEM format (-----BEGIN ...)."),
        ));
    }
    Ok(blocks)
}

/// Certificates only; returns them re-encoded (normalized PEM text).
fn certificates(text: &str, field: &str, what: &str) -> Result<String, AppError> {
    let blocks = pem_blocks(text, field, what)?;
    if blocks.iter().any(|b| b.tag() != "CERTIFICATE") {
        return Err(AppError::invalid(
            field,
            format!("The {what} must contain certificates only."),
        ));
    }
    Ok(pem::encode_many(&blocks))
}

fn private_key(text: &str) -> Result<String, AppError> {
    let blocks = pem_blocks(text, "keyPem", "private key")?;
    match blocks.as_slice() {
        [block] if block.tag() == "ENCRYPTED PRIVATE KEY" => Err(AppError::invalid(
            "keyPem",
            "Encrypted private keys are not supported. Decrypt the key first.",
        )),
        [block] if block.tag().ends_with("PRIVATE KEY") => Ok(pem::encode(block)),
        _ => Err(AppError::invalid(
            "keyPem",
            "Paste exactly one private key.",
        )),
    }
}

fn validate_server(server: &str, insecure: bool) -> Result<String, AppError> {
    let server = server.trim().trim_end_matches('/');
    if server.is_empty() {
        return Err(AppError::invalid(
            "server",
            "Enter the address of the API server.",
        ));
    }
    let url = tauri::Url::parse(server).map_err(|_| {
        AppError::invalid(
            "server",
            "Enter a full address, such as https://203.0.113.10:6443.",
        )
    })?;
    match url.scheme() {
        "https" => {}
        "http" if insecure => {}
        "http" => return Err(AppError::invalid(
            "server",
            "Use https://. Plain http:// is only allowed with certificate verification turned off.",
        )),
        _ => {
            return Err(AppError::invalid(
                "server",
                "The address must start with https://.",
            ))
        }
    }
    if url.host_str().is_none_or(str::is_empty) {
        return Err(AppError::invalid("server", "The address has no host name."));
    }
    if !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(AppError::invalid(
            "server",
            "The address can't contain a user name, password, query or fragment.",
        ));
    }
    Ok(server.to_string())
}

fn validate_namespace(namespace: Option<&str>) -> Result<Option<String>, AppError> {
    let Some(namespace) = namespace.map(str::trim).filter(|n| !n.is_empty()) else {
        return Ok(None);
    };
    let valid = namespace.len() <= 63
        && namespace
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        && !namespace.starts_with('-')
        && !namespace.ends_with('-');
    if valid {
        Ok(Some(namespace.to_string()))
    } else {
        Err(AppError::invalid(
            "namespace",
            "A namespace has lowercase letters, digits and dashes only (at most 63).",
        ))
    }
}

/// Validates `spec`. With `taken`, the name is required and must be unused.
pub(crate) fn validate(
    spec: &ManualClusterSpec,
    taken: Option<&HashSet<String>>,
) -> Result<ValidSpec, AppError> {
    let name = match taken {
        Some(taken) => {
            let name = naming::validate_context_name(&spec.name, "name")?;
            if taken.contains(&name) {
                return Err(AppError::invalid(
                    "name",
                    format!("Another context is already called \"{name}\"."),
                ));
            }
            name
        }
        None => spec.name.trim().to_string(),
    };
    let insecure = matches!(spec.ca, CaSpec::Insecure);
    let server = validate_server(&spec.server, insecure)?;
    let b64 = |text: String| base64::engine::general_purpose::STANDARD.encode(text);
    let ca_data = match &spec.ca {
        CaSpec::System | CaSpec::Insecure => None,
        CaSpec::Pem { pem } => Some(b64(certificates(pem, "ca", "CA certificate")?)),
        CaSpec::File { path } => {
            let bytes = managed::read_small_file(path.trim()).map_err(|e| {
                AppError::invalid("ca", format!("{} can't be read: {e}", path.trim()))
            })?;
            let text = String::from_utf8(bytes)
                .map_err(|_| AppError::invalid("ca", "The CA file is not a PEM certificate."))?;
            Some(b64(certificates(&text, "ca", "CA file")?))
        }
    };
    let credential = match &spec.auth {
        ManualAuth::Token { token } => {
            let token = token.trim();
            if token.is_empty() {
                return Err(AppError::invalid("token", "Enter the token."));
            }
            if token.chars().any(char::is_whitespace) {
                return Err(AppError::invalid(
                    "token",
                    "The token can't contain spaces or line breaks.",
                ));
            }
            StaticCredential {
                token: Some(token.to_string()),
                client_certificate_pem: None,
                client_key_pem: None,
            }
        }
        ManualAuth::ClientCert { cert_pem, key_pem } => StaticCredential {
            token: None,
            client_certificate_pem: Some(certificates(cert_pem, "certPem", "client certificate")?),
            client_key_pem: Some(private_key(key_pem)?),
        },
        ManualAuth::None => StaticCredential::default(),
    };
    Ok(ValidSpec {
        name,
        server,
        ca_data,
        insecure,
        credential,
        namespace: validate_namespace(spec.namespace.as_deref())?,
    })
}

fn cluster_of(valid: &ValidSpec) -> Cluster {
    Cluster {
        server: Some(valid.server.clone()),
        certificate_authority_data: valid.ca_data.clone(),
        insecure_skip_tls_verify: valid.insecure.then_some(true),
        ..Cluster::default()
    }
}

/// Adds a validated cluster to the managed kubeconfig at `path`.
pub(crate) fn add(valid: ValidSpec, helper: &Path, path: &Path) -> Result<ContextRef, AppError> {
    let id = naming::new_cluster_id();
    let internal = naming::internal_name(&id);
    let identity = if let Some(token) = &valid.credential.token {
        managed::token_identity(token)
    } else if let Some(cert) = &valid.credential.client_certificate_pem {
        managed::cert_identity(cert)
    } else {
        "anonymous".to_string()
    };
    let mut context = Context {
        cluster: internal.clone(),
        user: Some(internal.clone()),
        namespace: valid.namespace.clone(),
        ..Context::default()
    };
    managed::set_meta(
        &mut context,
        &ClusterMeta {
            id: id.clone(),
            origin: "manual".to_string(),
            added_at: managed::now_ms(),
            source_path: None,
            fingerprint: Some(managed::fingerprint(Some(&valid.server), &identity)),
        },
    );
    let has_credential = !valid.credential.is_empty();
    let user = AuthInfo {
        exec: has_credential.then(|| managed::static_exec(&id, helper)),
        ..AuthInfo::default()
    };
    let secret_id = static_secret_id(&id);
    if has_credential {
        let value = serde_json::to_value(&valid.credential).expect("credentials serialize");
        crate::secrets::put_many(vec![(secret_id.clone(), value)])?;
    }
    let name = valid.name.clone();
    let result = managed::update(path, |doc| {
        if managed::context_names(doc).any(|n| n == name) {
            return Err(AppError::invalid(
                "name",
                format!("Another context is already called \"{name}\"."),
            ));
        }
        doc.clusters.push(NamedCluster {
            name: internal.clone(),
            cluster: Some(cluster_of(&valid)),
            other: managed::no_other(),
        });
        doc.auth_infos.push(NamedAuthInfo {
            name: internal.clone(),
            auth_info: Some(user),
            other: managed::no_other(),
        });
        doc.contexts.push(NamedContext {
            name: name.clone(),
            context: Some(context),
            other: managed::no_other(),
        });
        if doc.current_context.as_deref().is_none_or(str::is_empty) {
            doc.current_context = Some(name.clone());
        }
        Ok(())
    });
    if let Err(e) = result {
        if has_credential {
            let _ = crate::secrets::remove_many(&[secret_id]);
        }
        return Err(e);
    }
    Ok(ContextRef {
        kube_config: path.to_string_lossy().into_owned(),
        context: name,
    })
}

/// Validates and adds a cluster entered by hand.
#[tauri::command]
pub async fn cluster_add_manual(spec: ManualClusterSpec) -> Result<ContextRef, AppError> {
    super::blocking(move || {
        let known = Known::load();
        let valid = validate(&spec, Some(&known.names))?;
        add(
            valid,
            &jp_auth_core::paths::helper_path(),
            &managed::managed_path(),
        )
    })
    .await
}

/* ------------------------------------------------------ test connection */

/// Checks a spec without saving anything: `GET /version` within 8 s.
/// Validation problems are errors; connection problems are `ok: false`.
#[tauri::command]
pub async fn cluster_test_connection(spec: ManualClusterSpec) -> Result<ConnectionTest, AppError> {
    let valid = super::blocking(move || validate(&spec, None)).await?;
    Ok(test_connection(&valid).await)
}

/// An in-memory kubeconfig with the credentials inline (never written).
fn in_memory_kubeconfig(valid: &ValidSpec) -> Kubeconfig {
    let b64 = |text: &str| base64::engine::general_purpose::STANDARD.encode(text);
    let credential = &valid.credential;
    let user = AuthInfo {
        token: credential.token.clone().map(Into::into),
        client_certificate_data: credential.client_certificate_pem.as_deref().map(b64),
        client_key_data: credential.client_key_pem.as_deref().map(|k| b64(k).into()),
        ..AuthInfo::default()
    };
    Kubeconfig {
        clusters: vec![NamedCluster {
            name: "test".into(),
            cluster: Some(cluster_of(valid)),
            other: managed::no_other(),
        }],
        auth_infos: vec![NamedAuthInfo {
            name: "test".into(),
            auth_info: Some(user),
            other: managed::no_other(),
        }],
        contexts: vec![NamedContext {
            name: "test".into(),
            context: Some(Context {
                cluster: "test".into(),
                user: Some("test".into()),
                ..Context::default()
            }),
            other: managed::no_other(),
        }],
        current_context: Some("test".into()),
        ..managed::new_doc()
    }
}

pub(crate) async fn test_connection(valid: &ValidSpec) -> ConnectionTest {
    let kubeconfig = in_memory_kubeconfig(valid);
    let attempt = async {
        let options = KubeConfigOptions {
            context: Some("test".into()),
            cluster: None,
            user: None,
        };
        let mut config = kube::Config::from_custom_kubeconfig(kubeconfig, &options)
            .await
            .map_err(|e| {
                format!(
                    "The connection settings are not valid: {}",
                    crate::kubeconfig_discovery::read_error_message(&e)
                )
            })?;
        config.connect_timeout = Some(TEST_TIMEOUT);
        config.read_timeout = Some(TEST_TIMEOUT);
        config.write_timeout = Some(TEST_TIMEOUT);
        let client = kube::Client::try_from(config).map_err(|e| error_message(&e))?;
        client
            .apiserver_version()
            .await
            .map_err(|e| error_message(&e))
    };
    match tokio::time::timeout(TEST_TIMEOUT, attempt).await {
        Ok(Ok(info)) => ConnectionTest {
            ok: true,
            server_version: Some(info.git_version).filter(|v| !v.is_empty()),
            message: None,
        },
        Ok(Err(message)) => ConnectionTest {
            ok: false,
            server_version: None,
            message: Some(message),
        },
        Err(_) => ConnectionTest {
            ok: false,
            server_version: None,
            message: Some(format!(
                "The server did not answer within {} seconds.",
                TEST_TIMEOUT.as_secs()
            )),
        },
    }
}

/// A short message for a failed request (never formats auth errors, which
/// could include credentials).
fn error_message(error: &kube::Error) -> String {
    match error {
        kube::Error::Api(status) => match status.code {
            401 => "The cluster rejected the credentials (401 Unauthorized).".to_string(),
            403 => "The credentials are not allowed to read the server version (403 Forbidden)."
                .to_string(),
            code => format!("The server answered HTTP {code}."),
        },
        kube::Error::Auth(_) => "The credentials could not be used.".to_string(),
        kube::Error::HyperError(e) => transport_message(e),
        kube::Error::Service(e) => transport_message(e.as_ref()),
        kube::Error::SerdeError(_) => {
            "The server did not answer like a Kubernetes API server.".to_string()
        }
        other => one_line(&other.to_string()),
    }
}

fn one_line(text: &str) -> String {
    let line = text
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .unwrap_or("The connection failed.");
    let line: String = line.chars().take(200).collect();
    jp_auth_core::redact(&line)
}

/// TLS, DNS, refused and timeout failures from the error chain.
fn transport_message(error: &(dyn StdError + 'static)) -> String {
    let mut chain: Vec<&(dyn StdError + 'static)> = Vec::new();
    let mut current = Some(error);
    while let Some(e) = current {
        chain.push(e);
        current = e.source();
    }
    for e in &chain {
        if let Some(io) = e.downcast_ref::<std::io::Error>() {
            match io.kind() {
                std::io::ErrorKind::ConnectionRefused => {
                    return "The connection was refused.".to_string()
                }
                std::io::ErrorKind::TimedOut => return "The connection timed out.".to_string(),
                std::io::ErrorKind::HostUnreachable | std::io::ErrorKind::NetworkUnreachable => {
                    return "The server is unreachable.".to_string()
                }
                _ => {}
            }
        }
    }
    let all = chain
        .iter()
        .map(|e| e.to_string())
        .collect::<Vec<_>>()
        .join(" | ");
    let lower = all.to_ascii_lowercase();
    if lower.contains("dns error")
        || lower.contains("failed to lookup address")
        || lower.contains("no such host")
    {
        "The host name could not be found (DNS).".to_string()
    } else if lower.contains("unknownissuer")
        || lower.contains("unknown issuer")
        || lower.contains("self signed")
        || lower.contains("self-signed")
    {
        "TLS: the server's certificate is not trusted. Add its CA certificate, or turn off verification.".to_string()
    } else if lower.contains("notvalidforname") || lower.contains("not valid for name") {
        "TLS: the server's certificate is not valid for this address.".to_string()
    } else if lower.contains("expired") {
        "TLS: the server's certificate has expired.".to_string()
    } else if ["certificate", "tls", "handshake", "corrupt message"]
        .iter()
        .any(|n| lower.contains(n))
    {
        one_line(&format!(
            "TLS: {}",
            chain.last().map(|e| e.to_string()).unwrap_or_default()
        ))
    } else {
        one_line(
            &chain
                .last()
                .map(|e| e.to_string())
                .unwrap_or_else(|| all.clone()),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::secrets::test_support::memory_env;
    use crate::util::lock;
    use serde_json::json;

    // Validation only looks at the PEM structure.
    fn cert_pem() -> String {
        pem::encode(&pem::Pem::new(
            "CERTIFICATE",
            b"not a real certificate".to_vec(),
        ))
    }

    fn key_pem() -> String {
        pem::encode(&pem::Pem::new("PRIVATE KEY", b"KEY-SECRET-BYTES".to_vec()))
    }

    fn spec(auth: ManualAuth, ca: CaSpec, server: &str) -> ManualClusterSpec {
        ManualClusterSpec {
            name: "lab".into(),
            server: server.into(),
            ca,
            auth,
            namespace: None,
        }
    }

    fn token(t: &str) -> ManualAuth {
        ManualAuth::Token { token: t.into() }
    }

    fn field(result: Result<ValidSpec, AppError>) -> Option<String> {
        result.err().and_then(|e| e.field)
    }

    #[test]
    fn validation_reports_the_offending_field() {
        let taken: HashSet<String> = ["prod".to_string()].into();
        let ok = spec(token("abc"), CaSpec::System, "https://10.0.0.1:6443/");
        let valid = validate(&ok, Some(&taken)).unwrap();
        assert_eq!(valid.server, "https://10.0.0.1:6443");
        assert_eq!(valid.credential.token.as_deref(), Some("abc"));

        let mut named = ok.clone();
        named.name = "prod".into();
        assert_eq!(field(validate(&named, Some(&taken))), Some("name".into()));
        named.name = "  ".into();
        assert_eq!(field(validate(&named, Some(&taken))), Some("name".into()));
        // Testing a connection doesn't need a name.
        assert!(validate(&named, None).is_ok());

        for server in [
            "",
            "10.0.0.1:6443",
            "ftp://x",
            "https://",
            "https://u:p@host",
            "https://h?x=1",
        ] {
            let s = spec(token("abc"), CaSpec::System, server);
            assert_eq!(field(validate(&s, None)), Some("server".into()), "{server}");
        }
        assert_eq!(
            field(validate(
                &spec(token("abc"), CaSpec::System, "http://10.0.0.1"),
                None
            )),
            Some("server".into())
        );
        assert!(validate(
            &spec(token("abc"), CaSpec::Insecure, "http://10.0.0.1"),
            None
        )
        .is_ok());

        assert_eq!(
            field(validate(
                &spec(token(" "), CaSpec::System, "https://h"),
                None
            )),
            Some("token".into())
        );
        assert_eq!(
            field(validate(
                &spec(token("a b"), CaSpec::System, "https://h"),
                None
            )),
            Some("token".into())
        );

        let pem_ca = |pem: &str| CaSpec::Pem { pem: pem.into() };
        assert_eq!(
            field(validate(
                &spec(token("t"), pem_ca("nope"), "https://h"),
                None
            )),
            Some("ca".into())
        );
        assert_eq!(
            field(validate(
                &spec(token("t"), pem_ca(&key_pem()), "https://h"),
                None
            )),
            Some("ca".into())
        );
        let valid = validate(&spec(token("t"), pem_ca(&cert_pem()), "https://h"), None).unwrap();
        assert!(valid.ca_data.is_some());
        assert_eq!(
            field(validate(
                &spec(
                    token("t"),
                    CaSpec::File {
                        path: "/no/such/ca.crt".into()
                    },
                    "https://h"
                ),
                None
            )),
            Some("ca".into())
        );

        let cert = |c: &str, k: &str| ManualAuth::ClientCert {
            cert_pem: c.into(),
            key_pem: k.into(),
        };
        assert_eq!(
            field(validate(
                &spec(cert("x", &key_pem()), CaSpec::System, "https://h"),
                None
            )),
            Some("certPem".into())
        );
        assert_eq!(
            field(validate(
                &spec(cert(&cert_pem(), &cert_pem()), CaSpec::System, "https://h"),
                None
            )),
            Some("keyPem".into())
        );
        let encrypted =
            "-----BEGIN ENCRYPTED PRIVATE KEY-----\nAAAA\n-----END ENCRYPTED PRIVATE KEY-----\n";
        assert_eq!(
            field(validate(
                &spec(cert(&cert_pem(), encrypted), CaSpec::System, "https://h"),
                None
            )),
            Some("keyPem".into())
        );
        let valid = validate(
            &spec(cert(&cert_pem(), &key_pem()), CaSpec::System, "https://h"),
            None,
        )
        .unwrap();
        assert!(valid.credential.has_client_certificate());

        let mut ns = ok.clone();
        ns.namespace = Some("Bad_NS".into());
        assert_eq!(field(validate(&ns, None)), Some("namespace".into()));
        ns.namespace = Some(" team-a ".into());
        assert_eq!(
            validate(&ns, None).unwrap().namespace.as_deref(),
            Some("team-a")
        );

        // Specs deserialize from the frontend's camelCase shapes.
        let spec: ManualClusterSpec = serde_json::from_value(json!({
            "name": "x", "server": "https://h",
            "ca": {"kind": "pem", "pem": cert_pem()},
            "auth": {"kind": "clientCert", "certPem": cert_pem(), "keyPem": key_pem()},
            "namespace": null
        }))
        .unwrap();
        assert!(matches!(spec.auth, ManualAuth::ClientCert { .. }));
        assert!(!format!("{:?}", spec.auth).contains("PRIVATE"));
        let spec: ManualClusterSpec = serde_json::from_value(json!({
            "name": "x", "server": "https://h", "ca": {"kind": "insecure"}, "auth": {"kind": "none"}
        }))
        .unwrap();
        assert!(matches!(spec.ca, CaSpec::Insecure));
    }

    #[test]
    fn add_writes_a_helper_user_and_stores_the_token() {
        let _guard = lock(&crate::secrets::TEST_VAULT_LOCK);
        let dir = tempfile::tempdir().unwrap();
        let (env, _) = memory_env(dir.path(), true);
        crate::secrets::use_test_env(env);
        let path = dir.path().join("config");
        let helper = Path::new("/home/me/.kube/jet-pilot/bin/jetpilot-auth");

        let mut s = spec(
            token("sekret-token"),
            CaSpec::Insecure,
            "https://10.0.0.1:6443",
        );
        s.namespace = Some("apps".into());
        let added = add(validate(&s, Some(&HashSet::new())).unwrap(), helper, &path).unwrap();
        assert_eq!(added.context, "lab");

        let text = std::fs::read_to_string(&path).unwrap();
        assert!(!text.contains("sekret-token"));
        let doc = managed::parse(&text).unwrap();
        let listed = managed::list(&doc);
        assert_eq!(listed[0].origin, "manual");
        assert_eq!(listed[0].server.as_deref(), Some("https://10.0.0.1:6443"));
        let id = listed[0].cluster_id.clone();
        assert_eq!(
            crate::secrets::get(&static_secret_id(&id)).unwrap(),
            Some(json!({"token": "sekret-token"}))
        );
        let cluster = doc.clusters[0].cluster.as_ref().unwrap();
        assert_eq!(cluster.insecure_skip_tls_verify, Some(true));
        assert_eq!(
            doc.contexts[0]
                .context
                .as_ref()
                .unwrap()
                .namespace
                .as_deref(),
            Some("apps")
        );
        assert_eq!(doc.current_context.as_deref(), Some("lab"));

        // The same name again (e.g. added meanwhile) fails and leaves no secret.
        let again = validate(&s, Some(&HashSet::new())).unwrap();
        let err = add(again, helper, &path).unwrap_err();
        assert_eq!(err.field.as_deref(), Some("name"));
        let vault =
            jp_auth_core::vault::Vault::open_with(&crate::secrets::test_env(), None).unwrap();
        assert_eq!(vault.ids().len(), 1);

        // No credentials: a user without exec, nothing stored.
        let mut anonymous = spec(ManualAuth::None, CaSpec::System, "https://open.example");
        anonymous.name = "open".into();
        add(
            validate(&anonymous, Some(&HashSet::new())).unwrap(),
            helper,
            &path,
        )
        .unwrap();
        let doc = managed::read(&path).unwrap();
        let user = doc
            .auth_infos
            .iter()
            .find(|u| u.name != doc.auth_infos[0].name)
            .unwrap();
        assert!(user.auth_info.as_ref().unwrap().exec.is_none());
    }

    #[tokio::test]
    async fn test_connection_maps_failures_to_short_messages() {
        // Nothing listens on port 9 of localhost (discard): refused quickly.
        let valid = validate(
            &spec(token("t"), CaSpec::System, "https://127.0.0.1:9"),
            None,
        )
        .unwrap();
        let result = test_connection(&valid).await;
        assert!(!result.ok);
        assert!(
            result.message.as_deref().unwrap().contains("refused"),
            "{result:?}"
        );

        // A plain-text HTTP server answering 401 to /version.
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            use tokio::io::{AsyncReadExt, AsyncWriteExt};
            while let Ok((mut socket, _)) = listener.accept().await {
                let mut buf = [0u8; 2048];
                let _ = socket.read(&mut buf).await;
                let body = r#"{"kind":"Status","apiVersion":"v1","status":"Failure","message":"Unauthorized","reason":"Unauthorized","code":401}"#;
                let response = format!(
                    "HTTP/1.1 401 Unauthorized\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = socket.write_all(response.as_bytes()).await;
            }
        });
        let valid = validate(
            &spec(
                token("t"),
                CaSpec::Insecure,
                &format!("http://127.0.0.1:{port}"),
            ),
            None,
        )
        .unwrap();
        let result = test_connection(&valid).await;
        assert_eq!(
            result,
            ConnectionTest {
                ok: false,
                server_version: None,
                message: Some("The cluster rejected the credentials (401 Unauthorized).".into()),
            }
        );
    }
}

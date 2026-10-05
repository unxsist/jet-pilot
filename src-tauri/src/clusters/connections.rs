//! Cloud connections (`~/.kube/jet-pilot/connections.json`, see
//! `jp_auth_core::connections`): AWS IAM Identity Center, `~/.aws`
//! profiles and access keys. Secrets go to the vault; listing computes
//! each connection's sign-in state without network calls or prompts.

use std::collections::BTreeSet;

use jp_auth_core::aws::creds::{self, StoredKeys};
use jp_auth_core::aws::AwsContext;
use jp_auth_core::connections::{
    self as store, keys_secret_id, CloudConnection, ConnectionKind, ConnectionStatus, SsoSettings,
    SsoTarget,
};
use jp_auth_core::request::{valid_account_id, valid_profile_name, valid_region, valid_role_name};
use serde::Deserialize;
use tracing::info;

use super::error::AppError;
use super::managed_kubeconfig as managed;
use super::providers::aws;

#[derive(Clone, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ConnectionSpec {
    Sso {
        #[serde(default)]
        label: Option<String>,
        start_url: String,
        region: String,
    },
    Profile {
        #[serde(default)]
        label: Option<String>,
        profile: String,
    },
    Keys {
        #[serde(default)]
        label: Option<String>,
        access_key_id: String,
        secret_access_key: String,
        #[serde(default)]
        session_token: Option<String>,
        region: String,
    },
}

impl std::fmt::Debug for ConnectionSpec {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ConnectionSpec::Sso {
                start_url, region, ..
            } => write!(f, "Sso({start_url}, {region})"),
            ConnectionSpec::Profile { profile, .. } => write!(f, "Profile({profile})"),
            ConnectionSpec::Keys { region, .. } => write!(f, "Keys(<redacted>, {region})"),
        }
    }
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionPatch {
    #[serde(default)]
    pub label: Option<String>,
    #[serde(default)]
    pub regions: Option<Vec<String>>,
    #[serde(default)]
    pub targets: Option<Vec<SsoTarget>>,
}

fn vault_error(e: jp_auth_core::vault::VaultError) -> AppError {
    AppError::from(jp_auth_core::aws::AwsError::Vault(e))
}

fn load(ctx: &AwsContext) -> Result<Vec<CloudConnection>, AppError> {
    store::load(&ctx.connections_file).map_err(|e| AppError::io("The connections can't be read", e))
}

/// The connection with its sign-in state computed.
pub(crate) fn with_status(ctx: &AwsContext, mut connection: CloudConnection) -> CloudConnection {
    let (status, expires_at, message) = aws::credential_state(ctx, &connection);
    // A failed discovery is kept until the next one succeeds, unless the
    // connection is signed out meanwhile.
    if status == ConnectionStatus::SignedIn && connection.status == ConnectionStatus::Error {
        connection.expires_at = expires_at;
        return connection;
    }
    connection.status = status;
    connection.expires_at = expires_at;
    connection.message = message;
    connection
}

/// One connection (with status).
pub(crate) fn get(id: &str) -> Result<CloudConnection, AppError> {
    let ctx = aws::context();
    let connection = load(&ctx)?
        .into_iter()
        .find(|c| c.id == id)
        .ok_or_else(|| AppError::not_found("This connection no longer exists."))?;
    Ok(with_status(&ctx, connection))
}

/// Records the outcome of using a connection: `Ok(identity)` clears a
/// previous error (and stores the identity when given), `Err(message)`
/// marks it as failing.
pub(crate) fn record_status(
    id: &str,
    outcome: Result<Option<String>, String>,
) -> Result<(), AppError> {
    let ctx = aws::context();
    store::update::<_, AppError>(&ctx.connections_file, |list| {
        if let Some(connection) = list.iter_mut().find(|c| c.id == id) {
            match outcome {
                Ok(identity) => {
                    if connection.status == ConnectionStatus::Error {
                        connection.status = ConnectionStatus::SignedIn;
                    }
                    connection.message = None;
                    if identity.is_some() {
                        connection.identity = identity;
                    }
                }
                Err(message) => {
                    connection.status = ConnectionStatus::Error;
                    connection.message = Some(jp_auth_core::redact(&message));
                }
            }
        }
        Ok(())
    })
}

fn clean_label(label: Option<String>) -> Option<String> {
    label
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
        .map(|l| l.chars().take(100).collect())
}

/// A start URL: https with a host, no credentials, query or fragment.
fn validate_start_url(start_url: &str) -> Result<String, AppError> {
    let start_url = start_url.trim();
    let url = tauri::Url::parse(start_url).map_err(|_| {
        AppError::invalid(
            "startUrl",
            "Enter the AWS access portal URL, such as https://my-company.awsapps.com/start.",
        )
    })?;
    if url.scheme() != "https" || url.host_str().is_none_or(str::is_empty) {
        return Err(AppError::invalid(
            "startUrl",
            "The access portal URL must start with https://.",
        ));
    }
    if !url.username().is_empty() || url.password().is_some() || url.fragment().is_some() {
        return Err(AppError::invalid(
            "startUrl",
            "The access portal URL can't contain a user name, password or fragment.",
        ));
    }
    Ok(start_url.to_string())
}

fn validate_region(region: &str, field: &str) -> Result<String, AppError> {
    let region = region.trim();
    if valid_region(region) {
        Ok(region.to_string())
    } else {
        Err(AppError::invalid(
            field,
            format!("\"{region}\" is not an AWS region."),
        ))
    }
}

fn new_connection(kind: ConnectionKind, label: String) -> CloudConnection {
    CloudConnection {
        id: jp_auth_core::fsutil::random_id(),
        provider: "aws".to_string(),
        kind,
        label,
        identity: None,
        sso: None,
        profile: None,
        region: None,
        regions: Vec::new(),
        targets: Vec::new(),
        status: ConnectionStatus::SignedOut,
        expires_at: None,
        message: None,
        created_at: managed::now_ms(),
    }
}

/// Cloud connections, with their sign-in state.
#[tauri::command]
pub async fn connections_list() -> Result<Vec<CloudConnection>, AppError> {
    super::blocking(|| {
        let ctx = aws::context();
        Ok(load(&ctx)?
            .into_iter()
            .map(|c| with_status(&ctx, c))
            .collect())
    })
    .await
}

/// Adds a connection. Access keys are checked with `GetCallerIdentity`
/// and stored in the vault; a profile must exist.
#[tauri::command]
pub async fn connection_create(spec: ConnectionSpec) -> Result<CloudConnection, AppError> {
    let ctx = aws::context();
    let existing = {
        let ctx = ctx.clone();
        super::blocking(move || load(&ctx)).await?
    };
    let (connection, keys) = match spec {
        ConnectionSpec::Sso {
            label,
            start_url,
            region,
        } => {
            let start_url = validate_start_url(&start_url)?;
            let region = validate_region(&region, "region")?;
            if existing.iter().any(|c| {
                c.sso.as_ref().is_some_and(|s| {
                    jp_auth_core::aws::config::same_start_url(&s.start_url, &start_url)
                })
            }) {
                return Err(AppError::invalid(
                    "startUrl",
                    "This access portal is already connected.",
                ));
            }
            let default_label = tauri::Url::parse(&start_url)
                .ok()
                .and_then(|u| {
                    u.host_str()
                        .map(|h| h.split('.').next().unwrap_or(h).to_string())
                })
                .unwrap_or_else(|| start_url.clone());
            let mut connection = new_connection(
                ConnectionKind::Sso,
                clean_label(label).unwrap_or(default_label),
            );
            connection.sso = Some(SsoSettings { start_url, region });
            (connection, None)
        }
        ConnectionSpec::Profile { label, profile } => {
            let profile = profile.trim().to_string();
            if !valid_profile_name(&profile) {
                return Err(AppError::invalid(
                    "profile",
                    "Choose a profile from ~/.aws/config.",
                ));
            }
            let files = {
                let ctx = ctx.clone();
                super::blocking(move || Ok(jp_auth_core::aws::config::AwsFiles::load(&ctx))).await?
            };
            if !files.has_profile(&profile) {
                return Err(AppError::invalid(
                    "profile",
                    format!("There is no profile \"{profile}\" in ~/.aws."),
                ));
            }
            if existing.iter().any(|c| {
                c.kind == ConnectionKind::Profile && c.profile.as_deref() == Some(&profile)
            }) {
                return Err(AppError::invalid(
                    "profile",
                    "This profile is already connected.",
                ));
            }
            let mut connection = new_connection(
                ConnectionKind::Profile,
                clean_label(label).unwrap_or_else(|| profile.clone()),
            );
            connection.region = files.region(&profile);
            connection.profile = Some(profile);
            (connection, None)
        }
        ConnectionSpec::Keys {
            label,
            access_key_id,
            secret_access_key,
            session_token,
            region,
        } => {
            let access_key_id = access_key_id.trim().to_string();
            if access_key_id.len() < 16
                || access_key_id.len() > 128
                || !access_key_id.bytes().all(|b| b.is_ascii_alphanumeric())
            {
                return Err(AppError::invalid(
                    "accessKeyId",
                    "Enter an access key ID, such as AKIAIOSFODNN7EXAMPLE.",
                ));
            }
            let secret_access_key = secret_access_key.trim().to_string();
            if secret_access_key.is_empty() {
                return Err(AppError::invalid(
                    "secretAccessKey",
                    "Enter the secret access key.",
                ));
            }
            let region = validate_region(&region, "region")?;
            let keys = StoredKeys {
                access_key_id,
                secret_access_key,
                session_token: session_token
                    .map(|t| t.trim().to_string())
                    .filter(|t| !t.is_empty()),
            };
            let credentials = creds::AwsCredentials {
                access_key_id: keys.access_key_id.clone(),
                secret_access_key: keys.secret_access_key.clone(),
                session_token: keys.session_token.clone(),
                expires_at: None,
            };
            let (account, arn) = creds::caller_identity(&ctx, &credentials, &region)
                .await
                .map_err(|e| match e {
                    jp_auth_core::aws::AwsError::Service { message, .. } => AppError::invalid(
                        "accessKeyId",
                        format!("AWS did not accept these keys: {message}"),
                    ),
                    other => AppError::from(other),
                })?;
            let mut connection =
                new_connection(ConnectionKind::Keys, clean_label(label).unwrap_or(account));
            connection.region = Some(region);
            connection.identity = Some(arn);
            connection.status = ConnectionStatus::SignedIn;
            (connection, Some(keys))
        }
    };
    let ctx2 = ctx.clone();
    let created = super::blocking(move || {
        if let Some(keys) = keys {
            let value =
                serde_json::to_value(&keys).map_err(|e| AppError::internal(e.to_string()))?;
            ctx2.store
                .put_and_remove(vec![(keys_secret_id(&connection.id), value)], &[])
                .map_err(vault_error)?;
        }
        let saved = connection.clone();
        store::update::<_, AppError>(&ctx2.connections_file, move |list| {
            list.push(saved);
            Ok(())
        })?;
        Ok(with_status(&ctx2, connection))
    })
    .await?;
    info!("Added AWS connection {} ({:?})", created.id, created.kind);
    Ok(created)
}

/// Renames a connection, or sets its regions / account + role targets.
#[tauri::command]
pub async fn connection_update(
    id: String,
    patch: ConnectionPatch,
) -> Result<CloudConnection, AppError> {
    super::blocking(move || {
        let ctx = aws::context();
        let label = match patch.label {
            Some(label) => Some(
                clean_label(Some(label))
                    .ok_or_else(|| AppError::invalid("label", "Enter a name."))?,
            ),
            None => None,
        };
        let regions = match patch.regions {
            Some(regions) => {
                let mut set = BTreeSet::new();
                for region in regions {
                    set.insert(validate_region(&region, "regions")?);
                }
                Some(set.into_iter().collect::<Vec<_>>())
            }
            None => None,
        };
        let targets = match patch.targets {
            Some(targets) => {
                let mut out: Vec<SsoTarget> = Vec::new();
                for target in targets {
                    if !valid_account_id(&target.account_id) {
                        return Err(AppError::invalid(
                            "targets",
                            format!("\"{}\" is not an AWS account id.", target.account_id),
                        ));
                    }
                    if !valid_role_name(&target.role_name) {
                        return Err(AppError::invalid(
                            "targets",
                            format!("\"{}\" is not a role name.", target.role_name),
                        ));
                    }
                    if !out.iter().any(|t| {
                        t.account_id == target.account_id && t.role_name == target.role_name
                    }) {
                        out.push(SsoTarget {
                            account_id: target.account_id,
                            account_name: clean_label(target.account_name),
                            role_name: target.role_name,
                        });
                    }
                }
                Some(out)
            }
            None => None,
        };
        let updated = store::update::<_, AppError>(&ctx.connections_file, |list| {
            let connection = list
                .iter_mut()
                .find(|c| c.id == id)
                .ok_or_else(|| AppError::not_found("This connection no longer exists."))?;
            if let Some(label) = label {
                connection.label = label;
            }
            if let Some(regions) = regions {
                connection.regions = regions;
            }
            if let Some(targets) = targets {
                if connection.kind != ConnectionKind::Sso && !targets.is_empty() {
                    return Err(AppError::invalid(
                        "targets",
                        "Only IAM Identity Center connections have account targets.",
                    ));
                }
                connection.targets = targets;
            }
            Ok(connection.clone())
        })?;
        super::catalog::prune_connection_scope(&updated)?;
        aws::forget_entry_statuses();
        Ok(with_status(&ctx, updated))
    })
    .await
}

/// Removes a connection and forgets its secrets (SSO session copy, client
/// registration, keys, cached role credentials). `remove_clusters` also
/// removes the clusters added from it. The aws CLI's own token cache is
/// left alone.
#[tauri::command]
pub async fn connection_delete(id: String, remove_clusters: bool) -> Result<(), AppError> {
    super::blocking(move || {
        let ctx = aws::context();
        if !load(&ctx)?.iter().any(|c| c.id == id) {
            return Err(AppError::not_found("This connection no longer exists."));
        }
        let mut secret_ids = Vec::new();
        for prefix in store::secret_prefixes(&id) {
            secret_ids.extend(ctx.store.ids_with_prefix(&prefix).map_err(vault_error)?);
        }
        ctx.store
            .put_and_remove(Vec::new(), &secret_ids)
            .map_err(vault_error)?;
        if remove_clusters {
            let path = super::catalog::managed_file();
            let doc = managed::read(&path)?;
            let contexts: Vec<String> = doc
                .contexts
                .iter()
                .filter(|c| managed::cloud_meta_of(c).is_some_and(|m| m.connection_id == id))
                .map(|c| c.name.clone())
                .collect();
            super::remove(&path, &contexts, false)?;
        }
        store::update::<_, AppError>(&ctx.connections_file, |list| {
            list.retain(|c| c.id != id);
            Ok(())
        })?;
        super::catalog::forget_connection(&id)?;
        aws::forget_entry_statuses();
        info!("Removed AWS connection {}", id);
        Ok(())
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn specs_and_patches_use_the_ipc_shapes() {
        let sso: ConnectionSpec = serde_json::from_value(serde_json::json!({
            "kind": "sso", "startUrl": "https://acme.awsapps.com/start", "region": "eu-west-1"
        }))
        .unwrap();
        assert!(
            matches!(sso, ConnectionSpec::Sso { label: None, ref start_url, .. } if start_url == "https://acme.awsapps.com/start")
        );
        let keys: ConnectionSpec = serde_json::from_value(serde_json::json!({
            "kind": "keys", "label": "ci", "accessKeyId": "AKIA", "secretAccessKey": "s3cr3t", "region": "eu-west-1"
        }))
        .unwrap();
        assert!(!format!("{keys:?}").contains("s3cr3t"));
        let profile: ConnectionSpec =
            serde_json::from_value(serde_json::json!({"kind": "profile", "profile": "dev"}))
                .unwrap();
        assert!(matches!(profile, ConnectionSpec::Profile { .. }));
        let patch: ConnectionPatch = serde_json::from_value(serde_json::json!({
            "targets": [{"accountId": "123456789012", "accountName": "prod", "roleName": "ReadOnly"}]
        }))
        .unwrap();
        assert_eq!(patch.targets.unwrap()[0].role_name, "ReadOnly");
        assert!(patch.label.is_none() && patch.regions.is_none());

        assert!(validate_start_url("http://acme.awsapps.com/start").is_err());
        assert!(validate_start_url("https://user:pw@acme.awsapps.com/start").is_err());
        assert_eq!(
            validate_start_url(" https://d-1234567890.awsapps.com/start ").unwrap(),
            "https://d-1234567890.awsapps.com/start"
        );
    }
}

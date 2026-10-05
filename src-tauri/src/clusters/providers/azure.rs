//! Azure Kubernetes Service through the signed-in `az` user:
//! `az account list` (subscriptions) and `az aks list --subscription S`
//! per subscription. Adding runs `az aks get-credentials` into a private
//! temporary file (never `~/.kube/config`), converts its user to
//! `kubelogin get-token --login azurecli` (with `kubelogin
//! convert-kubeconfig`, the managed kubelogin first; in-process when
//! kubelogin isn't installed) and imports the context like a kubeconfig
//! import: static credentials (local accounts) move to the vault.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use futures::stream::{self, StreamExt};
use jp_auth_core::connections::CloudConnection;
use kube::config::ExecConfig;
use serde_json::Value;

use super::cli::{self, CliError, CliTool};
use super::{
    ConnectionScope, Discovery, Found, Listing, Prepared, Progress, ProgressFn, ProgressState,
};
use crate::clusters::error::AppError;
use crate::clusters::managed_kubeconfig as managed;

const SUBSCRIPTION_CONCURRENCY: usize = 4;
pub const KUBELOGIN_MISSING: &str = "kubelogin isn't installed: install it in Settings → Tools (or with `az aks install-cli`) so kubectl can sign in to this cluster";

/// AKS regions, for the region picker.
pub const REGIONS: &[&str] = &[
    "australiacentral",
    "australiaeast",
    "australiasoutheast",
    "austriaeast",
    "belgiumcentral",
    "brazilsouth",
    "canadacentral",
    "canadaeast",
    "centralindia",
    "centralus",
    "chilecentral",
    "eastasia",
    "eastus",
    "eastus2",
    "francecentral",
    "germanywestcentral",
    "indonesiacentral",
    "israelcentral",
    "italynorth",
    "japaneast",
    "japanwest",
    "koreacentral",
    "koreasouth",
    "malaysiawest",
    "mexicocentral",
    "newzealandnorth",
    "northcentralus",
    "northeurope",
    "norwayeast",
    "polandcentral",
    "qatarcentral",
    "southafricanorth",
    "southcentralus",
    "southeastasia",
    "southindia",
    "spaincentral",
    "swedencentral",
    "switzerlandnorth",
    "uaenorth",
    "uksouth",
    "ukwest",
    "westcentralus",
    "westeurope",
    "westus",
    "westus2",
    "westus3",
];

/// A subscription id (GUID).
pub fn valid_subscription_id(id: &str) -> bool {
    id.len() == 36
        && id.bytes().enumerate().all(|(i, b)| match i {
            8 | 13 | 18 | 23 => b == b'-',
            _ => b.is_ascii_hexdigit(),
        })
}

/// Resource group and cluster names: no flags, nothing odd.
fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 90
        && !name.starts_with('-')
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-_.()".contains(&b))
}

fn quiet(mut args: Vec<String>) -> Vec<String> {
    args.extend(cli::args(&["-o", "json", "--only-show-errors"]));
    args
}

async fn list_subscriptions(
    connection: &CloudConnection,
) -> Result<Vec<ConnectionScope>, CliError> {
    let value = cli::run_json(
        CliTool::Az,
        &quiet(cli::args(&["account", "list"])),
        cli::STATUS_TIMEOUT,
    )
    .await?;
    let account = connection.cli_account.as_deref().filter(|a| !a.is_empty());
    let mut subscriptions: Vec<ConnectionScope> = value
        .as_array()
        .into_iter()
        .flatten()
        .filter(|s| {
            s.get("state")
                .and_then(Value::as_str)
                .is_none_or(|state| state == "Enabled")
        })
        .filter(|s| {
            account.is_none_or(|account| {
                s.pointer("/user/name").and_then(Value::as_str) == Some(account)
            })
        })
        .filter_map(|s| {
            let id = s.get("id")?.as_str()?.to_string();
            valid_subscription_id(&id).then(|| ConnectionScope {
                name: s
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or(&id)
                    .to_string(),
                detail: s
                    .get("tenantId")
                    .and_then(Value::as_str)
                    .map(|t| format!("Tenant {t}")),
                id,
            })
        })
        .collect();
    let mut seen = std::collections::HashSet::new();
    subscriptions.retain(|s| seen.insert(s.id.clone()));
    subscriptions.sort_by_key(|s| s.name.to_lowercase());
    Ok(subscriptions)
}

/// The subscriptions of the az user (the connection's account).
pub async fn subscriptions(connection: &CloudConnection) -> Result<Vec<ConnectionScope>, AppError> {
    Ok(list_subscriptions(connection).await?)
}

/// A cluster of `az aks list`.
pub fn found_of(value: &Value) -> Option<Found> {
    let text = |pointer: &str| {
        value
            .pointer(pointer)
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
    };
    let provisioning = text("/provisioningState");
    let status = match provisioning.as_deref() {
        Some("Succeeded") | None => text("/powerState/code").or(provisioning),
        Some(_) => provisioning,
    };
    Some(Found {
        name: text("/name")?,
        region: text("/location")?,
        native_id: text("/id"),
        version: text("/currentKubernetesVersion").or_else(|| text("/kubernetesVersion")),
        status,
        endpoint: text("/fqdn")
            .or_else(|| text("/privateFqdn"))
            .map(|host| format!("https://{host}:443")),
        created_at: value
            .pointer("/systemData/createdAt")
            .and_then(Value::as_str)
            .and_then(jp_auth_core::time::parse_rfc3339)
            .map(|s| s * 1000),
        certificate_authority: None,
        resource_group: text("/resourceGroup"),
        described: true,
    })
}

/// Discovers the AKS clusters of the connection's subscriptions (all of
/// them when none are chosen).
pub async fn discover(connection: &CloudConnection, progress: Arc<ProgressFn>) -> Discovery {
    let label = connection.display_name();
    let sign_in = || format!("Sign in to the Azure CLI to discover the clusters of {label}");
    let subscriptions: Vec<(String, Option<String>)> = if connection.targets.is_empty() {
        match list_subscriptions(connection).await {
            Ok(list) if list.is_empty() => {
                return Discovery::failed(connection, &*progress, sign_in(), true)
            }
            Ok(list) => list.into_iter().map(|s| (s.id, Some(s.name))).collect(),
            Err(error) => {
                let needs = error.needs_sign_in();
                let message = if needs { sign_in() } else { error.message() };
                return Discovery::failed(connection, &*progress, message, needs);
            }
        }
    } else {
        connection
            .targets
            .iter()
            .map(|t| (t.account_id.clone(), t.account_name.clone()))
            .collect()
    };

    let results: Vec<(Listing, Option<CliError>)> =
        stream::iter(subscriptions.into_iter().map(|(subscription, name)| {
            let progress = progress.clone();
            async move {
                let scope = format!(
                    "{} · clusters",
                    name.clone().unwrap_or_else(|| subscription.clone())
                );
                let report = |state: ProgressState| {
                    Progress::of(&scope, None, state).account(&subscription, name.as_deref())
                };
                progress(report(ProgressState::Running));
                let listed = if valid_subscription_id(&subscription) {
                    cli::run_json(
                        CliTool::Az,
                        &quiet(vec![
                            "aks".into(),
                            "list".into(),
                            format!("--subscription={subscription}"),
                        ]),
                        cli::LIST_TIMEOUT,
                    )
                    .await
                } else {
                    Err(CliError::Failed(format!(
                        "\"{subscription}\" is not a subscription id"
                    )))
                };
                let (complete, clusters, error) = match listed {
                    Ok(value) => {
                        let clusters: Vec<Found> = value
                            .as_array()
                            .into_iter()
                            .flatten()
                            .filter_map(found_of)
                            .collect();
                        progress(report(ProgressState::Done).message(match clusters.len() {
                            1 => "1 cluster".to_string(),
                            n => format!("{n} clusters"),
                        }));
                        (true, clusters, None)
                    }
                    Err(error) => {
                        progress(report(ProgressState::Error).message(error.message()));
                        (false, Vec::new(), Some(error))
                    }
                };
                let mut listing = super::filter_regions(connection, clusters);
                listing.account_id = subscription.clone();
                listing.account_name = name;
                listing.complete = complete;
                (listing, error)
            }
        }))
        .buffer_unordered(SUBSCRIPTION_CONCURRENCY)
        .collect()
        .await;

    let mut discovery = Discovery {
        identity: connection.cli_account.clone(),
        ..Discovery::default()
    };
    let total = results.len();
    let mut needs_sign_in = 0;
    for (listing, error) in results {
        if let Some(error) = error {
            if error.needs_sign_in() {
                needs_sign_in += 1;
            }
            discovery.error.get_or_insert(error.message());
        }
        discovery.listings.push(listing);
    }
    if total > 0 && needs_sign_in == total {
        discovery.needs_sign_in = true;
        discovery.error = Some(sign_in());
    }
    discovery
}

/* -------------------------------------------------------------- adding */

/// A private (0700) temporary directory, removed on drop.
struct TempDir(PathBuf);

impl TempDir {
    fn new() -> Result<TempDir, String> {
        let dir = std::env::temp_dir().join(format!(
            "jet-pilot-aks-{}",
            jp_auth_core::fsutil::random_id()
        ));
        jp_auth_core::paths::ensure_private_dir(&dir)
            .map_err(|e| format!("A temporary directory can't be created: {e}"))?;
        Ok(TempDir(dir))
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn arg_value(args: &[String], flag: &str) -> Option<String> {
    let mut iter = args.iter();
    while let Some(arg) = iter.next() {
        if arg == flag {
            return iter.next().cloned();
        }
        if let Some(value) = arg.strip_prefix(&format!("{flag}=")) {
            return Some(value.to_string());
        }
    }
    None
}

/// `kubelogin convert-kubeconfig -l azurecli` for one exec config, done
/// in-process: `get-token --login azurecli --server-id <id>`.
pub fn to_azurecli(exec: &mut ExecConfig) -> bool {
    let is_kubelogin = exec
        .command
        .as_deref()
        .map(crate::auth::classify::command_basename)
        .is_some_and(|c| c.eq_ignore_ascii_case(cli::KUBELOGIN));
    let args = exec.args.clone().unwrap_or_default();
    if !is_kubelogin || !args.iter().any(|a| a == "get-token") {
        return false;
    }
    let mut converted = cli::args(&["get-token", "--login", "azurecli"]);
    if let Some(server_id) = arg_value(&args, "--server-id") {
        converted.push("--server-id".into());
        converted.push(server_id);
    }
    exec.args = Some(converted);
    exec.env = exec
        .env
        .take()
        .map(|env| {
            env.into_iter()
                .filter(|e| e.get("name").is_none_or(|n| !n.starts_with("AAD_")))
                .collect::<Vec<_>>()
        })
        .filter(|env| !env.is_empty());
    true
}

/// An AKS cluster for the managed kubeconfig: `az aks get-credentials`
/// into a temporary file, converted to the Azure CLI login, imported.
pub async fn prepare(
    subscription: &str,
    resource_group: &str,
    name: &str,
    cluster_id: &str,
    helper: &Path,
) -> Result<Prepared, String> {
    if !valid_subscription_id(subscription) {
        return Err(format!("\"{subscription}\" is not a subscription id."));
    }
    if !valid_name(resource_group) || !valid_name(name) {
        return Err(format!(
            "\"{resource_group}/{name}\" is not an AKS cluster name."
        ));
    }
    let dir = TempDir::new()?;
    let file = dir.0.join("kubeconfig");
    let file_arg = file.to_string_lossy().into_owned();
    cli::run(
        CliTool::Az,
        &[
            "aks".into(),
            "get-credentials".into(),
            format!("--resource-group={resource_group}"),
            format!("--name={name}"),
            format!("--subscription={subscription}"),
            format!("--file={file_arg}"),
            "--overwrite-existing".into(),
            "--only-show-errors".into(),
        ],
        cli::LIST_TIMEOUT,
    )
    .await
    .map_err(|e| e.message())?;

    let mut warnings = Vec::new();
    let kubelogin = cli::kubelogin_path();
    if let Some((kubelogin, _)) = &kubelogin {
        let args = vec![
            "convert-kubeconfig".to_string(),
            "-l".into(),
            "azurecli".into(),
            "--kubeconfig".into(),
            file_arg.clone(),
        ];
        match cli::run_program(
            kubelogin,
            "kubelogin convert-kubeconfig",
            None,
            &args,
            &[("KUBECONFIG".to_string(), file_arg.clone())],
            cli::STATUS_TIMEOUT,
        )
        .await
        {
            Ok(_) => {}
            Err(error) => tracing::warn!(
                "kubelogin convert-kubeconfig failed ({}); converting in-process",
                error.message()
            ),
        }
    }

    let text = std::fs::read_to_string(&file)
        .map_err(|e| format!("az aks get-credentials wrote no kubeconfig: {e}"))?;
    drop(dir);
    let mut config = managed::parse(&text).map_err(|e| {
        format!("az aks get-credentials wrote a kubeconfig JET Pilot can't read: {e}")
    })?;
    // Idempotent: also covers kubelogin missing or failing.
    let mut uses_kubelogin = false;
    for user in &mut config.auth_infos {
        if let Some(exec) = user.auth_info.as_mut().and_then(|a| a.exec.as_mut()) {
            uses_kubelogin |= to_azurecli(exec);
        }
    }
    if uses_kubelogin && kubelogin.is_none() {
        warnings.push(KUBELOGIN_MISSING.to_string());
    }
    let kubelogin = kubelogin.map(|(path, _)| path);
    let mut prepared =
        super::api::entry_from_kubeconfig(&config, cluster_id, helper, &|command| {
            if command.eq_ignore_ascii_case(cli::KUBELOGIN) {
                kubelogin.clone()
            } else {
                cli::find(command)
            }
        })?;
    prepared.warnings = warnings;
    Ok(prepared)
}

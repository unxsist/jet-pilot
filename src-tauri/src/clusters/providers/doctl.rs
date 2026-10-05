//! DigitalOcean through an existing `doctl` sign-in (JET Pilot never signs
//! doctl in): `doctl kubernetes cluster list` for discovery and `doctl
//! kubernetes cluster kubeconfig show` for the server and CA when adding.
//! Clusters run doctl's own exec plugin, as `doctl kubernetes cluster
//! kubeconfig save` sets it up: `doctl kubernetes cluster kubeconfig
//! exec-credential --version=v1beta1 --context=<context> <id>`.

use std::path::Path;
use std::sync::Arc;

use jp_auth_core::connections::CloudConnection;
use kube::config::{AuthInfo, Cluster, ExecConfig};
use serde_json::Value;

use super::cli::{self, CliTool};
use super::{filter_regions, Discovery, Found, Prepared, Progress, ProgressFn, ProgressState};

/// Statuses in which a cluster can be added.
const READY: &[&str] = &["running", "degraded", "upgrading"];

/// doctl context names: no flags, nothing odd.
pub fn valid_context(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 128
        && !name.starts_with('-')
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-_.@".contains(&b))
}

fn with_context(connection: &CloudConnection, mut args: Vec<String>) -> Vec<String> {
    if let Some(context) = connection
        .cli_account
        .as_deref()
        .filter(|c| valid_context(c))
    {
        args.push(format!("--context={context}"));
    }
    args
}

/// A cluster of `doctl kubernetes cluster list --output json`.
pub fn found_of(value: &Value) -> Option<Found> {
    let text = |pointer: &str| {
        value
            .pointer(pointer)
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
    };
    Some(Found {
        name: text("/name")?,
        region: text("/region").or_else(|| text("/region_slug"))?,
        native_id: Some(text("/id")?),
        version: text("/version"),
        status: text("/status/state"),
        endpoint: text("/endpoint"),
        created_at: value
            .get("created_at")
            .and_then(Value::as_str)
            .and_then(jp_auth_core::time::parse_rfc3339)
            .map(|s| s * 1000),
        certificate_authority: None,
        resource_group: None,
        described: true,
    })
}

/// Discovers the clusters of the doctl user (one listing, every region).
pub async fn discover(connection: &CloudConnection, progress: Arc<ProgressFn>) -> Discovery {
    let label = connection.display_name();
    let scope = format!("{label} · clusters");
    progress(Progress::of(&scope, None, ProgressState::Running));
    let args = with_context(
        connection,
        cli::args(&["kubernetes", "cluster", "list", "--output", "json"]),
    );
    match cli::run_json(CliTool::Doctl, &args, cli::LIST_TIMEOUT).await {
        Ok(value) => {
            let clusters: Vec<Found> = value
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(found_of)
                .collect();
            let listing = filter_regions(connection, clusters);
            progress(Progress::of(&scope, None, ProgressState::Done).message(
                match listing.clusters.len() {
                    1 => "1 cluster".to_string(),
                    n => format!("{n} clusters"),
                },
            ));
            Discovery {
                listings: vec![listing],
                identity: connection.cli_account.clone(),
                ..Discovery::default()
            }
        }
        Err(error) => {
            let needs = error.needs_sign_in();
            let message = if needs {
                format!("Sign in with doctl (doctl auth init) to discover the clusters of {label}")
            } else {
                error.message()
            };
            Discovery::failed(connection, &*progress, message, needs)
        }
    }
}

/// doctl's exec plugin for a cluster (an absolute path to doctl when it is
/// found), as `doctl kubernetes cluster kubeconfig save` writes it.
pub fn exec(doctl: Option<&Path>, context: Option<&str>, cluster: &str) -> ExecConfig {
    let mut args = cli::args(&[
        "kubernetes",
        "cluster",
        "kubeconfig",
        "exec-credential",
        "--version=v1beta1",
    ]);
    if let Some(context) = context.filter(|c| valid_context(c)) {
        args.push(format!("--context={context}"));
    }
    args.push(cluster.to_string());
    ExecConfig {
        api_version: Some(jp_auth_core::exec_credential::API_VERSION_V1BETA1.to_string()),
        command: Some(
            doctl
                .map(|p| p.to_string_lossy().into_owned())
                .unwrap_or_else(|| "doctl".to_string()),
        ),
        args: Some(args),
        install_hint: Some(
            "Install doctl and sign in (doctl auth init): https://docs.digitalocean.com/reference/doctl/how-to/install/"
                .to_string(),
        ),
        ..ExecConfig::default()
    }
}

/// A DigitalOcean cluster of a doctl connection for the managed kubeconfig.
pub async fn prepare(
    connection: &CloudConnection,
    native_id: &str,
    name: &str,
    status: Option<&str>,
) -> Result<Prepared, String> {
    if !jp_auth_core::request::valid_cloud_cluster_id(native_id) {
        return Err(format!("\"{native_id}\" is not a cluster id."));
    }
    let args = with_context(
        connection,
        vec![
            "kubernetes".into(),
            "cluster".into(),
            "kubeconfig".into(),
            "show".into(),
            native_id.to_string(),
        ],
    );
    let text = cli::run(CliTool::Doctl, &args, cli::LIST_TIMEOUT)
        .await
        .map_err(|e| e.message())?;
    let parts = jp_auth_core::cloud::kubeconfig::parse(&text);
    let (Some(server), Some(ca)) = (parts.server, parts.certificate_authority_data) else {
        return Err(super::not_ready(name, status, READY));
    };
    // The context the entry signs in with: the connection's, else doctl's
    // current one (what `kubeconfig save` would write).
    let context = match connection.cli_account.clone() {
        Some(context) => Some(context),
        None => cli::run(
            CliTool::Doctl,
            &cli::args(&["auth", "list"]),
            cli::STATUS_TIMEOUT,
        )
        .await
        .ok()
        .and_then(|listed| cli::parse_doctl_contexts(&listed).1),
    };
    let user = AuthInfo {
        exec: Some(exec(
            cli::find("doctl").as_deref(),
            context.as_deref(),
            native_id,
        )),
        ..AuthInfo::default()
    };
    Ok(Prepared {
        identity: crate::clusters::managed_kubeconfig::identity_of(Some(&user)),
        cluster: Cluster {
            server: Some(server),
            certificate_authority_data: Some(ca),
            ..Cluster::default()
        },
        user,
        secrets: Vec::new(),
        native_id: Some(native_id.to_string()),
        warnings: Vec::new(),
    })
}

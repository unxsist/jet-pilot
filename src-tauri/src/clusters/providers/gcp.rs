//! Google Kubernetes Engine through the signed-in `gcloud` user:
//! `gcloud projects list` (the scope picker / all projects) and
//! `gcloud container clusters list --project P` per project, four at a
//! time. Clusters are added with the standard `gke-gcloud-auth-plugin`
//! exec plugin (server and CA from the listing), so kubectl and k9s use
//! them like `gcloud container clusters get-credentials` would set up —
//! without JET Pilot ever writing `~/.kube/config` or gcloud's config.

use std::sync::Arc;

use futures::stream::{self, StreamExt};
use jp_auth_core::connections::CloudConnection;
use kube::config::{AuthInfo, Cluster, ExecConfig};
use serde_json::Value;

use super::cli::{self, CliError, CliTool};
use super::{
    server_and_ca, ConnectionScope, Discovery, Found, Listing, Prepared, Progress, ProgressFn,
    ProgressState,
};
use crate::clusters::error::AppError;

const PROJECT_CONCURRENCY: usize = 4;
/// Cluster statuses in which a cluster can be added.
const READY: &[&str] = &["RUNNING", "RECONCILING", "DEGRADED"];
pub const INSTALL_HINT: &str = "Install gke-gcloud-auth-plugin for use with kubectl by following https://cloud.google.com/kubernetes-engine/docs/how-to/cluster-access-for-kubectl#install_plugin";
pub const PLUGIN_MISSING: &str = "gke-gcloud-auth-plugin isn't installed: install it with `gcloud components install gke-gcloud-auth-plugin`";

/// GKE regions, for the region picker (zonal clusters match their region).
pub const REGIONS: &[&str] = &[
    "africa-south1",
    "asia-east1",
    "asia-east2",
    "asia-northeast1",
    "asia-northeast2",
    "asia-northeast3",
    "asia-south1",
    "asia-south2",
    "asia-southeast1",
    "asia-southeast2",
    "australia-southeast1",
    "australia-southeast2",
    "europe-central2",
    "europe-north1",
    "europe-north2",
    "europe-southwest1",
    "europe-west1",
    "europe-west10",
    "europe-west12",
    "europe-west2",
    "europe-west3",
    "europe-west4",
    "europe-west6",
    "europe-west8",
    "europe-west9",
    "me-central1",
    "me-central2",
    "me-west1",
    "northamerica-northeast1",
    "northamerica-northeast2",
    "northamerica-south1",
    "southamerica-east1",
    "southamerica-west1",
    "us-central1",
    "us-east1",
    "us-east4",
    "us-east5",
    "us-south1",
    "us-west1",
    "us-west2",
    "us-west3",
    "us-west4",
];

/// `--format=json --quiet --verbosity=error [--account=<cliAccount>]`.
fn common(connection: &CloudConnection, mut args: Vec<String>) -> Vec<String> {
    args.extend(cli::args(&[
        "--format=json",
        "--quiet",
        "--verbosity=error",
    ]));
    if let Some(account) = connection.cli_account.as_deref().filter(|a| !a.is_empty()) {
        args.push(format!("--account={account}"));
    }
    args
}

/// Project ids as gcloud accepts them (`my-project`, `example.com:proj`).
pub fn valid_project_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 100
        && !id.starts_with('-')
        && id
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b"-.:".contains(&b))
}

async fn list_projects(connection: &CloudConnection) -> Result<Vec<ConnectionScope>, CliError> {
    let value = cli::run_json(
        CliTool::Gcloud,
        &common(connection, cli::args(&["projects", "list"])),
        cli::LIST_TIMEOUT,
    )
    .await?;
    let mut projects: Vec<ConnectionScope> = value
        .as_array()
        .into_iter()
        .flatten()
        .filter(|p| {
            p.get("lifecycleState")
                .and_then(Value::as_str)
                .is_none_or(|s| s == "ACTIVE")
        })
        .filter_map(|p| {
            let id = p.get("projectId")?.as_str()?.to_string();
            valid_project_id(&id).then(|| ConnectionScope {
                name: p
                    .get("name")
                    .and_then(Value::as_str)
                    .filter(|n| !n.is_empty())
                    .unwrap_or(&id)
                    .to_string(),
                detail: p
                    .get("projectNumber")
                    .and_then(Value::as_str)
                    .map(|n| format!("Project number {n}")),
                id,
            })
        })
        .collect();
    projects.sort_by_key(|p| p.name.to_lowercase());
    Ok(projects)
}

/// The projects the gcloud user can see.
pub async fn projects(connection: &CloudConnection) -> Result<Vec<ConnectionScope>, AppError> {
    Ok(list_projects(connection).await?)
}

/// A cluster of `gcloud container clusters list`.
pub fn found_of(value: &Value) -> Option<Found> {
    let text = |key: &str| {
        value
            .get(key)
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
    };
    Some(Found {
        name: text("name")?,
        region: text("location").or_else(|| text("zone"))?,
        native_id: text("selfLink").or_else(|| text("id")),
        version: text("currentMasterVersion"),
        status: text("status"),
        endpoint: text("endpoint").map(|e| {
            if e.starts_with("https://") {
                e
            } else {
                format!("https://{e}")
            }
        }),
        created_at: value
            .get("createTime")
            .and_then(Value::as_str)
            .and_then(jp_auth_core::time::parse_rfc3339)
            .map(|s| s * 1000),
        certificate_authority: value
            .pointer("/masterAuth/clusterCaCertificate")
            .and_then(Value::as_str)
            .map(str::to_string),
        resource_group: None,
        described: true,
    })
}

/// The project's Kubernetes Engine API is off: it has no clusters.
fn api_disabled(error: &CliError) -> bool {
    let message = error.message().to_ascii_lowercase();
    message.contains("has not been used in project")
        || message.contains("service_disabled")
        || message.contains("is disabled")
}

/// Discovers the GKE clusters of the connection's projects (all of them
/// when none are chosen).
pub async fn discover(connection: &CloudConnection, progress: Arc<ProgressFn>) -> Discovery {
    let label = connection.display_name();
    let projects: Vec<(String, Option<String>)> = if connection.targets.is_empty() {
        let scope = format!("{label} · projects");
        progress(Progress::of(&scope, None, ProgressState::Running));
        match list_projects(connection).await {
            Ok(projects) => {
                progress(
                    Progress::of(&scope, None, ProgressState::Done)
                        .message(format!("{} projects", projects.len())),
                );
                projects.into_iter().map(|p| (p.id, Some(p.name))).collect()
            }
            Err(error) => {
                let needs = error.needs_sign_in();
                let message = if needs {
                    format!("Sign in to gcloud to discover the clusters of {label}")
                } else {
                    error.message()
                };
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
        stream::iter(projects.into_iter().map(|(project, name)| {
            let progress = progress.clone();
            async move {
                let shown = name.clone().unwrap_or_else(|| project.clone());
                let scope = match &name {
                    Some(name) if *name != project => format!("{name} ({project}) · clusters"),
                    _ => format!("{project} · clusters"),
                };
                progress(
                    Progress::of(&scope, None, ProgressState::Running)
                        .account(&project, name.as_deref()),
                );
                let args = common(
                    connection,
                    vec![
                        "container".into(),
                        "clusters".into(),
                        "list".into(),
                        format!("--project={project}"),
                    ],
                );
                let listed = if valid_project_id(&project) {
                    cli::run_json(CliTool::Gcloud, &args, cli::LIST_TIMEOUT).await
                } else {
                    Err(CliError::Failed(format!(
                        "\"{project}\" is not a project id"
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
                        progress(
                            Progress::of(&scope, None, ProgressState::Done)
                                .account(&project, name.as_deref())
                                .message(match clusters.len() {
                                    1 => "1 cluster".to_string(),
                                    n => format!("{n} clusters"),
                                }),
                        );
                        (true, clusters, None)
                    }
                    Err(error) if api_disabled(&error) => {
                        progress(
                            Progress::of(&scope, None, ProgressState::Done)
                                .account(&project, name.as_deref())
                                .message("Kubernetes Engine is not enabled"),
                        );
                        (true, Vec::new(), None)
                    }
                    Err(error) => {
                        progress(
                            Progress::of(&scope, None, ProgressState::Error)
                                .account(&project, name.as_deref())
                                .message(format!("{shown}: {}", error.message())),
                        );
                        (false, Vec::new(), Some(error))
                    }
                };
                let mut listing = super::filter_regions(connection, clusters);
                listing.account_id = project.clone();
                listing.account_name = name;
                listing.complete = complete;
                (listing, error)
            }
        }))
        .buffer_unordered(PROJECT_CONCURRENCY)
        .collect()
        .await;

    let mut discovery = Discovery {
        identity: connection.cli_account.clone(),
        ..Discovery::default()
    };
    let total = results.len();
    let mut sign_in = 0;
    for (listing, error) in results {
        if let Some(error) = error {
            if error.needs_sign_in() {
                sign_in += 1;
            }
            discovery.error.get_or_insert(error.message());
        }
        discovery.listings.push(listing);
    }
    if total > 0 && sign_in == total {
        discovery.needs_sign_in = true;
        discovery.error = Some(format!(
            "Sign in to gcloud to discover the clusters of {label}"
        ));
    }
    discovery
}

/// The `gke-gcloud-auth-plugin` exec of a cluster (an absolute path when
/// the plugin is found), with the connection's gcloud account.
pub fn plugin_exec(connection: &CloudConnection, plugin: Option<&std::path::Path>) -> ExecConfig {
    let env = connection
        .cli_account
        .as_deref()
        .filter(|a| !a.is_empty())
        .map(|account| {
            vec![[
                ("name".to_string(), "CLOUDSDK_CORE_ACCOUNT".to_string()),
                ("value".to_string(), account.to_string()),
            ]
            .into()]
        });
    ExecConfig {
        api_version: Some(jp_auth_core::exec_credential::API_VERSION_V1BETA1.to_string()),
        command: Some(
            plugin
                .map(|p| p.to_string_lossy().into_owned())
                .unwrap_or_else(|| cli::GKE_PLUGIN.to_string()),
        ),
        install_hint: Some(INSTALL_HINT.to_string()),
        provide_cluster_info: true,
        env,
        ..ExecConfig::default()
    }
}

/// A GKE cluster for the managed kubeconfig (no CLI run: the listing has
/// the server and CA).
pub fn prepare(
    connection: &CloudConnection,
    name: &str,
    status: Option<&str>,
    endpoint: Option<&str>,
    ca: Option<&str>,
    plugin: Option<&std::path::Path>,
) -> Result<Prepared, String> {
    let (server, ca) = server_and_ca(name, status, READY, endpoint, ca)?;
    let exec = plugin_exec(connection, plugin);
    let user = AuthInfo {
        exec: Some(exec),
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
        native_id: None,
        warnings: if plugin.is_none() {
            vec![PLUGIN_MISSING.to_string()]
        } else {
            Vec::new()
        },
    })
}

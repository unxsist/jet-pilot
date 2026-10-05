pub mod client {
    use either::Either;
    use k8s_metrics::v1beta1::PodMetrics;
    use k8s_openapi::api::apps::v1::{Deployment, StatefulSet};
    use k8s_openapi::api::batch::v1::{CronJob, Job};
    use k8s_openapi::api::core::v1::{
        ConfigMap, Namespace, PersistentVolume, PersistentVolumeClaim, Pod, Secret, Service,
    };
    use k8s_openapi::api::networking::v1::Ingress;
    use k8s_openapi::apimachinery::pkg::apis::meta::v1::{APIGroup, APIResource};
    use kube::api::{DeleteParams, ListParams, ObjectMeta, PostParams};
    use kube::config::{KubeConfigOptions, Kubeconfig, KubeconfigError, NamedContext};
    use k8s_openapi::NamespaceResourceScope;
    use kube::{api::Api, Client, Config, Error, Resource};
    use once_cell::sync::Lazy;
    use rand::distributions::DistString;
    use serde::{Deserialize, Serialize};
    use std::collections::HashMap;
    use std::process::Stdio;
    use std::sync::{Arc, Mutex};
    use std::time::{Duration, SystemTime};
    use tokio::io::AsyncWriteExt;
    use tokio::process::Command;
    use tokio::sync::OnceCell;
    use tracing::{debug, error, info, trace};

    use crate::util::lock;

    #[cfg(windows)]
    use std::os::windows::process::CommandExt;

    /// Build a resource API that lists across all namespaces when the
    /// frontend's global namespace selection is empty ("All namespaces"
    /// mode), mirroring `kubectl get -A`. Otherwise scope to the namespace.
    fn api_all_or_namespaced<K>(client: Client, namespace: &str) -> Api<K>
    where
        K: Resource<DynamicType = (), Scope = NamespaceResourceScope>,
    {
        if namespace.is_empty() {
            Api::all(client)
        } else {
            Api::namespaced(client, namespace)
        }
    }

    #[derive(Serialize)]
    pub enum DeletionResult {
        Deleted(String),
        Pending(String),
    }

    #[derive(Debug, Serialize)]
    pub struct SerializableKubeError {
        pub(crate) message: String,
        pub(crate) code: Option<u16>,
        pub(crate) reason: Option<String>,
        details: Option<String>,
    }

    impl From<Error> for SerializableKubeError {
        fn from(error: Error) -> Self {
            error!("Kubernetes API error occurred: {:?}", error);

            match error {
                Error::Api(api_error) => {
                    let code = api_error.code;
                    let reason = api_error.reason;
                    let message = api_error.message;
                    return SerializableKubeError {
                        message,
                        code: Option::from(code),
                        reason: Option::from(reason),
                        details: None,
                    };
                }
                // Exec credential plugin errors (kubelogin / oidc-login /
                // gke-gcloud-auth-plugin) carry the plugin's stderr, which
                // usually contains the device-code URL or browser instructions
                // the user needs to complete the OIDC login. Surface it so the
                // UI can show it instead of a generic "auth error".
                Error::Auth(auth_error) => {
                    let message = auth_error_message(&auth_error);
                    SerializableKubeError {
                        message,
                        code: None,
                        reason: Some("ExecAuthFailed".to_string()),
                        details: None,
                    }
                }
                _ => {
                    return SerializableKubeError {
                        message: error.to_string(),
                        code: None,
                        reason: None,
                        details: None,
                    };
                }
            }
        }
    }

    /// User-facing message for an auth (exec credential plugin) failure.
    pub(crate) fn auth_error_message(auth_error: &kube::client::AuthError) -> String {
        match auth_error {
            kube::client::AuthError::ExecPluginFailed => {
                "Exec credential plugin did not return credentials".to_string()
            }
            kube::client::AuthError::AuthExecStart(io_err) => {
                format!(
                    "Unable to run the Kubernetes exec credential plugin ({}) - it may need to be installed separately. {}",
                    io_err,
                    hint_for_exec_plugin(io_err)
                )
            }
            kube::client::AuthError::AuthExecRun { out, .. } => {
                let stderr = String::from_utf8_lossy(&out.stderr);
                let stdout = displayable_exec_stdout(&String::from_utf8_lossy(&out.stdout));
                if !stderr.trim().is_empty() {
                    format!(
                        "The Kubernetes exec credential plugin failed: {}\n\n{}",
                        stderr.trim(),
                        "Complete the login (e.g. open the URL above in a browser and enter the code) and try again."
                    )
                } else if !stdout.trim().is_empty() {
                    format!(
                        "The Kubernetes exec credential plugin failed: {}\n\nComplete the login and try again.",
                        stdout.trim()
                    )
                } else {
                    format!(
                        "The Kubernetes exec credential plugin failed ({}). Complete the login and try again.",
                        auth_error
                    )
                }
            }
            kube::client::AuthError::ExecMissingClusterInfo => {
                "The exec credential plugin requires cluster info that is missing from the kubeconfig".to_string()
            }
            kube::client::AuthError::MissingCommand => {
                "The kubeconfig exec credential plugin is missing its command".to_string()
            }
            _ => auth_error.to_string(),
        }
    }

    /// Exec credential plugins print the `ExecCredential` (bearer token /
    /// client key) on stdout. That must never reach the webview, so stdout is
    /// only surfaced when it doesn't look like a credential document.
    pub(crate) fn displayable_exec_stdout(stdout: &str) -> String {
        let trimmed = stdout.trim();
        let looks_like_credential = trimmed.contains("ExecCredential")
            || serde_json::from_str::<serde_json::Value>(trimmed).is_ok()
            || trimmed.contains("\"token\"")
            || trimmed.contains("clientKeyData");
        if looks_like_credential {
            String::new()
        } else {
            trimmed.to_string()
        }
    }

    fn hint_for_exec_plugin(io_err: &std::io::Error) -> &'static str {
        if io_err.kind() == std::io::ErrorKind::NotFound {
            "Make sure the plugin binary (e.g. kubelogin, gke-gcloud-auth-plugin) is installed and on your PATH."
        } else {
            ""
        }
    }

    impl From<KubeconfigError> for SerializableKubeError {
        fn from(error: KubeconfigError) -> Self {
            error!("Kubeconfig error occurred: {:?}", error);
            
            return SerializableKubeError {
                message: error.to_string(),
                code: None,
                reason: None,
                details: None,
            };
        }
    }

    static CURRENT_KUBECONFIG: Mutex<Option<String>> = Mutex::new(None);

    /// A cached client slot. The `OnceCell` makes concurrent first calls for
    /// the same key share a single build (and so a single exec-plugin run)
    /// instead of racing check-then-insert. `stamp` is the kubeconfig's
    /// modification time when the slot was created: when the file changes
    /// (new token, edited context) the slot is replaced.
    struct CachedClient {
        stamp: Option<SystemTime>,
        cell: Arc<OnceCell<Client>>,
    }

    /// Cached clients keyed by (kubeconfig path, context). With multiple
    /// contexts active at once, a single cached client would be rebuilt (or,
    /// worse, reused for the wrong kubeconfig) on every switch between rows of
    /// different clusters. An empty kubeconfig path means default resolution.
    static CLIENTS: Lazy<Mutex<HashMap<(String, String), CachedClient>>> =
        Lazy::new(|| Mutex::new(HashMap::new()));

    fn no_kubeconfig_error() -> SerializableKubeError {
        SerializableKubeError {
            message: "No kubeconfig has been set".to_string(),
            code: None,
            reason: Some("NoKubeconfig".to_string()),
            details: None,
        }
    }

    /// The kubeconfig path a command should use: the explicit `kube_config`
    /// argument when given, otherwise the globally selected one (empty string
    /// = kube's default resolution via $KUBECONFIG / ~/.kube/config).
    pub(crate) fn resolve_kubeconfig_path(kube_config: Option<&str>) -> String {
        match kube_config {
            Some(path) if !path.is_empty() => path.to_string(),
            _ => lock(&CURRENT_KUBECONFIG).clone().unwrap_or_default(),
        }
    }

    /// Kubeconfig files kube would read for `path` (empty = default
    /// resolution).
    fn kubeconfig_files(path: &str) -> Vec<std::path::PathBuf> {
        if !path.is_empty() {
            return vec![path.into()];
        }

        if let Some(paths) = std::env::var_os("KUBECONFIG").filter(|p| !p.is_empty()) {
            return std::env::split_paths(&paths).collect();
        }

        std::env::var_os("HOME")
            .or_else(|| std::env::var_os("USERPROFILE"))
            .map(|home| vec![std::path::Path::new(&home).join(".kube").join("config")])
            .unwrap_or_default()
    }

    /// Latest modification time of the kubeconfig file(s) behind `path`.
    fn kubeconfig_stamp(path: &str) -> Option<SystemTime> {
        kubeconfig_files(path)
            .iter()
            .filter_map(|file| std::fs::metadata(file).and_then(|m| m.modified()).ok())
            .max()
    }

    /// Returns the cache slot for `key`, replacing it when the kubeconfig
    /// changed on disk since the slot was created.
    fn client_slot(key: (String, String), stamp: Option<SystemTime>) -> Arc<OnceCell<Client>> {
        let mut clients = lock(&CLIENTS);
        match clients.get(&key) {
            Some(cached) if cached.stamp == stamp => cached.cell.clone(),
            _ => {
                let cell = Arc::new(OnceCell::new());
                clients.insert(key, CachedClient { stamp, cell: cell.clone() });
                cell
            }
        }
    }

    #[tauri::command]
    pub async fn get_current_context(
        kube_config: Option<String>,
    ) -> Result<String, SerializableKubeError> {
        debug!("Retrieving current Kubernetes context");
        let kubeconfig_path = resolve_kubeconfig_path(kube_config.as_deref());
        let config = if kubeconfig_path.is_empty() {
            Kubeconfig::read()
        } else {
            Kubeconfig::read_from(kubeconfig_path.as_str())
        }
        .map_err(|err| {
            error!("Failed to read kubeconfig: {}", err);
            SerializableKubeError::from(err)
        })?;

        let context = config.current_context.ok_or_else(|| SerializableKubeError {
            message: "No current context set in kubeconfig".to_string(),
            code: None,
            reason: Some("NoCurrentContext".to_string()),
            details: None,
        })?;

        info!("Current context retrieved: {}", context);
        Ok(context)
    }

    #[tauri::command]
    pub async fn list_contexts(
        kube_config: Option<String>,
    ) -> Result<Vec<NamedContext>, SerializableKubeError> {
        debug!("Listing available Kubernetes contexts");
        let kubeconfig = resolve_kubeconfig_path(kube_config.as_deref());
        if kubeconfig.is_empty() {
            error!("No kubeconfig has been set");
            return Err(no_kubeconfig_error());
        }

        let config = Kubeconfig::read_from(kubeconfig.as_str()).map_err(|err| {
            error!("Failed to read kubeconfig from path: {}", err);
            SerializableKubeError::from(err)
        })?;

        info!("Found {} contexts", config.contexts.len());
        trace!("Available contexts: {:?}", config.contexts);
        Ok(config.contexts)
    }

    /// The parts of a context's auth configuration the frontend needs to
    /// offer a re-login. Deliberately excludes tokens, client keys,
    /// passwords and exec env values other than the AWS profile name.
    #[derive(Debug, Default, PartialEq, Serialize)]
    #[serde(rename_all = "camelCase")]
    pub struct ContextAuthSummary {
        /// The exec credential plugin command, if the context uses one.
        pub exec_command: Option<String>,
        /// `AWS_PROFILE` from the exec plugin env (AWS SSO re-login).
        pub aws_profile: Option<String>,
    }

    /// Finds the auth info of `context` in `config`.
    fn auth_info_for_context(
        config: &Kubeconfig,
        context: &str,
    ) -> Result<kube::config::AuthInfo, SerializableKubeError> {
        let user = config
            .contexts
            .iter()
            .find(|c| c.name == context)
            .and_then(|c| c.context.as_ref())
            .map(|c| c.user.clone())
            .ok_or_else(|| SerializableKubeError {
                message: "Context not found".to_string(),
                code: None,
                reason: None,
                details: None,
            })?;

        config
            .auth_infos
            .iter()
            .find(|a| Some(&a.name) == user.as_ref())
            .and_then(|a| a.auth_info.clone())
            .ok_or_else(|| SerializableKubeError {
                message: "Auth info not found".to_string(),
                code: None,
                reason: None,
                details: None,
            })
    }

    fn summarize_auth_info(auth_info: &kube::config::AuthInfo) -> ContextAuthSummary {
        let exec = auth_info.exec.as_ref();
        ContextAuthSummary {
            exec_command: exec.and_then(|exec| exec.command.clone()),
            aws_profile: exec
                .and_then(|exec| exec.env.as_ref())
                .and_then(|envs| {
                    envs.iter().find(|env| env.get("name").map(String::as_str) == Some("AWS_PROFILE"))
                })
                .and_then(|env| env.get("value").cloned()),
        }
    }

    /// The exec credential plugin command (basename) a context authenticates
    /// with, if any. Used to word watch auth errors like kubectl does
    /// ("executable aws failed") so the frontend's re-login detection works.
    pub(crate) fn exec_command_for_context(kube_config: Option<&str>, context: &str) -> Option<String> {
        let path = resolve_kubeconfig_path(kube_config);
        let config = if path.is_empty() {
            Kubeconfig::read().ok()?
        } else {
            Kubeconfig::read_from(path.as_str()).ok()?
        };
        let command = auth_info_for_context(&config, context).ok()?.exec?.command?;
        Some(
            std::path::Path::new(&command)
                .file_name()
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or(command),
        )
    }

    #[tauri::command]
    pub async fn get_context_auth_info(
        context: &str,
        kube_config: &str,
    ) -> Result<ContextAuthSummary, SerializableKubeError> {
        let config = Kubeconfig::read_from(kube_config)
            .map_err(SerializableKubeError::from)?;

        let auth_info = auth_info_for_context(&config, context)?;
        Ok(summarize_auth_info(&auth_info))
    }

    async fn build_client(context: &str, kubeconfig_path: &str) -> Result<Client, SerializableKubeError> {
        debug!("Creating client for context: {}", context);
        let options = KubeConfigOptions {
            context: Some(context.to_string()),
            cluster: None,
            user: None,
        };

        let client_config = if !kubeconfig_path.is_empty() {
            debug!("Using custom kubeconfig path");
            let kubeconfig = Kubeconfig::read_from(kubeconfig_path).map_err(|err| {
                error!("Failed to read custom kubeconfig: {}", err);
                SerializableKubeError::from(err)
            })?;
            Config::from_custom_kubeconfig(kubeconfig, &options).await.map_err(|err| {
                error!("Failed to create config from custom kubeconfig: {}", err);
                SerializableKubeError::from(err)
            })?
        } else {
            debug!("Using default kubeconfig path");
            Config::from_kubeconfig(&options).await.map_err(|err| {
                error!("Failed to create config from default kubeconfig: {}", err);
                SerializableKubeError::from(err)
            })?
        };

        let client = Client::try_from(client_config).map_err(|err| {
            error!("Failed to create Kubernetes client: {}", err);
            SerializableKubeError::from(err)
        })?;

        info!("Created client for context: {}", context);
        Ok(client)
    }

    /// Returns a (cached) client for `context`. `kube_config` selects the
    /// kubeconfig file the context lives in; when absent or empty the globally
    /// selected kubeconfig (see `set_current_kubeconfig`) is used.
    pub(crate) async fn client_with_context(
        context: &str,
        kube_config: Option<&str>,
    ) -> Result<Client, SerializableKubeError> {
        let kubeconfig_path = resolve_kubeconfig_path(kube_config);
        let stamp = kubeconfig_stamp(&kubeconfig_path);
        let cell = client_slot((kubeconfig_path.clone(), context.to_string()), stamp);

        // A failed build leaves the cell empty, so the next call retries.
        let client = cell
            .get_or_try_init(|| build_client(context, &kubeconfig_path))
            .await?;
        Ok(client.clone())
    }

    #[tauri::command]
    pub async fn set_current_kubeconfig(kube_config: &str) -> Result<(), SerializableKubeError> {
        debug!("Setting current kubeconfig path");

        // Validate the kubeconfig can be read before setting it
        match Kubeconfig::read_from(kube_config.to_string()) {
            Ok(_) => {
                lock(&CURRENT_KUBECONFIG).replace(kube_config.to_string());
                info!("Successfully set new kubeconfig path");
                Ok(())
            }
            Err(err) => {
                error!("Invalid kubeconfig provided: {}", err);
                Err(SerializableKubeError::from(err))
            }
        }
    }

    #[tauri::command]
    pub async fn list_namespaces(
        context: &str,
        kube_config: Option<String>,
    ) -> Result<Vec<Namespace>, SerializableKubeError> {
        debug!("Listing namespaces for context: {}", context);
        let client = client_with_context(context, kube_config.as_deref()).await?;
        let namespace_api: Api<Namespace> = Api::all(client);

        let namespaces = namespace_api.list(&ListParams::default()).await.map_err(|err| {
            error!("Failed to list namespaces: {}", err);
            SerializableKubeError::from(err)
        })?;

        info!("Found {} namespaces", namespaces.items.len());
        Ok(namespaces.items)
    }

    #[tauri::command]
    pub async fn list_pods(
        context: &str,
        namespace: &str,
        label_selector: &str,
        field_selector: &str,
        kube_config: Option<String>,
    ) -> Result<Vec<Pod>, SerializableKubeError> {
        debug!("Listing pods in namespace {} for context: {}", namespace, context);
        trace!("Using selectors - label: {}, field: {}", label_selector, field_selector);
        
        let client = client_with_context(context, kube_config.as_deref()).await?;
        let pod_api: Api<Pod> = api_all_or_namespaced(client, namespace);

        let pods = pod_api.list(
            &ListParams::default()
                .labels(label_selector)
                .fields(field_selector),
        ).await.map_err(|err| {
            error!("Failed to list pods in namespace {}: {}", namespace, err);
            SerializableKubeError::from(err)
        })?;

        info!("Found {} pods in namespace {}", pods.items.len(), namespace);
        Ok(pods.items)
    }

    #[tauri::command]
    pub async fn get_pod_metrics(
        context: &str,
        namespace: &str,
        kube_config: Option<String>,
    ) -> Result<Vec<PodMetrics>, SerializableKubeError> {
        debug!("Fetching pod metrics for namespace {} in context {}", namespace, context);
        let client = client_with_context(context, kube_config.as_deref()).await?;
        let metrics_api: Api<PodMetrics> = api_all_or_namespaced(client, namespace);

        let metrics = metrics_api.list(&ListParams::default()).await.map_err(|err| {
            error!("Failed to get pod metrics for namespace {}: {}", namespace, err);
            SerializableKubeError::from(err)
        })?;

        info!("Retrieved metrics for {} pods in namespace {}", metrics.items.len(), namespace);
        Ok(metrics.items)
    }

    #[tauri::command]
    pub async fn get_pod_metric(
        context: &str,
        namespace: &str,
        name: &str,
        kube_config: Option<String>,
    ) -> Result<PodMetrics, SerializableKubeError> {
        debug!("Fetching metrics for pod {}/{}", namespace, name);
        let client = client_with_context(context, kube_config.as_deref()).await?;
        let metrics_api: Api<PodMetrics> = Api::namespaced(client, namespace);

        let metric = metrics_api.get(name).await.map_err(|err| {
            error!("Failed to get metrics for pod {}/{}: {}", namespace, name, err);
            SerializableKubeError::from(err)
        })?;

        info!("Successfully retrieved metrics for pod {}/{}", namespace, name);
        Ok(metric)
    }

    #[tauri::command]
    pub async fn get_pod(
        context: &str,
        namespace: &str,
        name: &str,
        kube_config: Option<String>,
    ) -> Result<Pod, SerializableKubeError> {
        let client = client_with_context(context, kube_config.as_deref()).await?;
        let pod_api: Api<Pod> = Api::namespaced(client, namespace);

        return pod_api
            .get(name)
            .await
            .map_err(|err| SerializableKubeError::from(err));
    }

    #[tauri::command]
    pub async fn delete_pod(
        context: &str,
        namespace: &str,
        name: &str,
        grace_period_seconds: u32,
        kube_config: Option<String>,
    ) -> Result<DeletionResult, SerializableKubeError> {
        debug!("Deleting pod {}/{} with grace period {}s", namespace, name, grace_period_seconds);
        let client = client_with_context(context, kube_config.as_deref()).await?;
        let pod_api: Api<Pod> = Api::namespaced(client, namespace);

        match pod_api
            .delete(name, &DeleteParams::default().grace_period(grace_period_seconds))
            .await
        {
            Ok(Either::Left(_pod)) => {
                info!("Pod {}/{} deleted successfully", namespace, name);
                Ok(DeletionResult::Deleted(name.to_string()))
            }
            Ok(Either::Right(_status)) => {
                debug!("Pod {}/{} deletion in progress", namespace, name);
                Ok(DeletionResult::Pending("Deletion in progress".to_string()))
            }
            Err(err) => {
                error!("Failed to delete pod {}/{}: {}", namespace, name, err);
                Err(SerializableKubeError::from(err))
            }
        }
    }

    #[tauri::command]
    pub async fn list_deployments(
        context: &str,
        namespace: &str,
        kube_config: Option<String>,
    ) -> Result<Vec<Deployment>, SerializableKubeError> {
        let client = client_with_context(context, kube_config.as_deref()).await?;
        let deployment_api: Api<Deployment> = api_all_or_namespaced(client, namespace);

        return deployment_api
            .list(&ListParams::default())
            .await
            .map(|deployments| deployments.items)
            .map_err(|err| SerializableKubeError::from(err));
    }

    #[tauri::command]
    pub async fn restart_deployment(
        context: &str,
        namespace: &str,
        name: &str,
        kube_config: Option<String>,
    ) -> Result<bool, SerializableKubeError> {
        debug!("Restarting deployment {}/{}", namespace, name);
        let client = client_with_context(context, kube_config.as_deref()).await?;
        let deployment_api: Api<Deployment> = Api::namespaced(client, namespace);

        match deployment_api.restart(name).await {
            Ok(_) => {
                info!("Successfully restarted deployment {}/{}", namespace, name);
                Ok(true)
            }
            Err(err) => {
                error!("Failed to restart deployment {}/{}: {}", namespace, name, err);
                Err(SerializableKubeError::from(err))
            }
        }
    }

    #[tauri::command]
    pub async fn restart_statefulset(
        context: &str,
        namespace: &str,
        name: &str,
        kube_config: Option<String>,
    ) -> Result<bool, SerializableKubeError> {
        debug!("Restarting statefulset {}/{}", namespace, name);
        let client = client_with_context(context, kube_config.as_deref()).await?;
        let statefulset_api: Api<StatefulSet> = Api::namespaced(client, namespace);

        match statefulset_api.restart(name).await {
            Ok(_) => {
                info!("Successfully restarted statefulset {}/{}", namespace, name);
                Ok(true)
            }
            Err(err) => {
                error!("Failed to restart statefulset {}/{}: {}", namespace, name, err);
                Err(SerializableKubeError::from(err))
            }
        }
    }

    #[tauri::command]
    pub async fn list_services(
        context: &str,
        namespace: &str,
        kube_config: Option<String>,
    ) -> Result<Vec<Service>, SerializableKubeError> {
        let client = client_with_context(context, kube_config.as_deref()).await?;
        let services_api: Api<Service> = api_all_or_namespaced(client, namespace);

        return services_api
            .list(&ListParams::default())
            .await
            .map(|services| services.items)
            .map_err(|err| SerializableKubeError::from(err));
    }

    #[tauri::command]
    pub async fn list_jobs(
        context: &str,
        namespace: &str,
        kube_config: Option<String>,
    ) -> Result<Vec<Job>, SerializableKubeError> {
        let client = client_with_context(context, kube_config.as_deref()).await?;
        let jobs_api: Api<Job> = api_all_or_namespaced(client, namespace);

        return jobs_api
            .list(&ListParams::default())
            .await
            .map(|jobs| jobs.items)
            .map_err(|err| SerializableKubeError::from(err));
    }

    #[tauri::command]
    pub async fn list_cronjobs(
        context: &str,
        namespace: &str,
        kube_config: Option<String>,
    ) -> Result<Vec<CronJob>, SerializableKubeError> {
        let client = client_with_context(context, kube_config.as_deref()).await?;
        let cronjobs_api: Api<CronJob> = api_all_or_namespaced(client, namespace);

        return cronjobs_api
            .list(&ListParams::default())
            .await
            .map(|cronjobs| cronjobs.items)
            .map_err(|err| SerializableKubeError::from(err));
    }

    #[tauri::command]
    pub async fn list_configmaps(
        context: &str,
        namespace: &str,
        kube_config: Option<String>,
    ) -> Result<Vec<ConfigMap>, SerializableKubeError> {
        let client: Client = client_with_context(context, kube_config.as_deref()).await?;
        let configmaps_api: Api<ConfigMap> = api_all_or_namespaced(client, namespace);

        return configmaps_api
            .list(&ListParams::default())
            .await
            .map(|configmaps| configmaps.items)
            .map_err(|err| SerializableKubeError::from(err));
    }

    #[tauri::command]
    pub async fn list_secrets(
        context: &str,
        namespace: &str,
        kube_config: Option<String>,
    ) -> Result<Vec<Secret>, SerializableKubeError> {
        let client: Client = client_with_context(context, kube_config.as_deref()).await?;
        let secrets_api: Api<Secret> = api_all_or_namespaced(client, namespace);

        return secrets_api
            .list(&ListParams::default())
            .await
            .map(|secrets| secrets.items)
            .map_err(|err| SerializableKubeError::from(err));
    }

    #[tauri::command]
    pub async fn list_ingresses(
        context: &str,
        namespace: &str,
        kube_config: Option<String>,
    ) -> Result<Vec<Ingress>, SerializableKubeError> {
        let client: Client = client_with_context(context, kube_config.as_deref()).await?;
        let ingress_api: Api<Ingress> = api_all_or_namespaced(client, namespace);

        return ingress_api
            .list(&ListParams::default())
            .await
            .map(|ingresses| ingresses.items)
            .map_err(|err| SerializableKubeError::from(err));
    }

    #[tauri::command]
    pub async fn list_persistentvolumes(
        context: &str,
        kube_config: Option<String>,
    ) -> Result<Vec<PersistentVolume>, SerializableKubeError> {
        debug!("Listing persistent volumes in context {}", context);
        let client: Client = client_with_context(context, kube_config.as_deref()).await?;
        let pv_api: Api<PersistentVolume> = Api::all(client);

        let pvs = pv_api.list(&ListParams::default()).await.map_err(|err| {
            error!("Failed to list persistent volumes: {}", err);
            SerializableKubeError::from(err)
        })?;

        info!("Found {} persistent volumes", pvs.items.len());
        Ok(pvs.items)
    }

    #[tauri::command]
    pub async fn list_persistentvolumeclaims(
        context: &str,
        namespace: &str,
        kube_config: Option<String>,
    ) -> Result<Vec<PersistentVolumeClaim>, SerializableKubeError> {
        let client: Client = client_with_context(context, kube_config.as_deref()).await?;
        let pvc_api: Api<PersistentVolumeClaim> = api_all_or_namespaced(client, namespace);

        return pvc_api
            .list(&ListParams::default())
            .await
            .map(|pvcs| pvcs.items)
            .map_err(|err| SerializableKubeError::from(err));
    }

    #[tauri::command]
    pub async fn replace_pod(
        context: &str,
        namespace: &str,
        name: &str,
        object: Pod,
        kube_config: Option<String>,
    ) -> Result<Pod, SerializableKubeError> {
        debug!("Replacing pod {}/{}", namespace, name);
        let client = client_with_context(context, kube_config.as_deref()).await?;
        let pod_api: Api<Pod> = Api::namespaced(client, namespace);

        let pod = pod_api.replace(name, &Default::default(), &object).await.map_err(|err| {
            error!("Failed to replace pod {}/{}: {}", namespace, name, err);
            SerializableKubeError::from(err)
        })?;

        info!("Successfully replaced pod {}/{}", namespace, name);
        Ok(pod)
    }

    async fn log_resource_operation<T: std::fmt::Debug>(
        resource_type: &str,
        namespace: &str,
        name: &str,
        operation: &str,
        result: Result<T, Error>,
    ) -> Result<T, SerializableKubeError> {
        match result {
            Ok(resource) => {
                info!("Successfully {}d {} {}/{}", operation, resource_type, namespace, name);
                Ok(resource)
            }
            Err(err) => {
                error!("Failed to {} {} {}/{}: {}", operation, resource_type, namespace, name, err);
                Err(SerializableKubeError::from(err))
            }
        }
    }

    // Resource replace operations with logging
    macro_rules! impl_replace_resource {
        ($name:ident, $type:ty, $resource_name:expr) => {
            #[tauri::command]
            pub async fn $name(
                context: &str,
                namespace: &str,
                name: &str,
                object: $type,
                kube_config: Option<String>,
            ) -> Result<$type, SerializableKubeError> {
                debug!("Replacing {} {}/{}", $resource_name, namespace, name);
                let client = client_with_context(context, kube_config.as_deref()).await?;
                let api: Api<$type> = Api::namespaced(client, namespace);

                let result = api.replace(name, &Default::default(), &object).await;
                log_resource_operation($resource_name, namespace, name, "replace", result).await
            }
        };
    }

    // Implement replace operations for various resources
    impl_replace_resource!(replace_deployment, Deployment, "deployment");
    impl_replace_resource!(replace_job, Job, "job");
    impl_replace_resource!(replace_cronjob, CronJob, "cronjob");
    impl_replace_resource!(replace_configmap, ConfigMap, "configmap");
    impl_replace_resource!(replace_secret, Secret, "secret");
    impl_replace_resource!(replace_service, Service, "service");
    impl_replace_resource!(replace_ingress, Ingress, "ingress");
    impl_replace_resource!(replace_persistentvolumeclaim, PersistentVolumeClaim, "persistent volume claim");

    #[tauri::command]
    pub async fn get_core_api_versions(
        context: &str,
        kube_config: Option<String>,
    ) -> Result<Vec<String>, SerializableKubeError> {
        debug!("Fetching core API versions for context {}", context);
        let client = client_with_context(context, kube_config.as_deref()).await?;

        let versions = client.list_core_api_versions().await.map_err(|err| {
            error!("Failed to list core API versions: {}", err);
            SerializableKubeError::from(err)
        })?;

        info!("Found {} core API versions", versions.versions.len());
        trace!("Available core API versions: {:?}", versions.versions);
        Ok(versions.versions)
    }

    #[tauri::command]
    pub async fn get_core_api_resources(
        context: &str,
        core_api_version: &str,
        kube_config: Option<String>,
    ) -> Result<Vec<APIResource>, SerializableKubeError> {
        debug!("Fetching core API resources for version {} in context {}", core_api_version, context);
        let client = client_with_context(context, kube_config.as_deref()).await?;

        let resources = client.list_core_api_resources(core_api_version).await.map_err(|err| {
            error!("Failed to list core API resources for version {}: {}", core_api_version, err);
            SerializableKubeError::from(err)
        })?;

        info!("Found {} core API resources for version {}", resources.resources.len(), core_api_version);
        Ok(resources.resources)
    }

    #[tauri::command]
    pub async fn get_api_groups(
        context: &str,
        kube_config: Option<String>,
    ) -> Result<Vec<APIGroup>, SerializableKubeError> {
        debug!("Fetching API groups for context {}", context);
        let client = client_with_context(context, kube_config.as_deref()).await?;

        let groups = client.list_api_groups().await.map_err(|err| {
            error!("Failed to list API groups: {}", err);
            SerializableKubeError::from(err)
        })?;

        info!("Found {} API groups", groups.groups.len());
        Ok(groups.groups)
    }

    #[tauri::command]
    pub async fn get_api_group_resources(
        context: &str,
        api_group_version: &str,
        kube_config: Option<String>,
    ) -> Result<Vec<APIResource>, SerializableKubeError> {
        debug!("Fetching API resources for group version {} in context {}", api_group_version, context);
        let client = client_with_context(context, kube_config.as_deref()).await?;

        let resources = client.list_api_group_resources(api_group_version).await.map_err(|err| {
            error!("Failed to list API resources for group version {}: {}", api_group_version, err);
            SerializableKubeError::from(err)
        })?;

        info!("Found {} API resources for group version {}", resources.resources.len(), api_group_version);
        Ok(resources.resources)
    }

    #[tauri::command]
    pub async fn trigger_cronjob(
        context: &str,
        namespace: &str,
        name: &str,
        kube_config: Option<String>,
    ) -> Result<Job, SerializableKubeError> {
        debug!("Triggering manual run of cronjob {}/{}", namespace, name);
        let mut client = client_with_context(context, kube_config.as_deref()).await?;

        let cronjob_api: Api<CronJob> = Api::namespaced(client.clone(), namespace);
        let selected_cronjob = cronjob_api.get(name).await.map_err(|err| {
            error!("Failed to get cronjob {}/{}: {}", namespace, name, err);
            SerializableKubeError::from(err)
        })?;

        let Some(cronjob_spec) = selected_cronjob.spec else {
            let err = SerializableKubeError {
                message: format!("Cronjob {}/{} has no spec", namespace, name),
                code: None,
                reason: Some("InvalidCronjobSpec".to_string()),
                details: None,
            };
            error!("{}", err.message);
            return Err(err);
        };

        let job_spec = cronjob_spec.job_template.spec;
        let jobname = {
            let ext = rand::distributions::Alphanumeric.sample_string(&mut rand::thread_rng(), 3);
            format!("{}-manual-{}", name, ext.to_lowercase())
        };

        debug!("Creating manual job {} from cronjob {}", jobname, name);
        let manual_job = Job {
            metadata: ObjectMeta {
                name: Some(jobname.clone()),
                namespace: Some(namespace.into()),
                ..Default::default()
            },
            spec: job_spec,
            status: None,
        };

        client = cronjob_api.into_client();
        let job_api: Api<Job> = Api::namespaced(client, namespace);

        let job = job_api.create(&PostParams::default(), &manual_job).await.map_err(|err| {
            error!("Failed to create manual job {} from cronjob {}: {}", jobname, name, err);
            SerializableKubeError::from(err)
        })?;

        info!("Successfully created manual job {} from cronjob {}", jobname, name);
        Ok(job)
    }

    /// Clears the cached kube client so the next API call rebuilds it. This is
    /// needed after an interactive exec-plugin login (kubelogin / oidc-login)
    /// completes: the cached client still holds the old, expired token.
    fn clear_cached_client() {
        lock(&CLIENTS).clear();
        info!("Cleared cached kube client after auth re-login");
    }

    /// Serialized result of running an exec credential plugin (kubelogin,
    /// `kubectl oidc-login`, gke-gcloud-auth-plugin, ...). The plugin's stdout
    /// is the machine readable ExecCredential (a bearer token / client key)
    /// and is never returned; `stdout` is only filled when the plugin printed
    /// something that is not a credential. stderr usually contains the
    /// human-readable device-code / browser instructions.
    #[derive(Serialize)]
    pub struct ExecAuthOutput {
        pub command: String,
        pub stdout: String,
        pub stderr: String,
    }

    /// Runs the exec credential plugin configured for a context so the user can
    /// complete an interactive OIDC login (device code / browser flow).
    ///
    /// The plugin may block while waiting for the user to finish logging in, so
    /// this command has a generous timeout (3 minutes). It returns the plugin's
    /// stderr (and non-credential stdout) so the UI can show the device-code
    /// URL and code.
    #[tauri::command]
    pub async fn login_exec_auth(
        context: &str,
        kube_config: &str,
    ) -> Result<ExecAuthOutput, SerializableKubeError> {
        debug!("Running exec credential plugin for context: {}", context);

        let config = Kubeconfig::read_from(kube_config)
            .map_err(SerializableKubeError::from)?;

        let auth_info = auth_info_for_context(&config, context)?;

        let exec = auth_info.exec.ok_or_else(|| SerializableKubeError {
            message: "This context does not use an exec credential plugin".to_string(),
            code: None,
            reason: Some("NoExecPlugin".to_string()),
            details: None,
        })?;

        let command = exec.command.clone().ok_or_else(|| SerializableKubeError {
            message: "Exec credential plugin is missing its command".to_string(),
            code: None,
            reason: Some("NoExecPluginCommand".to_string()),
            details: None,
        })?;

        let mut cmd = Command::new(&command);
        if let Some(args) = &exec.args {
            cmd.args(args);
        }
        if let Some(envs) = &exec.env {
            let envs: HashMap<&str, &str> = envs
                .iter()
                .filter_map(|env| match (env.get("name"), env.get("value")) {
                    (Some(name), Some(value)) => Some((name.as_str(), value.as_str())),
                    _ => None,
                })
                .collect();
            cmd.envs(envs);
        }

        // On Windows, spawning a console-subsystem binary from a GUI app
        // allocates a visible console window unless suppressed (issue #70).
        #[cfg(windows)]
        cmd.creation_flags(0x08000000);

        // Without this the plugin survives the timeout below (the future is
        // dropped, the process is not) and keeps its callback port bound, so
        // every retry fails until the orphan exits.
        cmd.kill_on_drop(true);

        let output = tokio::time::timeout(Duration::from_secs(3 * 60), cmd.output())
            .await
            .map_err(|_| SerializableKubeError {
                message: format!(
                    "The exec credential plugin '{}' timed out after 3 minutes. Complete the login and try again.",
                    command
                ),
                code: None,
                reason: Some("ExecAuthTimeout".to_string()),
                details: None,
            })?
            .map_err(|e| SerializableKubeError {
                message: format!("Unable to run exec credential plugin '{}': {}", command, e),
                code: None,
                reason: Some("ExecAuthStart".to_string()),
                details: None,
            })?;

        // The plugin may have refreshed/rotated the token on disk, so drop the
        // cached client - the next API call will rebuild it and pick up the
        // fresh credentials.
        clear_cached_client();

        Ok(ExecAuthOutput {
            command,
            stdout: displayable_exec_stdout(&String::from_utf8_lossy(&output.stdout)),
            stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        })
    }

    #[derive(Debug, Clone, Copy, PartialEq, Deserialize)]
    #[serde(rename_all = "lowercase")]
    pub enum ManifestMode {
        Apply,
        Replace,
    }

    /// Builds the kubectl arguments for `apply_manifest`. Values are passed in
    /// `--flag=value` form so a value starting with `-` can't be parsed as a
    /// separate flag. `dry_run` adds `--dry-run=server`: the API server runs
    /// validation and admission (webhooks included) without persisting.
    fn manifest_args(
        mode: ManifestMode,
        context: &str,
        namespace: &str,
        kube_config: Option<&str>,
        dry_run: bool,
    ) -> Vec<String> {
        let mut args = vec![
            match mode {
                ManifestMode::Apply => "apply",
                ManifestMode::Replace => "replace",
            }
            .to_string(),
            format!("--context={}", context),
        ];
        if !namespace.is_empty() {
            args.push(format!("--namespace={}", namespace));
        }
        if let Some(kube_config) = kube_config.filter(|k| !k.is_empty()) {
            args.push(format!("--kubeconfig={}", kube_config));
        }
        if dry_run {
            args.push("--dry-run=server".to_string());
        }
        args.push("--filename=-".to_string());
        args
    }

    /// Runs `kubectl apply|replace -f -` with `manifest` piped over stdin, so
    /// edited objects (which may be Secrets) never have to be written to a
    /// world-readable temp file. Returns kubectl's stdout.
    #[tauri::command]
    pub async fn apply_manifest(
        context: &str,
        namespace: &str,
        manifest: String,
        mode: ManifestMode,
        kube_config: Option<String>,
        dry_run: Option<bool>,
    ) -> Result<String, String> {
        let dry_run = dry_run.unwrap_or(false);
        // Same kubeconfig the API client of this context uses (the selected
        // one when the frontend passes none / "").
        let kube_config = resolve_kubeconfig_path(kube_config.as_deref());
        let args = manifest_args(mode, context, namespace, Some(&kube_config), dry_run);
        debug!("Running kubectl {:?} (dry run: {}) with manifest on stdin", mode, dry_run);

        let mut cmd = Command::new("kubectl");
        cmd.args(&args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);

        #[cfg(windows)]
        cmd.creation_flags(0x08000000);

        let mut child = cmd.spawn().map_err(|e| format!("Unable to run kubectl: {}", e))?;

        // Feed stdin while draining stdout/stderr, all under one timeout: a
        // kubectl that stalls before reading its input (unreachable API server,
        // exec plugin waiting for a login) must not hang this command, and
        // kill_on_drop ends the process when the timeout drops the future.
        let stdin = child.stdin.take();
        let write_manifest = async move {
            match stdin {
                Some(mut stdin) => stdin.write_all(manifest.as_bytes()).await,
                None => Ok(()),
            }
            // Dropping stdin closes the pipe so kubectl sees EOF.
        };
        let (write_result, output) = tokio::time::timeout(
            Duration::from_secs(2 * 60),
            async { tokio::join!(write_manifest, child.wait_with_output()) },
        )
        .await
        .map_err(|_| "kubectl timed out after 2 minutes".to_string())?;
        let output = output.map_err(|e| e.to_string())?;

        // Prefer kubectl's own error over a broken-pipe from an early exit.
        if output.status.success() {
            if let Err(e) = write_result {
                return Err(format!("Failed to pass manifest to kubectl: {}", e));
            }
        }

        if output.status.success() {
            Ok(String::from_utf8_lossy(&output.stdout).into_owned())
        } else {
            let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
            error!("kubectl {:?} failed: {}", mode, stderr);
            Err(stderr)
        }
    }

    #[tauri::command]
    pub async fn run_kubectl(args: Vec<String>) -> Result<String, String> {
        let mut cmd = Command::new("kubectl");
        cmd.args(&args);

        // On Windows, spawning a console-subsystem binary (kubectl, and via it
        // exec-auth plugins like aws/gke-gcloud-auth-plugin/kubelogin) from a GUI
        // app allocates a visible console window for EVERY call unless suppressed.
        // Several views poll kubectl on an interval, so this opens dozens of
        // terminal windows at once (issue #70). CREATE_NO_WINDOW (0x08000000)
        // keeps the child attached to a hidden console.
        #[cfg(windows)]
        cmd.creation_flags(0x08000000);

        // A hung kubectl (unreachable API server, exec plugin waiting for an
        // interactive login) must not block callers forever: the polling views
        // skip refreshes while a fetch is in flight. kill_on_drop terminates the
        // process when the timeout drops the future.
        cmd.kill_on_drop(true);
        let output = tokio::time::timeout(Duration::from_secs(2 * 60), cmd.output())
            .await
            .map_err(|_| "kubectl timed out after 2 minutes".to_string())?
            .map_err(|e| e.to_string())?;

        if output.status.success() {
            Ok(String::from_utf8_lossy(&output.stdout).into_owned())
        } else {
            Err(format!("kubectl failed: {}", String::from_utf8_lossy(&output.stderr)))
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        const KUBECONFIG: &str = r#"
apiVersion: v1
kind: Config
clusters:
- name: c
  cluster:
    server: https://example.invalid
contexts:
- name: aws
  context:
    cluster: c
    user: aws-user
- name: token
  context:
    cluster: c
    user: token-user
- name: broken
users:
- name: aws-user
  user:
    exec:
      apiVersion: client.authentication.k8s.io/v1beta1
      command: aws
      args: ["eks", "get-token"]
      env:
      - name: AWS_PROFILE
        value: dev
      - name: AWS_SECRET_ACCESS_KEY
        value: super-secret
- name: token-user
  user:
    token: bearer-secret
    client-key-data: a2V5
"#;

        #[test]
        fn auth_summary_contains_no_secrets() {
            let config = Kubeconfig::from_yaml(KUBECONFIG).unwrap();

            let summary = summarize_auth_info(&auth_info_for_context(&config, "aws").unwrap());
            assert_eq!(
                summary,
                ContextAuthSummary {
                    exec_command: Some("aws".to_string()),
                    aws_profile: Some("dev".to_string()),
                }
            );
            let json = serde_json::to_string(&summary).unwrap();
            assert!(!json.contains("super-secret"));

            let summary = summarize_auth_info(&auth_info_for_context(&config, "token").unwrap());
            assert_eq!(summary, ContextAuthSummary::default());
        }

        #[test]
        fn missing_context_or_context_body_is_an_error_not_a_panic() {
            let config = Kubeconfig::from_yaml(KUBECONFIG).unwrap();
            assert!(auth_info_for_context(&config, "nope").is_err());
            assert!(auth_info_for_context(&config, "broken").is_err());
        }

        #[test]
        fn exec_credentials_are_never_displayed() {
            let credential = r#"{"apiVersion":"client.authentication.k8s.io/v1beta1","kind":"ExecCredential","status":{"token":"abc"}}"#;
            assert_eq!(displayable_exec_stdout(credential), "");
            assert_eq!(displayable_exec_stdout("{\"token\": \"abc\""), "");
            assert_eq!(
                displayable_exec_stdout("  Open https://login.example/device and enter ABCD\n"),
                "Open https://login.example/device and enter ABCD"
            );
        }

        #[test]
        fn manifest_args_use_flag_value_form() {
            assert_eq!(
                manifest_args(ManifestMode::Replace, "-ctx", "ns", Some("/tmp/kc"), false),
                vec![
                    "replace",
                    "--context=-ctx",
                    "--namespace=ns",
                    "--kubeconfig=/tmp/kc",
                    "--filename=-",
                ]
            );
            assert_eq!(
                manifest_args(ManifestMode::Apply, "ctx", "", None, false),
                vec!["apply", "--context=ctx", "--filename=-"]
            );
            assert_eq!(
                manifest_args(ManifestMode::Replace, "ctx", "", None, true),
                vec!["replace", "--context=ctx", "--dry-run=server", "--filename=-"]
            );
        }

        #[test]
        fn explicit_kubeconfig_path_is_the_only_stamped_file() {
            assert_eq!(
                kubeconfig_files("/some/kubeconfig"),
                vec![std::path::PathBuf::from("/some/kubeconfig")]
            );
            assert_eq!(kubeconfig_stamp("/definitely/not/here"), None);
        }

        #[test]
        fn client_slot_is_shared_until_the_kubeconfig_changes() {
            let key = ("/test/slot".to_string(), "ctx".to_string());
            let t1 = SystemTime::UNIX_EPOCH + Duration::from_secs(1);
            let t2 = SystemTime::UNIX_EPOCH + Duration::from_secs(2);

            let a = client_slot(key.clone(), Some(t1));
            let b = client_slot(key.clone(), Some(t1));
            assert!(Arc::ptr_eq(&a, &b));

            let c = client_slot(key, Some(t2));
            assert!(!Arc::ptr_eq(&a, &c));
        }
    }
}

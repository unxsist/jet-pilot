pub mod client {
    use either::Either;
    use k8s_openapi::api::apps::v1::Deployment;
    use k8s_openapi::api::batch::v1::{CronJob, Job};
    use k8s_openapi::api::core::v1::{
        ConfigMap, Namespace, PersistentVolumeClaim, Pod, Secret, Service,
    };
    use k8s_openapi::api::networking::v1::Ingress;
    use k8s_openapi::apimachinery::pkg::apis::meta::v1::{APIGroup, APIResource};
    use kube::api::{DeleteParams, ListParams, ObjectMeta, PostParams};
    use kube::config::{KubeConfigOptions, Kubeconfig, KubeconfigError, NamedContext};
    use kube::{api::Api, Client, Config, Error};
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

    use crate::auth::broker::{self, CredentialKey};
    use crate::auth::center::{self, AuthErrorInfo, AuthErrorKind, AuthFailure, IssueSource};
    use crate::auth::classify::command_basename;
    use crate::auth::layer::{BrokerTokenLayer, ClientTarget, ObserveLayer};
    use crate::util::lock;
    use k8s_openapi::jiff::{SignedDuration, Timestamp};
    use kube::client::ClientBuilder;

    #[cfg(windows)]
    use std::os::windows::process::CommandExt;

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
        pub(crate) details: Option<String>,
        /// Set when the error is a credential problem of a context (sign-in
        /// needed, expired, rejected, plugin missing / failed / too slow).
        /// Absent otherwise.
        /// Boxed: keeps the error (returned by every command) small.
        #[serde(skip_serializing_if = "Option::is_none")]
        pub(crate) auth: Option<Box<AuthErrorInfo>>,
    }

    impl From<Error> for SerializableKubeError {
        fn from(error: Error) -> Self {
            match &error {
                // Debug output of exec failures includes the plugin's stdout
                // (the credential).
                Error::Auth(auth_error) => error!("Kubernetes auth error occurred: {}", auth_error_message(auth_error)),
                _ => error!("Kubernetes API error occurred: {:?}", error),
            }

            if let Some(failure) = AuthFailure::of_kube_error(&error) {
                return SerializableKubeError::from(failure.clone());
            }

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
                        auth: None,
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
                        auth: None,
                    }
                }
                _ => {
                    return SerializableKubeError {
                        message: error.to_string(),
                        code: None,
                        reason: None,
                        details: None,
                        auth: None,
                    };
                }
            }
        }
    }

    /// A credential failure of a client (broker errors).
    impl From<AuthFailure> for SerializableKubeError {
        fn from(failure: AuthFailure) -> Self {
            SerializableKubeError {
                message: failure.message,
                code: None,
                reason: Some(failure.info.kind.reason().to_string()),
                details: None,
                auth: Some(Box::new(failure.info)),
            }
        }
    }

    /// Fills in `auth` for errors of `context` that are credential problems
    /// but don't know their context: 401 responses and kube-rs' own exec
    /// plugin errors (broker disabled).
    pub(crate) fn with_auth_context(mut err: SerializableKubeError, kube_config: &str, context: &str) -> SerializableKubeError {
        if err.auth.is_some() {
            return err;
        }
        let kind = if err.code == Some(401) {
            AuthErrorKind::Unauthorized
        } else if err.reason.as_deref() == Some("ExecAuthFailed") {
            match center::detect_kubectl_auth_failure(&err.message) {
                Some(AuthErrorKind::ExecFailed) | None => {
                    if err.message.starts_with("Unable to run the Kubernetes exec credential plugin") {
                        AuthErrorKind::ExecMissing
                    } else {
                        AuthErrorKind::ExecFailed
                    }
                }
                Some(kind) => kind,
            }
        } else {
            return err;
        };
        err.auth = Some(Box::new(AuthErrorInfo {
            kube_config: kube_config.to_string(),
            context: context.to_string(),
            kind,
            command: exec_command_for_context(Some(kube_config), context),
        }));
        err
    }

    /// An API error of `context`: `SerializableKubeError::from` plus the auth
    /// context of 401s.
    fn api_error(err: Error, kube_config: Option<&str>, context: &str) -> SerializableKubeError {
        with_auth_context(SerializableKubeError::from(err), &resolve_kubeconfig_path(kube_config), context)
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

    /// Kubeconfig errors keep only a safe summary: the YAML parser's message
    /// quotes file contents, which can include tokens and keys.
    impl From<KubeconfigError> for SerializableKubeError {
        fn from(error: KubeconfigError) -> Self {
            let message = crate::kubeconfig_discovery::read_error_message(&error);
            error!("Kubeconfig error occurred: {}", message);

            SerializableKubeError {
                message,
                code: None,
                reason: None,
                details: None,
                auth: None,
            }
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
            auth: None,
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

    /// A client whose credentials (a client certificate from an exec plugin)
    /// expire within this is rebuilt.
    const CLIENT_EXPIRY_MARGIN: SignedDuration = SignedDuration::from_secs(60);

    fn credentials_expiring(client: &Client) -> bool {
        client
            .valid_until()
            .is_some_and(|until| until <= Timestamp::now() + CLIENT_EXPIRY_MARGIN)
    }

    /// Returns the cache slot for `key`, replacing it when the kubeconfig
    /// changed on disk since the slot was created or the client's
    /// credentials (`Client::valid_until`) are about to expire.
    fn client_slot(key: (String, String), stamp: Option<SystemTime>) -> Arc<OnceCell<Client>> {
        let mut clients = lock(&CLIENTS);
        match clients.get(&key) {
            Some(cached) if cached.stamp == stamp && !cached.cell.get().is_some_and(credentials_expiring) => {
                cached.cell.clone()
            }
            _ => {
                let cell = Arc::new(OnceCell::new());
                clients.insert(key, CachedClient { stamp, cell: cell.clone() });
                cell
            }
        }
    }

    /// Drops the cached clients of (resolved kubeconfig path, context) pairs:
    /// the next call builds new ones (after a sign-in).
    pub(crate) fn invalidate_clients(targets: &[(String, String)]) {
        let mut clients = lock(&CLIENTS);
        for target in targets {
            clients.remove(target);
        }
    }

    /// The kubeconfig paths of the cached clients ("" = default resolution).
    pub(crate) fn cached_kubeconfig_paths() -> Vec<String> {
        let mut paths: Vec<String> = lock(&CLIENTS).keys().map(|(path, _)| path.clone()).collect();
        paths.sort();
        paths.dedup();
        paths
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
            error!("Failed to read kubeconfig: {}", crate::kubeconfig_discovery::read_error_message(&err));
            SerializableKubeError::from(err)
        })?;

        let context = config.current_context.ok_or_else(|| SerializableKubeError {
            message: "No current context set in kubeconfig".to_string(),
            code: None,
            reason: Some("NoCurrentContext".to_string()),
            details: None,
            auth: None,
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
            error!("Failed to read kubeconfig from path: {}", crate::kubeconfig_discovery::read_error_message(&err));
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
                auth: None,
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
                auth: None,
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

    /// The kubeconfig of `kube_config` (None / "" = the selected one, else
    /// kube's default resolution), like the API clients use it.
    pub(crate) fn read_kubeconfig(kube_config: Option<&str>) -> Result<Kubeconfig, KubeconfigError> {
        let path = resolve_kubeconfig_path(kube_config);
        if path.is_empty() {
            Kubeconfig::read()
        } else {
            Kubeconfig::read_from(path.as_str())
        }
    }

    /// The exec credential plugin command (basename) a context authenticates
    /// with, if any. Used to word watch auth errors like kubectl does
    /// ("executable aws failed") so the frontend's re-login detection works.
    pub(crate) fn exec_command_for_context(kube_config: Option<&str>, context: &str) -> Option<String> {
        let config = read_kubeconfig(kube_config).ok()?;
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
        kube_config: Option<String>,
    ) -> Result<ContextAuthSummary, SerializableKubeError> {
        let config = read_kubeconfig(kube_config.as_deref()).map_err(SerializableKubeError::from)?;

        let auth_info = auth_info_for_context(&config, context)?;
        Ok(summarize_auth_info(&auth_info))
    }

    /// The kubeconfig user of `context` ("" when it has none).
    fn context_user(config: &Kubeconfig, context: &str) -> String {
        config
            .contexts
            .iter()
            .find(|c| c.name == context)
            .and_then(|c| c.context.as_ref())
            .and_then(|c| c.user.clone())
            .unwrap_or_default()
    }

    /// A failed `ClientBuilder::try_from`. With the broker disabled kube-rs
    /// runs exec plugins in there: those failures are auth issues.
    fn client_build_error(err: Error, target: &ClientTarget) -> SerializableKubeError {
        let missing = matches!(
            &err,
            Error::Auth(kube::client::AuthError::AuthExecStart(io)) if io.kind() == std::io::ErrorKind::NotFound
        );
        if !matches!(err, Error::Auth(_)) {
            error!("Failed to create Kubernetes client: {}", err);
        }
        let mut err = with_auth_context(SerializableKubeError::from(err), &target.kube_config, &target.context);
        if let Some(auth) = err.auth.as_mut() {
            if missing {
                auth.kind = AuthErrorKind::ExecMissing;
            }
            center::report_failure(
                &AuthFailure {
                    info: (**auth).clone(),
                    message: err.message.clone(),
                },
                center::current_source(),
            );
        }
        err
    }

    /// Builds the client of `context`. Exec credentials come from the
    /// credential broker (unless disabled): the plugin is taken out of the
    /// config so kube-rs never runs it, tokens are added per request by
    /// `BrokerTokenLayer`, client certificates become the TLS identity with
    /// the client's `valid_until`. Every client reports 401s
    /// (`ObserveLayer`).
    async fn build_client(context: &str, kubeconfig_path: &str) -> Result<Client, SerializableKubeError> {
        debug!("Creating client for context: {}", context);
        let options = KubeConfigOptions {
            context: Some(context.to_string()),
            cluster: None,
            user: None,
        };

        let kubeconfig = if !kubeconfig_path.is_empty() {
            debug!("Using custom kubeconfig path");
            Kubeconfig::read_from(kubeconfig_path)
        } else {
            debug!("Using default kubeconfig path");
            Kubeconfig::read()
        }
        .map_err(|err| {
            error!("Failed to read kubeconfig: {}", crate::kubeconfig_discovery::read_error_message(&err));
            SerializableKubeError::from(err)
        })?;
        let user = context_user(&kubeconfig, context);
        let mut client_config = Config::from_custom_kubeconfig(kubeconfig, &options).await.map_err(|err| {
            error!("Failed to create config from kubeconfig: {}", crate::kubeconfig_discovery::read_error_message(&err));
            SerializableKubeError::from(err)
        })?;

        let target = ClientTarget {
            kube_config: kubeconfig_path.to_string(),
            context: context.to_string(),
            command: client_config
                .auth_info
                .exec
                .as_ref()
                .and_then(|exec| exec.command.as_deref())
                .map(command_basename)
                .filter(|command| !command.is_empty()),
        };
        let exec = if broker::enabled() {
            broker::take_exec(&mut client_config.auth_info)
        } else {
            None
        };

        let client = match exec {
            None => ClientBuilder::try_from(client_config)
                .map_err(|err| client_build_error(err, &target))?
                .with_layer(&ObserveLayer::new(target.clone(), None))
                .build(),
            Some(exec) => {
                let slot = broker::slot(&CredentialKey::new(kubeconfig_path, &user, &exec));
                let credential = broker::credential_in(&slot, &exec, broker::BACKGROUND_TIMEOUT)
                    .await
                    .map_err(|err| {
                        let failure = err.to_failure(kubeconfig_path, context);
                        center::report_failure(&failure, center::current_source());
                        error!("Credentials for context {} unavailable: {:?}", context, err.kind());
                        SerializableKubeError::from(failure)
                    })?;
                let valid_until = broker::apply_client_certificate(&mut client_config.auth_info, &credential);
                let builder = ClientBuilder::try_from(client_config)
                    .map_err(|err| client_build_error(err, &target))?
                    .with_valid_until(valid_until);
                let observe = ObserveLayer::new(target.clone(), Some(slot.clone()));
                if credential.token.is_some() {
                    builder
                        .with_layer(&BrokerTokenLayer::new(slot, exec, target.clone()))
                        .with_layer(&observe)
                        .build()
                } else {
                    builder.with_layer(&observe).build()
                }
            }
        };

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
                error!("Invalid kubeconfig provided: {}", crate::kubeconfig_discovery::read_error_message(&err));
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
            api_error(err, kube_config.as_deref(), context)
        })?;

        info!("Found {} namespaces", namespaces.items.len());
        Ok(namespaces.items)
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
                Err(api_error(err, kube_config.as_deref(), context))
            }
        }
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
            api_error(err, kube_config.as_deref(), context)
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
        kube_config: Option<&str>,
        context: &str,
    ) -> Result<T, SerializableKubeError> {
        match result {
            Ok(resource) => {
                info!("Successfully {}d {} {}/{}", operation, resource_type, namespace, name);
                Ok(resource)
            }
            Err(err) => {
                error!("Failed to {} {} {}/{}: {}", operation, resource_type, namespace, name, err);
                Err(api_error(err, kube_config, context))
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
                log_resource_operation($resource_name, namespace, name, "replace", result, kube_config.as_deref(), context).await
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
            api_error(err, kube_config.as_deref(), context)
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
            api_error(err, kube_config.as_deref(), context)
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
            api_error(err, kube_config.as_deref(), context)
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
            api_error(err, kube_config.as_deref(), context)
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
            api_error(err, kube_config.as_deref(), context)
        })?;

        let Some(cronjob_spec) = selected_cronjob.spec else {
            let err = SerializableKubeError {
                message: format!("Cronjob {}/{} has no spec", namespace, name),
                code: None,
                reason: Some("InvalidCronjobSpec".to_string()),
                details: None,
                auth: None,
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
            api_error(err, kube_config.as_deref(), context)
        })?;

        info!("Successfully created manual job {} from cronjob {}", jobname, name);
        Ok(job)
    }

    /// Clears the cached kube clients so the next API call rebuilds them. This
    /// is needed after an interactive exec-plugin login (kubelogin /
    /// oidc-login) completes: the cached clients still hold the old, expired
    /// token. Also used when the credential broker is switched on or off.
    pub(crate) fn clear_client_cache() {
        lock(&CLIENTS).clear();
        info!("Cleared cached kube clients");
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
            error!("kubectl {:?} failed: {}", mode, center::redact(&stderr));
            center::report_kubectl_failure(&kube_config, context, IssueSource::Kubectl, &stderr);
            Err(stderr)
        }
    }

    /// The `--kubeconfig` and `--context` of a kubectl argv (`--flag=value`
    /// or `--flag value`).
    fn kubectl_target(args: &[String]) -> (Option<String>, Option<String>) {
        let mut kube_config = None;
        let mut context = None;
        let mut iter = args.iter();
        while let Some(arg) = iter.next() {
            for (flag, slot) in [("--kubeconfig", &mut kube_config), ("--context", &mut context)] {
                if arg == flag {
                    *slot = iter.next().cloned();
                    break;
                } else if let Some(value) = arg.strip_prefix(flag).and_then(|rest| rest.strip_prefix('=')) {
                    *slot = Some(value.to_string());
                    break;
                }
            }
        }
        (kube_config, context)
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
            let stderr = String::from_utf8_lossy(&output.stderr);
            if let (kube_config, Some(context)) = kubectl_target(&args) {
                let kube_config = resolve_kubeconfig_path(kube_config.as_deref());
                center::report_kubectl_failure(&kube_config, &context, IssueSource::Kubectl, &stderr);
            }
            Err(format!("kubectl failed: {}", stderr))
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

        #[test]
        fn kubectl_targets_are_read_from_args() {
            let args = |a: &[&str]| a.iter().map(|s| s.to_string()).collect::<Vec<_>>();
            assert_eq!(
                kubectl_target(&args(&["get", "pods", "--context", "prod", "--kubeconfig=/kc"])),
                (Some("/kc".to_string()), Some("prod".to_string()))
            );
            assert_eq!(
                kubectl_target(&args(&["--context=dev", "get", "ns"])),
                (None, Some("dev".to_string()))
            );
            assert_eq!(kubectl_target(&args(&["--contexts", "x"])), (None, None));
        }

        #[test]
        fn auth_context_is_added_to_401s_only() {
            let unauthorized = SerializableKubeError {
                message: "Unauthorized".into(),
                code: Some(401),
                reason: Some("Unauthorized".into()),
                details: None,
                auth: None,
            };
            let err = with_auth_context(unauthorized, "/kc", "ctx");
            let auth = err.auth.as_ref().unwrap();
            assert_eq!(auth.kind, AuthErrorKind::Unauthorized);
            assert_eq!(auth.context, "ctx");
            let json = serde_json::to_value(&err).unwrap();
            assert_eq!(json["auth"]["kind"], "unauthorized");
            assert_eq!(json["auth"]["kubeConfig"], "/kc");

            let not_found = SerializableKubeError {
                message: "nope".into(),
                code: Some(404),
                reason: None,
                details: None,
                auth: None,
            };
            let err = with_auth_context(not_found, "/kc", "ctx");
            assert!(err.auth.is_none());
            // The field is absent (not null) when there is no auth problem.
            assert!(serde_json::to_value(&err).unwrap().get("auth").is_none());
        }

        #[cfg(unix)]
        mod broker_clients {
            use super::*;
            use crate::auth::broker::tests::{script, token_credential, TEST_CERT, TEST_KEY};
            use crate::auth::center::{with_source, EMITTED};
            use tokio::io::AsyncReadExt;
            use tokio::net::TcpListener;

            /// An API server answering `/version` for `Bearer good-token`
            /// and 401 otherwise. Records the Authorization headers.
            async fn fake_api() -> (String, Arc<Mutex<Vec<String>>>) {
                let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
                let url = format!("http://{}", listener.local_addr().unwrap());
                let seen = Arc::new(Mutex::new(Vec::new()));
                let headers = seen.clone();
                tokio::spawn(async move {
                    loop {
                        let Ok((mut socket, _)) = listener.accept().await else { return };
                        let headers = headers.clone();
                        tokio::spawn(async move {
                            let mut buffer = Vec::new();
                            let mut chunk = [0u8; 4096];
                            loop {
                                let Some(end) = buffer.windows(4).position(|w| w == b"\r\n\r\n") else {
                                    match socket.read(&mut chunk).await {
                                        Ok(0) | Err(_) => return,
                                        Ok(n) => buffer.extend_from_slice(&chunk[..n]),
                                    }
                                    continue;
                                };
                                let head = String::from_utf8_lossy(&buffer[..end]).into_owned();
                                buffer.drain(..end + 4);
                                let authorization = head
                                    .lines()
                                    .find_map(|l| l.strip_prefix("authorization: ").or_else(|| l.strip_prefix("Authorization: ")))
                                    .unwrap_or("")
                                    .to_string();
                                lock(&headers).push(authorization.clone());
                                let (code, body) = if authorization == "Bearer good-token" {
                                    (200, r#"{"major":"1","minor":"31","gitVersion":"v1.31.2","gitCommit":"","gitTreeState":"","buildDate":"","goVersion":"","compiler":"","platform":""}"#)
                                } else {
                                    (401, r#"{"kind":"Status","apiVersion":"v1","status":"Failure","message":"Unauthorized","reason":"Unauthorized","code":401}"#)
                                };
                                let response = format!(
                                    "HTTP/1.1 {code} X\r\ncontent-type: application/json\r\ncontent-length: {}\r\n\r\n{body}",
                                    body.len()
                                );
                                if tokio::io::AsyncWriteExt::write_all(&mut socket, response.as_bytes()).await.is_err() {
                                    return;
                                }
                            }
                        });
                    }
                });
                (url, seen)
            }

            fn kubeconfig(dir: &std::path::Path, server: &str, plugin: &std::path::Path) -> String {
                let path = dir.join("kubeconfig.yaml");
                std::fs::write(
                    &path,
                    format!(
                        "apiVersion: v1\nkind: Config\nclusters:\n- name: c\n  cluster:\n    server: {server}\ncontexts:\n- name: ctx\n  context:\n    cluster: c\n    user: u\nusers:\n- name: u\n  user:\n    exec:\n      apiVersion: client.authentication.k8s.io/v1beta1\n      command: {}\n",
                        plugin.display()
                    ),
                )
                .unwrap();
                path.to_string_lossy().into_owned()
            }

            #[tokio::test]
            async fn tokens_come_from_the_broker_per_request() {
                let (server, seen) = fake_api().await;
                let dir = tempfile::tempdir().unwrap();
                let counter = dir.path().join("runs");
                let plugin = script(
                    dir.path(),
                    "plugin",
                    &format!("echo run >> '{}'\necho '{}'\n", counter.display(), token_credential("good-token", Some(3600))),
                );
                let path = kubeconfig(dir.path(), &server, &plugin);
                let client = build_client("ctx", &path).await.unwrap();
                assert_eq!(client.apiserver_version().await.unwrap().git_version, "v1.31.2");
                client.apiserver_version().await.unwrap();
                assert_eq!(lock(&seen).as_slice(), ["Bearer good-token", "Bearer good-token"]);
                // One plugin run: built once, then cached.
                assert_eq!(std::fs::read_to_string(&counter).unwrap().lines().count(), 1);
                assert!(client.valid_until().is_none());
            }

            #[tokio::test]
            async fn rejected_tokens_are_reported_with_their_source() {
                let (server, _) = fake_api().await;
                let dir = tempfile::tempdir().unwrap();
                let plugin = script(dir.path(), "plugin", &format!("echo '{}'\n", token_credential("bad-token", Some(3600))));
                let path = kubeconfig(dir.path(), &server, &plugin);
                let client = build_client("ctx", &path).await.unwrap();
                let err = with_source(IssueSource::Metrics, client.apiserver_version()).await.unwrap_err();
                let err = api_error(err, Some(&path), "ctx");
                assert_eq!(err.code, Some(401));
                assert_eq!(err.auth.as_ref().unwrap().kind, AuthErrorKind::Unauthorized);
                let issue = lock(&EMITTED)
                    .iter()
                    .find(|i| i.kube_config == path && i.kind == AuthErrorKind::Unauthorized)
                    .cloned()
                    .expect("401 reported");
                assert_eq!(issue.source, IssueSource::Metrics);
                assert_eq!(issue.command.as_deref(), Some("plugin"));
            }

            #[tokio::test]
            async fn plugins_wanting_a_sign_in_fail_the_build_fast() {
                let dir = tempfile::tempdir().unwrap();
                let plugin = script(
                    dir.path(),
                    "kubelogin",
                    "echo 'To sign in, use a web browser to open the page https://microsoft.com/devicelogin and enter the code ABCD12345 to authenticate.' >&2\nsleep 300\n",
                );
                let path = kubeconfig(dir.path(), "http://127.0.0.1:9", &plugin);
                let started = std::time::Instant::now();
                let Err(err) = build_client("ctx", &path).await else {
                    panic!("the client must not be built");
                };
                assert!(started.elapsed() < Duration::from_secs(5));
                assert_eq!(err.reason.as_deref(), Some("InteractionRequired"));
                let auth = err.auth.as_ref().unwrap();
                assert_eq!(auth.kind, AuthErrorKind::InteractionRequired);
                assert_eq!(auth.command.as_deref(), Some("kubelogin"));
                assert!(err.message.contains("executable kubelogin"), "{}", err.message);
                assert!(lock(&EMITTED)
                    .iter()
                    .any(|i| i.kube_config == path && i.kind == AuthErrorKind::InteractionRequired));
            }

            #[tokio::test]
            async fn client_certificates_set_valid_until_and_expiring_clients_are_rebuilt() {
                let dir = tempfile::tempdir().unwrap();
                let json = dir.path().join("cred.json");
                std::fs::write(
                    &json,
                    serde_json::json!({
                        "apiVersion": "client.authentication.k8s.io/v1beta1",
                        "kind": "ExecCredential",
                        "status": {
                            "clientCertificateData": TEST_CERT,
                            "clientKeyData": TEST_KEY,
                            "expirationTimestamp": "2030-01-01T00:00:00Z"
                        }
                    })
                    .to_string(),
                )
                .unwrap();
                let plugin = script(dir.path(), "certs", &format!("cat '{}'\n", json.display()));
                let path = kubeconfig(dir.path(), "http://127.0.0.1:9", &plugin);
                let client = build_client("ctx", &path).await.unwrap();
                assert_eq!(client.valid_until().map(|t| t.as_second()), Some(1_893_456_000));

                // A cached client whose credentials expire is replaced.
                let key = (path.clone(), "expiring".to_string());
                let stamp = Some(SystemTime::UNIX_EPOCH);
                let first = client_slot(key.clone(), stamp);
                let expiring = client.clone().with_valid_until(Some(Timestamp::now() + SignedDuration::from_secs(30)));
                assert!(first.set(expiring).is_ok());
                let second = client_slot(key.clone(), stamp);
                assert!(!Arc::ptr_eq(&first, &second));
                assert!(second.set(client).is_ok());
                assert!(Arc::ptr_eq(&second, &client_slot(key.clone(), stamp)));

                invalidate_clients(std::slice::from_ref(&key));
                assert!(!Arc::ptr_eq(&second, &client_slot(key, stamp)));
            }
        }
    }
}

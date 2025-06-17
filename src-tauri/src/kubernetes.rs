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
    use kube::config::{KubeConfigOptions, Kubeconfig, KubeconfigError, NamedAuthInfo, NamedContext};
    use kube::{api::Api, Client, Config, Error};
    use rand::distributions::DistString;
    use serde::Serialize;
    use std::sync::Mutex;
    use tracing::{debug, error, info, trace, warn};
    use tokio::process::Command;
    use std::io;


    #[derive(Serialize)]
    pub enum DeletionResult {
        Deleted(String),
        Pending(String),
    }

    #[derive(Debug, Serialize)]
    pub struct SerializableKubeError {
        message: String,
        code: Option<u16>,
        reason: Option<String>,
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

    static CURRENT_CONTEXT: Mutex<Option<String>> = Mutex::new(Some(String::new()));
    static CURRENT_KUBECONFIG: Mutex<Option<String>> = Mutex::new(None);
    static CLIENT: Mutex<Option<Client>> = Mutex::new(None);

    #[tauri::command]
    pub async fn get_current_context() -> Result<String, SerializableKubeError> {
        debug!("Retrieving current Kubernetes context");
        let config = Kubeconfig::read().map_err(|err| {
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
    pub async fn list_contexts() -> Result<Vec<NamedContext>, SerializableKubeError> {
        debug!("Listing available Kubernetes contexts");
        let kubeconfig = {
            let kubeconfig_guard = CURRENT_KUBECONFIG.lock().unwrap();
            kubeconfig_guard.as_ref().ok_or_else(|| {
                error!("No kubeconfig has been set");
                SerializableKubeError {
                    message: "No kubeconfig has been set".to_string(),
                    code: None,
                    reason: Some("NoKubeconfig".to_string()),
                    details: None,
                } 
            })?.clone()
        };

        let config = Kubeconfig::read_from(kubeconfig.as_str()).map_err(|err| {
            error!("Failed to read kubeconfig from path: {}", err);
            SerializableKubeError::from(err)
        })?;

        info!("Found {} contexts", config.contexts.len());
        trace!("Available contexts: {:?}", config.contexts); 
        Ok(config.contexts)
    }

    #[tauri::command]
    pub async fn get_context_auth_info(
        context: &str,
        kube_config: &str,
    ) -> Result<NamedAuthInfo, SerializableKubeError> {
        let config = Kubeconfig::read_from(kube_config.to_string())
            .map_err(|err| SerializableKubeError::from(err))?;

        let context_auth_info = config
            .contexts
            .iter()
            .find(|c| c.name == context)
            .map(|c| c.clone().context.unwrap().user.clone())
            .ok_or(SerializableKubeError {
                message: "Context not found".to_string(),
                code: None,
                reason: None,
                details: None,
            })?;

        let auth_info = config
            .auth_infos
            .iter()
            .find(|a| a.name == context_auth_info)
            .ok_or(SerializableKubeError {
                message: "Auth info not found".to_string(),
                code: None,
                reason: None,
                details: None,
            })?;

        return Ok(auth_info.clone());
    }

    async fn one_off_client_with_context(
        context: &str,
        kube_config: &str,
    ) -> Result<Client, SerializableKubeError> {
        debug!("Creating one-off client for context: {}", context);
        let options = KubeConfigOptions {
            context: Some(context.to_string()),
            cluster: None,
            user: None,
        };

        let kubeconfig = Kubeconfig::read_from(kube_config.to_string()).map_err(|err| {
            error!("Failed to read kubeconfig for context {}: {}", context, err);
            SerializableKubeError::from(err)
        })?;
        
        let client_config = Config::from_custom_kubeconfig(kubeconfig, &options).await.map_err(|err| {
            error!("Failed to create client config for context {}: {}", context, err);
            SerializableKubeError::from(err)
        })?;

        let client = Client::try_from(client_config).map_err(|err| {
            error!("Failed to create client for context {}: {}", context, err);
            SerializableKubeError::from(err)
        })?;

        debug!("Successfully created one-off client for context: {}", context);
        Ok(client)
    }

    async fn client_with_context(context: &str) -> Result<Client, SerializableKubeError> {
        debug!("Getting or creating client for context: {}", context);
        
        let current_context = CURRENT_CONTEXT.lock().unwrap().as_ref().unwrap().clone();
        if context.to_string() != current_context {
            debug!("Context switch detected: {} -> {}", current_context, context);
            let options = KubeConfigOptions {
                context: Some(context.to_string()),
                cluster: None,
                user: None,
            };

            let current_kubeconfig = CURRENT_KUBECONFIG.lock().unwrap().clone();
            let client_config = match current_kubeconfig {
                Some(kubeconfig) if !kubeconfig.is_empty() => {
                    debug!("Using custom kubeconfig path");
                    let kubeconfig = Kubeconfig::read_from(kubeconfig.clone()).map_err(|err| {
                        error!("Failed to read custom kubeconfig: {}", err);
                        SerializableKubeError::from(err)
                    })?;
                    Config::from_custom_kubeconfig(kubeconfig, &options).await.map_err(|err| {
                        error!("Failed to create config from custom kubeconfig: {}", err);
                        SerializableKubeError::from(err)
                    })?
                }
                _ => {
                    debug!("Using default kubeconfig path");
                    Config::from_kubeconfig(&options).await.map_err(|err| {
                        error!("Failed to create config from default kubeconfig: {}", err);
                        SerializableKubeError::from(err)
                    })?
                }
            };

            let client = Client::try_from(client_config).map_err(|err| {
                error!("Failed to create Kubernetes client: {}", err);
                SerializableKubeError::from(err)
            })?;

            CURRENT_CONTEXT.lock().unwrap().replace(context.to_string());
            CLIENT.lock().unwrap().replace(client);
            info!("Successfully switched to context: {}", context);
        }

        Ok(CLIENT.lock().unwrap().clone().unwrap())
    }

    #[tauri::command]
    pub async fn set_current_kubeconfig(kube_config: &str) -> Result<(), SerializableKubeError> {
        debug!("Setting current kubeconfig path");
        
        // Validate the kubeconfig can be read before setting it
        match Kubeconfig::read_from(kube_config.to_string()) {
            Ok(_) => {
                CURRENT_KUBECONFIG.lock().unwrap().replace(kube_config.to_string());
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
        kube_config: &str,
    ) -> Result<Vec<Namespace>, SerializableKubeError> {
        debug!("Listing namespaces for context: {}", context);
        let client = one_off_client_with_context(context, kube_config).await?;
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
    ) -> Result<Vec<Pod>, SerializableKubeError> {
        debug!("Listing pods in namespace {} for context: {}", namespace, context);
        trace!("Using selectors - label: {}, field: {}", label_selector, field_selector);
        
        let client = client_with_context(context).await?;
        let pod_api: Api<Pod> = Api::namespaced(client, namespace);

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
    ) -> Result<Vec<PodMetrics>, SerializableKubeError> {
        debug!("Fetching pod metrics for namespace {} in context {}", namespace, context);
        let client = client_with_context(context).await?;
        let metrics_api: Api<PodMetrics> = Api::namespaced(client, namespace);

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
    ) -> Result<PodMetrics, SerializableKubeError> {
        debug!("Fetching metrics for pod {}/{}", namespace, name);
        let client = client_with_context(context).await?;
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
    ) -> Result<Pod, SerializableKubeError> {
        let client = client_with_context(context).await?;
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
    ) -> Result<DeletionResult, SerializableKubeError> {
        debug!("Deleting pod {}/{} with grace period {}s", namespace, name, grace_period_seconds);
        let client = client_with_context(context).await?;
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
    ) -> Result<Vec<Deployment>, SerializableKubeError> {
        let client = client_with_context(context).await?;
        let deployment_api: Api<Deployment> = Api::namespaced(client, namespace);

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
    ) -> Result<bool, SerializableKubeError> {
        debug!("Restarting deployment {}/{}", namespace, name);
        let client = client_with_context(context).await?;
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
    ) -> Result<bool, SerializableKubeError> {
        debug!("Restarting statefulset {}/{}", namespace, name);
        let client = client_with_context(context).await?;
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
    ) -> Result<Vec<Service>, SerializableKubeError> {
        let client = client_with_context(context).await?;
        let services_api: Api<Service> = Api::namespaced(client, namespace);

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
    ) -> Result<Vec<Job>, SerializableKubeError> {
        let client = client_with_context(context).await?;
        let jobs_api: Api<Job> = Api::namespaced(client, namespace);

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
    ) -> Result<Vec<CronJob>, SerializableKubeError> {
        let client = client_with_context(context).await?;
        let cronjobs_api: Api<CronJob> = Api::namespaced(client, namespace);

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
    ) -> Result<Vec<ConfigMap>, SerializableKubeError> {
        let client: Client = client_with_context(context).await?;
        let configmaps_api: Api<ConfigMap> = Api::namespaced(client, namespace);

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
    ) -> Result<Vec<Secret>, SerializableKubeError> {
        let client: Client = client_with_context(context).await?;
        let secrets_api: Api<Secret> = Api::namespaced(client, namespace);

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
    ) -> Result<Vec<Ingress>, SerializableKubeError> {
        let client: Client = client_with_context(context).await?;
        let ingress_api: Api<Ingress> = Api::namespaced(client, namespace);

        return ingress_api
            .list(&ListParams::default())
            .await
            .map(|ingresses| ingresses.items)
            .map_err(|err| SerializableKubeError::from(err));
    }

    #[tauri::command]
    pub async fn list_persistentvolumes(
        context: &str,
    ) -> Result<Vec<PersistentVolume>, SerializableKubeError> {
        debug!("Listing persistent volumes in context {}", context);
        let client: Client = client_with_context(context).await?;
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
    ) -> Result<Vec<PersistentVolumeClaim>, SerializableKubeError> {
        let client: Client = client_with_context(context).await?;
        let pvc_api: Api<PersistentVolumeClaim> = Api::namespaced(client, namespace);

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
    ) -> Result<Pod, SerializableKubeError> {
        debug!("Replacing pod {}/{}", namespace, name);
        let client = client_with_context(context).await?;
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
            ) -> Result<$type, SerializableKubeError> {
                debug!("Replacing {} {}/{}", $resource_name, namespace, name);
                let client = client_with_context(context).await?;
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
    ) -> Result<Vec<String>, SerializableKubeError> {
        debug!("Fetching core API versions for context {}", context);
        let client = client_with_context(context).await?;

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
    ) -> Result<Vec<APIResource>, SerializableKubeError> {
        debug!("Fetching core API resources for version {} in context {}", core_api_version, context);
        let client = client_with_context(context).await?;

        let resources = client.list_core_api_resources(core_api_version).await.map_err(|err| {
            error!("Failed to list core API resources for version {}: {}", core_api_version, err);
            SerializableKubeError::from(err)
        })?;

        info!("Found {} core API resources for version {}", resources.resources.len(), core_api_version);
        Ok(resources.resources)
    }

    #[tauri::command]
    pub async fn get_api_groups(context: &str) -> Result<Vec<APIGroup>, SerializableKubeError> {
        debug!("Fetching API groups for context {}", context);
        let client = client_with_context(context).await?;

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
    ) -> Result<Vec<APIResource>, SerializableKubeError> {
        debug!("Fetching API resources for group version {} in context {}", api_group_version, context);
        let client = client_with_context(context).await?;

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
    ) -> Result<Job, SerializableKubeError> {
        debug!("Triggering manual run of cronjob {}/{}", namespace, name);
        let mut client = client_with_context(context).await?;

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

    #[tauri::command]
    pub async fn run_kubectl(args: Vec<String>) -> Result<String, String> {
        let output = Command::new("kubectl")
            .args(&args)
            .output()
            .await
            .map_err(|e| e.to_string())?;
        
        if output.status.success() {
            Ok(String::from_utf8_lossy(&output.stdout).into_owned())
        } else {
            Err(format!("kubectl failed: {}", String::from_utf8_lossy(&output.stderr)))
        }
    }
}

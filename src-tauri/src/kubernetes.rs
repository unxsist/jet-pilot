pub mod client {
    use either::Either;
    use istio_api_rs::networking::v1beta1::virtual_service::VirtualService;
    use k8s_metrics::v1beta1::PodMetrics;
    use k8s_openapi::api::batch::v1::{CronJob, Job};
    use k8s_openapi::api::networking::v1::Ingress;
    use k8s_openapi::apimachinery::pkg::apis::meta::v1::{APIGroup, APIResource};
    use k8s_openapi::api::apps::v1::Deployment;
    use k8s_openapi::api::core::v1::{
        ConfigMap, Namespace, PersistentVolume, PersistentVolumeClaim, Pod, Secret, Service,
    };
    use kube::api::{DeleteParams, ListParams};
    use kube::config::{KubeConfigOptions, Kubeconfig, KubeconfigError, NamedAuthInfo};
    use kube::{api::Api, Client, Config, Error};
    use serde::Serialize;
    use std::
        sync::Mutex
    ;

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
            println!("Error: {:?}", error);

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
        let config = Kubeconfig::read().map_err(|err| SerializableKubeError::from(err))?;

        return Ok(config.current_context.expect("No current context"));
    }

    #[tauri::command]
    pub async fn list_contexts() -> Result<Vec<String>, SerializableKubeError> {
        let config = Kubeconfig::read_from(
            CURRENT_KUBECONFIG.lock().unwrap().as_ref().unwrap().as_str(),
        ).map_err(|err| SerializableKubeError::from(err))?;

        config
            .contexts
            .iter()
            .map(|context| {
                let name = context.name.clone();
                return Ok(name);
            })
            .collect()
    }

    #[tauri::command]
    pub async fn get_context_auth_info(context: &str, kube_config: &str) -> Result<NamedAuthInfo, SerializableKubeError> {
        let config = Kubeconfig::read_from(
            kube_config.to_string(),
        ).map_err(|err| SerializableKubeError::from(err))?;

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

    async fn one_off_client_with_context(context: &str, kube_config: &str) -> Result<Client, SerializableKubeError> {
        let options = KubeConfigOptions {
            context: Some(context.to_string()),
            cluster: None,
            user: None,
        };

        let kubeconfig = Kubeconfig::read_from(kube_config.to_string()).map_err(|err| SerializableKubeError::from(err))?;
        let client_config = Config::from_custom_kubeconfig(kubeconfig, &options)
            .await
            .map_err(|err| SerializableKubeError::from(err))?;

        let client = Client::try_from(client_config).map_err(|err| SerializableKubeError::from(err))?;

        return Ok(client);
    }

    async fn client_with_context(context: &str) -> Result<Client, SerializableKubeError> {
        if context.to_string() != CURRENT_CONTEXT.lock().unwrap().as_ref().unwrap().clone() {
            let options = KubeConfigOptions {
                context: Some(context.to_string()),
                cluster: None,
                user: None,
            };

            let current_kubeconfig = CURRENT_KUBECONFIG.lock().unwrap().clone();
            let client_config = match current_kubeconfig {
                Some(kubeconfig) if !kubeconfig.is_empty() => {
                    let kubeconfig = Kubeconfig::read_from(kubeconfig.clone()).map_err(|err| SerializableKubeError::from(err))?;
                    Config::from_custom_kubeconfig(kubeconfig, &options)
                        .await
                        .map_err(|err| SerializableKubeError::from(err))?
                },
                _ => {
                    Config::from_kubeconfig(&options)
                        .await
                        .map_err(|err| SerializableKubeError::from(err))?
                },
            };

            let client =
                Client::try_from(client_config).map_err(|err| SerializableKubeError::from(err))?;

            CURRENT_CONTEXT.lock().unwrap().replace(context.to_string());
            CLIENT.lock().unwrap().replace(client);
        }

        return Ok(CLIENT.lock().unwrap().clone().unwrap());
    }

    #[tauri::command]
    pub async fn set_current_kubeconfig(kube_config: &str) -> Result<(), SerializableKubeError> {
        CURRENT_KUBECONFIG.lock().unwrap().replace(kube_config.to_string());
        return Ok(());
    }

    #[tauri::command]
    pub async fn list_namespaces(context: &str, kube_config: &str) -> Result<Vec<Namespace>, SerializableKubeError> {
        let client = one_off_client_with_context(context, kube_config).await?;
        let namespace_api: Api<Namespace> = Api::all(client);

        return namespace_api
            .list(&ListParams::default())
            .await
            .map(|namespaces| namespaces.items)
            .map_err(|err| SerializableKubeError::from(err));
    }

    #[tauri::command]
    pub async fn list_pods(
        context: &str,
        namespace: &str,
        label_selector: &str,
        field_selector: &str,
    ) -> Result<Vec<Pod>, SerializableKubeError> {
        let client = client_with_context(context).await?;
        let pod_api: Api<Pod> = Api::namespaced(client, namespace);

        return pod_api
            .list(
                &ListParams::default()
                    .labels(label_selector)
                    .fields(field_selector),
            )
            .await
            .map(|pods| pods.items)
            .map_err(|err| SerializableKubeError::from(err));
    }


    #[tauri::command]
    pub async fn get_pod_metrics(context: &str, namespace: &str) -> Result<Vec<PodMetrics>, SerializableKubeError> {
        let client = client_with_context(context).await?;
        let metrics_api : Api<PodMetrics> = Api::namespaced(client, namespace);

        return metrics_api
            .list(&ListParams::default())
            .await
            .map(|metrics| metrics.items)
            .map_err(|err| SerializableKubeError::from(err));
    }

    #[tauri::command]
    pub async fn get_pod(context: &str, namespace: &str, name: &str) -> Result<Pod, SerializableKubeError> {
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
        let client = client_with_context(context).await?;
        let pod_api: Api<Pod> = Api::namespaced(client, namespace);

        match pod_api
            .delete(
                name,
                &DeleteParams::default().grace_period(grace_period_seconds),
            )
            .await
        {
            Ok(Either::Left(_pod)) => Ok(DeletionResult::Deleted(name.to_string())),
            Ok(Either::Right(_status)) => {
                Ok(DeletionResult::Pending("Deletion in progress".to_string()))
            }
            Err(err) => Err(SerializableKubeError::from(err)),
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
        let client = client_with_context(context).await?;
        let deployment_api: Api<Deployment> = Api::namespaced(client, namespace);

        return deployment_api
            .restart(name)
            .await
            .map(|_deployment| true)
            .map_err(|err| SerializableKubeError::from(err));
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
    pub async fn list_jobs(context: &str, namespace: &str) -> Result<Vec<Job>, SerializableKubeError> {
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
    pub async fn list_virtual_services(
        context: &str,
        namespace: &str,
    ) -> Result<Vec<VirtualService>, SerializableKubeError> {
        let client: Client = client_with_context(context).await?;
        let virtual_services_api: Api<VirtualService> = Api::namespaced(client, namespace);

        return virtual_services_api
            .list(&ListParams::default())
            .await
            .map(|virtual_services| virtual_services.items)
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
        let client: Client = client_with_context(context).await?;
        let pv_api: Api<PersistentVolume> = Api::all(client);

        return pv_api
            .list(&ListParams::default())
            .await
            .map(|pvs| pvs.items)
            .map_err(|err| SerializableKubeError::from(err));
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
        let client = client_with_context(context).await?;
        let pod_api: Api<Pod> = Api::namespaced(client, namespace);

        return pod_api
            .replace(name, &Default::default(), &object)
            .await
            .map(|pod| pod.clone())
            .map_err(|err| SerializableKubeError::from(err));
    }

    #[tauri::command]
    pub async fn replace_deployment(
        context: &str,
        namespace: &str,
        name: &str,
        object: Deployment,
    ) -> Result<Deployment, SerializableKubeError> {
        let client = client_with_context(context).await?;
        let deployment_api: Api<Deployment> = Api::namespaced(client, namespace);

        return deployment_api
            .replace(name, &Default::default(), &object)
            .await
            .map(|deployment| deployment.clone())
            .map_err(|err| SerializableKubeError::from(err));
    }

    #[tauri::command]
    pub async fn replace_job(
        context: &str,
        namespace: &str,
        name: &str,
        object: Job,
    ) -> Result<Job, SerializableKubeError> {
        let client = client_with_context(context).await?;
        let job_api: Api<Job> = Api::namespaced(client, namespace);

        return job_api
            .replace(name, &Default::default(), &object)
            .await
            .map(|job| job.clone())
            .map_err(|err| SerializableKubeError::from(err));
    }

    #[tauri::command]
    pub async fn replace_cronjob(
        context: &str,
        namespace: &str,
        name: &str,
        object: CronJob,
    ) -> Result<CronJob, SerializableKubeError> {
        let client = client_with_context(context).await?;
        let cronjob_api: Api<CronJob> = Api::namespaced(client, namespace);

        return cronjob_api
            .replace(name, &Default::default(), &object)
            .await
            .map(|cronjob| cronjob.clone())
            .map_err(|err| SerializableKubeError::from(err));
    }

    #[tauri::command]
    pub async fn replace_configmap(
        context: &str,
        namespace: &str,
        name: &str,
        object: ConfigMap,
    ) -> Result<ConfigMap, SerializableKubeError> {
        let client = client_with_context(context).await?;
        let configmap_api: Api<ConfigMap> = Api::namespaced(client, namespace);

        return configmap_api
            .replace(name, &Default::default(), &object)
            .await
            .map(|configmap| configmap.clone())
            .map_err(|err| SerializableKubeError::from(err));
    }

    #[tauri::command]
    pub async fn replace_secret(
        context: &str,
        namespace: &str,
        name: &str,
        object: Secret,
    ) -> Result<Secret, SerializableKubeError> {
        let client = client_with_context(context).await?;
        let secret_api: Api<Secret> = Api::namespaced(client, namespace);

        return secret_api
            .replace(name, &Default::default(), &object)
            .await
            .map(|secret| secret.clone())
            .map_err(|err| SerializableKubeError::from(err));
    }

    #[tauri::command]
    pub async fn replace_service(
        context: &str,
        namespace: &str,
        name: &str,
        object: Service,
    ) -> Result<Service, SerializableKubeError> {
        let client = client_with_context(context).await?;
        let service_api: Api<Service> = Api::namespaced(client, namespace);

        return service_api
            .replace(name, &Default::default(), &object)
            .await
            .map(|service| service.clone())
            .map_err(|err| SerializableKubeError::from(err));
    }

    #[tauri::command]
    pub async fn replace_virtualservice(
        context: &str,
        namespace: &str,
        name: &str,
        object: VirtualService,
    ) -> Result<VirtualService, SerializableKubeError> {
        let client = client_with_context(context).await?;
        let virtualservice_api: Api<VirtualService> = Api::namespaced(client, namespace);

        return virtualservice_api
            .replace(name, &Default::default(), &object)
            .await
            .map(|virtualservice| virtualservice.clone())
            .map_err(|err| SerializableKubeError::from(err));
    }

    #[tauri::command]
    pub async fn replace_ingress(
        context: &str,
        namespace: &str,
        name: &str,
        object: Ingress,
    ) -> Result<Ingress, SerializableKubeError> {
        let client = client_with_context(context).await?;
        let ingress_api: Api<Ingress> = Api::namespaced(client, namespace);

        return ingress_api
            .replace(name, &Default::default(), &object)
            .await
            .map(|ingress| ingress.clone())
            .map_err(|err| SerializableKubeError::from(err));
    }

    #[tauri::command]
    pub async fn replace_persistentvolumeclaim(
        context: &str,
        namespace: &str,
        name: &str,
        object: PersistentVolumeClaim,
    ) -> Result<PersistentVolumeClaim, SerializableKubeError> {
        let client = client_with_context(context).await?;
        let pvc_api: Api<PersistentVolumeClaim> = Api::namespaced(client, namespace);

        return pvc_api
            .replace(name, &Default::default(), &object)
            .await
            .map(|pvc: PersistentVolumeClaim| pvc.clone())
            .map_err(|err| SerializableKubeError::from(err));
    }

    #[tauri::command]
    pub async fn get_core_api_versions(context: &str) -> Result<Vec<String>, SerializableKubeError> {
        let client = client_with_context(context).await?;

        return client
            .list_core_api_versions()
            .await
            .map(|api_versions| api_versions.versions)
            .map_err(|err| SerializableKubeError::from(err));
    }

    #[tauri::command]
    pub async fn get_core_api_resources(
        context: &str,
        core_api_version: &str,
    ) -> Result<Vec<APIResource>, SerializableKubeError> {
        let client = client_with_context(context).await?;

        return client
            .list_core_api_resources(core_api_version)
            .await
            .map(|api_resources| api_resources.resources)
            .map_err(|err| SerializableKubeError::from(err));
    }

    #[tauri::command]
    pub async fn get_api_groups(context: &str) -> Result<Vec<APIGroup>, SerializableKubeError> {
        let client = client_with_context(context).await?;

        return client
            .list_api_groups()
            .await
            .map(|api_groups| api_groups.groups)
            .map_err(|err| SerializableKubeError::from(err));
    }

    #[tauri::command]
    pub async fn get_api_group_resources(
        context: &str,
        api_group_version: &str,
    ) -> Result<Vec<APIResource>, SerializableKubeError> {
        let client = client_with_context(context).await?;

        return client
            .list_api_group_resources(api_group_version)
            .await
            .map(|api_resources| api_resources.resources)
            .map_err(|err| SerializableKubeError::from(err));
    }
}
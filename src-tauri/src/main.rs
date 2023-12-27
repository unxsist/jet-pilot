// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use istio_sdk::networking::v1beta1::virtual_service::VirtualService;
use k8s_openapi::api::batch::v1::{CronJob, Job};
use k8s_openapi::api::networking::v1::Ingress;
use tauri::Manager;

use k8s_openapi::api::apps::v1::Deployment;
use k8s_openapi::api::core::v1::{
    ConfigMap, Namespace, PersistentVolume, PersistentVolumeClaim, Pod, Secret, Service,
};
use kube::api::ListParams;
use kube::config::{KubeConfigOptions, Kubeconfig, KubeconfigError};
use kube::{api::Api, Client, Config, Error};
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use serde::Serialize;
use std::collections::HashMap;
use std::ffi::OsString;
use std::{
    io::{BufRead, BufReader, Write},
    sync::{Arc, Mutex},
    thread::{self, sleep},
    time::Duration,
};
use uuid::Uuid;

#[derive(Debug, Serialize)]
struct SerializableKubeError {
    message: String,
    code: Option<u16>,
    reason: Option<String>,
    details: Option<String>,
}

impl From<Error> for SerializableKubeError {
    fn from(error: Error) -> Self {
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
static CLIENT: Mutex<Option<Client>> = Mutex::new(None);

#[tauri::command]
async fn get_current_context() -> Result<String, SerializableKubeError> {
    let config = Kubeconfig::read().map_err(|err| SerializableKubeError::from(err))?;

    return Ok(config.current_context.expect("No current context"));
}

#[tauri::command]
async fn list_contexts() -> Result<Vec<String>, SerializableKubeError> {
    let config = Kubeconfig::read().map_err(|err| SerializableKubeError::from(err))?;

    config
        .contexts
        .iter()
        .map(|context| {
            let name = context.name.clone();
            return Ok(name);
        })
        .collect()
}

async fn client_with_context(context: &str) -> Result<Client, SerializableKubeError> {
    if context.to_string() != CURRENT_CONTEXT.lock().unwrap().as_ref().unwrap().clone() {
        let options = KubeConfigOptions {
            context: Some(context.to_string()),
            cluster: None,
            user: None,
        };

        let client_config = Config::from_kubeconfig(&options)
            .await
            .map_err(|err| SerializableKubeError::from(err))?;
        let client =
            Client::try_from(client_config).map_err(|err| SerializableKubeError::from(err))?;

        CURRENT_CONTEXT.lock().unwrap().replace(context.to_string());
        CLIENT.lock().unwrap().replace(client);
    }

    return Ok(CLIENT.lock().unwrap().clone().unwrap());
}

#[tauri::command]
async fn list_namespaces(context: &str) -> Result<Vec<Namespace>, SerializableKubeError> {
    let client = client_with_context(context).await?;
    let namespace_api: Api<Namespace> = Api::all(client);

    return namespace_api
        .list(&ListParams::default())
        .await
        .map(|namespaces| namespaces.items)
        .map_err(|err| SerializableKubeError::from(err));
}

#[tauri::command]
async fn list_pods(
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
async fn get_pod(context: &str, namespace: &str, name: &str) -> Result<Pod, SerializableKubeError> {
    let client = client_with_context(context).await?;
    let pod_api: Api<Pod> = Api::namespaced(client, namespace);

    return pod_api
        .get(name)
        .await
        .map_err(|err| SerializableKubeError::from(err));
}

#[tauri::command]
async fn list_deployments(
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
async fn list_services(
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
async fn list_jobs(context: &str, namespace: &str) -> Result<Vec<Job>, SerializableKubeError> {
    let client = client_with_context(context).await?;
    let jobs_api: Api<Job> = Api::namespaced(client, namespace);

    return jobs_api
        .list(&ListParams::default())
        .await
        .map(|jobs| jobs.items)
        .map_err(|err| SerializableKubeError::from(err));
}

#[tauri::command]
async fn list_cronjobs(
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
async fn list_configmaps(
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
async fn list_secrets(
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
async fn list_virtual_services(
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
async fn list_ingresses(
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
async fn list_persistentvolumes(
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
async fn list_persistentvolumeclaims(
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

struct TerminalSession {
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
}

static TTY_SESSIONS: Mutex<Option<HashMap<String, TerminalSession>>> = Mutex::new(None);

#[tauri::command]
fn create_tty_session(app_handle: tauri::AppHandle, init_command: Vec<String>) -> String {
    if TTY_SESSIONS.lock().unwrap().is_none() {
        *TTY_SESSIONS.lock().unwrap() = Some(HashMap::new());
    }

    let pty_system = native_pty_system();
    let pty_pair = pty_system
        .openpty(PtySize {
            rows: 24,
            cols: 80,
            pixel_width: 0,
            pixel_height: 0,
        })
        .unwrap();

    // generate a random session id
    let session_id = Uuid::new_v4().to_string();
    let thread_session_id = session_id.clone();

    #[cfg(target_os = "windows")]
    let cmd = CommandBuilder::new("powershell.exe");
    #[cfg(not(target_os = "windows"))]
    let cmd = CommandBuilder::from_argv(
        init_command
            .into_iter()
            .map(|s| OsString::from(s))
            .collect(),
    );

    let mut child = pty_pair.slave.spawn_command(cmd).unwrap();
    thread::spawn(move || {
        child.wait().unwrap();
    });

    let reader = pty_pair.master.try_clone_reader().unwrap();
    let reader = Arc::new(Mutex::new(Some(BufReader::new(reader))));

    thread::spawn(move || {
        let reader = reader.lock().unwrap().take();
        let app = app_handle.clone();
        let session_id = thread_session_id.clone();
        if let Some(mut reader) = reader {
            loop {
                sleep(Duration::from_millis(1));
                let data = reader.fill_buf().unwrap().to_vec();
                reader.consume(data.len());
                if data.len() > 0 {
                    app.emit_all(format!("tty_data_{}", session_id).as_ref(), data)
                        .unwrap();
                }
            }
        }
    });

    let writer = pty_pair.master.take_writer().unwrap();
    TTY_SESSIONS.lock().unwrap().as_mut().unwrap().insert(
        session_id.clone(),
        TerminalSession {
            writer: Arc::new(Mutex::new(writer)),
        },
    );

    return session_id;
}

#[tauri::command]
fn stop_tty_session(session_id: &str) {
    // write to pty to kill the process, this can be a bash or powershell command
    write_to_pty(session_id, "exit\n");
}

#[tauri::command]
fn write_to_pty(session_id: &str, data: &str) {
    // First, lock the sessions map
    let sessions_lock = TTY_SESSIONS.lock().unwrap();

    // Then, try to get the session from the map
    if let Some(sessions) = sessions_lock.as_ref() {
        if let Some(session) = sessions.get(session_id) {
            // Lock the writer
            let mut writer_guard = session.writer.lock().unwrap();
            // Attempt to write and handle any error
            if let Err(_) = write!(&mut *writer_guard, "{}", data) {
                // Handle the error from the write! macro here
            }
        } else {
            // Handle the case when the session is not found
        }
    } else {
        // Handle the case when the TTY_SESSIONS map is not initialized
    }
}

fn main() {
    let _ = fix_path_env::fix();

    let ctx = tauri::generate_context!();
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            list_contexts,
            get_current_context,
            list_namespaces,
            list_pods,
            get_pod,
            list_deployments,
            list_jobs,
            list_cronjobs,
            list_configmaps,
            list_secrets,
            list_services,
            list_virtual_services,
            list_ingresses,
            list_persistentvolumes,
            list_persistentvolumeclaims,
            create_tty_session,
            stop_tty_session,
            write_to_pty
        ])
        .setup(|_app| {
            let _window = _app.get_window("main").unwrap();

            #[cfg(target_os = "macos")]
            {
                use tauri_nspanel::cocoa;
                use tauri_nspanel::cocoa::appkit::NSWindow;
                use tauri_nspanel::cocoa::appkit::NSWindowTitleVisibility;
                use tauri_nspanel::cocoa::base::BOOL;

                unsafe {
                    let id = _window.ns_window().unwrap() as cocoa::base::id;
                    id.setHasShadow_(BOOL::from(false));
                    id.setTitleVisibility_(NSWindowTitleVisibility::NSWindowTitleHidden);
                }
            }

            #[cfg(debug_assertions)]
            {
                _window.open_devtools();
            }

            Ok(())
        })
        .run(ctx)
        .expect("Error while starting JET Pilot");
}

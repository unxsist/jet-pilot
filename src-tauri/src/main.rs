// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::{menu::{AboutMetadataBuilder, MenuBuilder, MenuItemBuilder, SubmenuBuilder}, Emitter, Manager};
use tracing::Level;
use tracing::level_filters::LevelFilter;
use tracing_subscriber::{fmt, prelude::*, reload, Registry};
use once_cell::sync::Lazy;
use std::sync::{Arc, RwLock};

mod app_log;
mod kubernetes;
mod logs;
mod metrics;
mod manifest;
mod port_forward;
#[cfg(all(test, feature = "kwok-qa"))]
mod qa_kwok;
mod shell;
mod util;
mod watch;
mod workloads;

static RELOAD_HANDLE: Lazy<Arc<RwLock<reload::Handle<LevelFilter, Registry>>>> = Lazy::new(|| {
    let (_, reload_handle) = reload::Layer::new(LevelFilter::INFO);
    Arc::new(RwLock::new(reload_handle))
});

/// Returns the in-memory application log entries newer than `since` (a
/// sequence number from a previous call), or all retained entries when
/// omitted. The frontend polls this, so it must only ship new entries.
#[tauri::command]
fn get_logs(since: Option<u64>) -> Vec<app_log::LogEntry> {
    app_log::entries_since(since)
}

#[tauri::command]
fn update_log_level(level: String) -> Result<(), String> {
    let level = app_log::parse_level(&level)
        .ok_or_else(|| format!("Invalid log level: {}", level))?;

    util::read(&RELOAD_HANDLE)
        .modify(|filter| *filter = level.into())
        .map_err(|e| e.to_string())?;

    tracing::info!("Log level updated to: {:?}", level);
    Ok(())
}

#[tauri::command]
fn write_log(level: String, message: String) -> Result<(), String> {
    let level = app_log::parse_level(&level)
        .ok_or_else(|| format!("Invalid log level: {}", level))?;

    match level {
        Level::TRACE => tracing::trace!("{}", message),
        Level::DEBUG => tracing::debug!("{}", message),
        Level::INFO => tracing::info!("{}", message),
        Level::WARN => tracing::warn!("{}", message),
        Level::ERROR => tracing::error!("{}", message),
    }

    Ok(())
}

#[derive(Clone, serde::Serialize)]
struct CheckForUpdatesPayload {}

fn main() {
    let (filter, reload_handle) = reload::Layer::new(LevelFilter::INFO);
    let fmt_stdout = fmt::layer().with_writer(std::io::stdout);

    // The in-memory layer records level + message from the event metadata
    // (no formatting / ANSI codes); stdout keeps the regular fmt output.
    let subscriber = tracing_subscriber::registry()
        .with(filter)
        .with(app_log::MemoryLayer)
        .with(fmt_stdout);

    // Set the global subscriber
    tracing::subscriber::set_global_default(subscriber)
        .expect("Failed to set subscriber");

    // Store the new reload handle
    *util::write(&RELOAD_HANDLE) = reload_handle;

    let _ = fix_path_env::fix();

    // Temporary terminal kubeconfigs contain flattened credentials: remove
    // the ones a crashed previous run left behind.
    shell::tty::sweep_stale_temp_kubeconfigs();

    let ctx = tauri::generate_context!();

    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_http::init());

    let app = builder
        .invoke_handler(tauri::generate_handler![
            update_log_level,
            write_log,
            get_logs,
            kubernetes::client::set_current_kubeconfig,
            kubernetes::client::list_contexts,
            kubernetes::client::get_context_auth_info,
            kubernetes::client::login_exec_auth,
            kubernetes::client::get_current_context,
            kubernetes::client::list_namespaces,
            kubernetes::client::get_core_api_versions,
            kubernetes::client::get_core_api_resources,
            kubernetes::client::get_api_groups,
            kubernetes::client::get_api_group_resources,
            kubernetes::client::delete_pod,
            kubernetes::client::replace_pod,
            kubernetes::client::replace_deployment,
            kubernetes::client::replace_job,
            kubernetes::client::replace_cronjob,
            kubernetes::client::replace_configmap,
            kubernetes::client::replace_secret,
            kubernetes::client::replace_service,
            kubernetes::client::replace_ingress,
            kubernetes::client::replace_persistentvolumeclaim,
            kubernetes::client::trigger_cronjob,
            kubernetes::client::run_kubectl,
            kubernetes::client::apply_manifest,
            port_forward::start_port_forward,
            port_forward::stop_port_forward,
            port_forward::list_port_forwards,
            shell::tty::create_tty_session,
            shell::tty::stop_tty_session,
            shell::tty::write_to_pty,
            shell::tty::resize_pty,
            shell::tty::create_local_terminal_session,
            logs::structured_logging::start_structured_logging_session,
            logs::structured_logging::repurpose_structured_logging_session,
            logs::structured_logging::end_structured_logging_session,
            logs::structured_logging::add_data_to_structured_logging_session,
            logs::structured_logging::add_facet_to_structured_logging_session,
            logs::structured_logging::set_facet_match_type_for_structured_logging_session,
            logs::structured_logging::remove_facet_from_structured_logging_session,
            logs::structured_logging::get_facets_for_structured_logging_session,
            logs::structured_logging::get_columns_for_structured_logging_session,
            logs::structured_logging::set_filtered_for_facet_value,
            logs::structured_logging::get_filtered_data_for_structured_logging_session,
            watch::watch_subscribe,
            watch::watch_unsubscribe,
            watch::watch_restart,
            watch::watch_reset,
            watch::watch_set_paused,
            watch::watch_get,
            watch::watch_stats,
            metrics::metrics_subscribe,
            metrics::metrics_unsubscribe,
            metrics::metrics_reset,
            manifest::get_openapi_v3_schema,
            logs::structured_logging::export_structured_logging_session,
            logs::streaming::start_log_stream,
            logs::streaming::stop_log_stream,
            workloads::run_helm_with_values,
        ])
        .setup(|_app| {
            #[cfg(target_os = "macos")]
            {
                let metadata = AboutMetadataBuilder::new()
                    .authors(Some(vec!["@unxsist".to_string()]))
                    .website(Some(String::from("https://www.jet-pilot.app")))
                    .license(Some(String::from("MIT")))
                    .build();

                let check_for_updates = MenuItemBuilder::new("Check for updates...").id("check_for_updates").build(_app)?;

                let submenu = SubmenuBuilder::new(_app, "JET Pilot")
                    .about(Some(metadata))
                    .item(&check_for_updates)
                    .separator()
                    .quit()
                    .build()?;

                let copy_paste_menu = SubmenuBuilder::new(_app, "Edit")
                    .undo()
                    .redo()
                    .separator()
                    .cut()
                    .copy()
                    .paste()
                    .separator()
                    .select_all()
                    .build()?;


                let menu = MenuBuilder::new(_app).item(&submenu).item(&copy_paste_menu).build()?;

                _app.set_menu(menu)?;

                _app.on_menu_event(move |app, event| {
                    if check_for_updates.id() == event.id() {
                        let _ = app.emit("check_for_updates", CheckForUpdatesPayload {});
                    }
                });
            }

            let _window = _app.get_webview_window("main").unwrap();

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
        .build(ctx)
        .expect("Error while building JET Pilot");

    app.run(|_app_handle, event| {
        if let tauri::RunEvent::Exit = event {
            // Don't orphan kubectl port-forward processes when the app closes.
            port_forward::kill_all_port_forwards();
            // Same for kubectl exec / local shell sessions (and their
            // temporary kubeconfigs).
            shell::tty::kill_all_tty_sessions();
            // And backend log streams (kubectl logs --follow).
            logs::streaming::kill_all_log_streams();
        }
    });
}

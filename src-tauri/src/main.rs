// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::{menu::{AboutMetadataBuilder, MenuBuilder, MenuItemBuilder, SubmenuBuilder}, Emitter, Manager};
use tracing::Level;
use tracing::level_filters::LevelFilter;
use tracing_appender::rolling;
use tracing_subscriber::{fmt, prelude::*, reload, Registry};
use once_cell::sync::Lazy;
use std::sync::Arc;

mod kubernetes;
mod logs;
mod shell;

static RELOAD_HANDLE: Lazy<Arc<reload::Handle<LevelFilter, Registry>>> = Lazy::new(|| {
    // Set up the file appender and layers as in main
    let file_appender = rolling::daily("logs", "jet-pilot.log");
    let (non_blocking, _guard) = tracing_appender::non_blocking(file_appender);
    let (filter_layer, reload_handle) = reload::Layer::new(LevelFilter::INFO);
    let fmt_layer = fmt::layer().with_writer(non_blocking);
    let subscriber = Registry::default().with(filter_layer).with(fmt_layer);

    // Set the subscriber globally
    tracing::subscriber::set_global_default(subscriber).expect("Failed to set subscriber");

    Arc::new(reload_handle)
});

#[tauri::command]
fn update_log_level(level: String) -> Result<(), String> {
    let level = match level.to_lowercase().as_str() {
        "trace" => Level::TRACE,
        "debug" => Level::DEBUG,
        "info" => Level::INFO,
        "warn" => Level::WARN,
        "error" => Level::ERROR,
        _ => return Err(format!("Invalid log level: {}", level)),
    };

    RELOAD_HANDLE
        .modify(|filter| *filter = level.into())
        .map_err(|e| e.to_string())?;

    println!("Log level updated to: {:?}", level);
    Ok(())
}

#[tauri::command]
fn write_log(level: String, message: String) -> Result<(), String> {
    let level = match level.to_lowercase().as_str() {
        "trace" => Level::TRACE,
        "debug" => Level::DEBUG,
        "info" => Level::INFO,
        "warn" => Level::WARN,
        "error" => Level::ERROR,
        _ => return Err(format!("Invalid log level: {}", level)),
    };

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
    let file_appender = rolling::daily("logs", "jet-pilot.log");
    let (non_blocking, _guard) = tracing_appender::non_blocking(file_appender);
    let (filter, reload_handle) = reload::Layer::new(LevelFilter::INFO);
    let fmt_layer = fmt::layer().with_writer(non_blocking);
    let subscriber = tracing_subscriber::registry().with(filter).with(fmt_layer);

    tracing::subscriber::set_global_default(subscriber).expect("Failed to set subscriber");

    let _ = fix_path_env::fix();

    let ctx = tauri::generate_context!();

    let mut builder = tauri::Builder::default()
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

    builder
        .invoke_handler(tauri::generate_handler![
            update_log_level,
            write_log,
            kubernetes::client::set_current_kubeconfig,
            kubernetes::client::list_contexts,
            kubernetes::client::get_context_auth_info,
            kubernetes::client::get_current_context,
            kubernetes::client::list_namespaces,
            kubernetes::client::get_core_api_versions,
            kubernetes::client::get_core_api_resources,
            kubernetes::client::get_api_groups,
            kubernetes::client::get_api_group_resources,
            kubernetes::client::list_pods,
            kubernetes::client::get_pod,
            kubernetes::client::delete_pod,
            kubernetes::client::list_deployments,
            kubernetes::client::restart_deployment,
            kubernetes::client::restart_statefulset,
            kubernetes::client::list_jobs,
            kubernetes::client::list_cronjobs,
            kubernetes::client::list_configmaps,
            kubernetes::client::list_secrets,
            kubernetes::client::list_services,
            kubernetes::client::list_ingresses,
            kubernetes::client::list_persistentvolumes,
            kubernetes::client::list_persistentvolumeclaims,
            kubernetes::client::replace_pod,
            kubernetes::client::replace_deployment,
            kubernetes::client::replace_job,
            kubernetes::client::replace_cronjob,
            kubernetes::client::replace_configmap,
            kubernetes::client::replace_secret,
            kubernetes::client::replace_service,
            kubernetes::client::replace_ingress,
            kubernetes::client::replace_persistentvolumeclaim,
            kubernetes::client::get_pod_metrics,
            kubernetes::client::get_pod_metric,
            kubernetes::client::trigger_cronjob,
            shell::tty::create_tty_session,
            shell::tty::stop_tty_session,
            shell::tty::write_to_pty,
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
                        app.emit("check_for_updates", CheckForUpdatesPayload {}).unwrap();
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
        .run(ctx)
        .expect("Error while starting JET Pilot");
}

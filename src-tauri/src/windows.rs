//! Pop-out windows: the main window (`main`) opens satellite windows
//! (`pop-<id>`) that load the same frontend bundle.
//!
//! - satellites are built from the main window's *effective* config (the
//!   platform files replace the whole `windows` array, RFC 7396), so chrome,
//!   transparency and the custom protocol scheme (origin, localStorage) are
//!   exactly the main window's on every platform
//! - backend resources (watch / metrics subscriptions, log streams and
//!   sessions, terminals) are owned by the webview that started them; a page
//!   load only resets its own, and a closed satellite releases everything it
//!   owned (`window://closed` tells the main window, except while the app
//!   quits: those satellites are reopened on the next start)
//! - closing the main window quits the app, satellites included: the close is
//!   prevented and the frontend asked to quit (`window://quit-requested`, it
//!   flushes its settings and exits); if it doesn't within 2 s the backend
//!   exits itself
//! - satellites get devtools like the main window in debug builds, but they
//!   are not opened automatically (one inspector per pop-out is noise)

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use serde::Serialize;
use tauri::utils::config::{PreventOverflowConfig, WindowConfig};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder, Window, WindowEvent};
use tracing::{debug, info, warn};

/// Label of the main window; internal callers without a webview (tests, QA)
/// act on its behalf.
pub const MAIN: &str = "main";
const SATELLITE_PREFIX: &str = "pop-";

/// Emitted to the main window when a satellite was closed: `{ label }`.
const CLOSED_EVENT: &str = "window://closed";
/// Emitted to the main window when it was asked to close (no payload).
const QUIT_REQUESTED_EVENT: &str = "window://quit-requested";

const DEFAULT_WIDTH: f64 = 960.0;
const DEFAULT_HEIGHT: f64 = 680.0;
const MIN_WIDTH: f64 = 480.0;
const MIN_HEIGHT: f64 = 320.0;

/// How long the frontend gets to quit by itself after the main window was
/// closed.
const QUIT_FALLBACK: Duration = Duration::from_secs(2);
/// The main window was destroyed without going through the quit path: give
/// a regular exit in progress a moment before forcing one.
const MAIN_GONE_DELAY: Duration = Duration::from_millis(300);

/// Set once the app is exiting (`RunEvent::ExitRequested` / `Exit`): the
/// exit fallbacks then stand down instead of racing the exit cleanup.
static EXITING: AtomicBool = AtomicBool::new(false);
/// The quit fallback is scheduled once, however often close is clicked.
static QUIT_REQUESTED: AtomicBool = AtomicBool::new(false);

pub fn is_satellite(label: &str) -> bool {
    label.starts_with(SATELLITE_PREFIX)
}

/// Which webview owns each subscription of a service (watch hub, metrics),
/// with an epoch per owner: bumped when that webview reloads or closes, so a
/// subscribe it started before registers nothing (its channel belongs to a
/// page that is gone), without affecting the subscribes of other windows.
#[derive(Debug, Default)]
pub(crate) struct Ownership {
    owners: HashMap<u64, String>,
    epochs: HashMap<String, u64>,
}

impl Ownership {
    pub fn epoch(&self, owner: &str) -> u64 {
        self.epochs.get(owner).copied().unwrap_or(0)
    }

    /// Whether no reset of `owner` happened since `epoch` was read.
    pub fn is_current(&self, owner: &str, epoch: u64) -> bool {
        self.epoch(owner) == epoch
    }

    pub fn insert(&mut self, id: u64, owner: &str) {
        self.owners.insert(id, owner.to_string());
    }

    pub fn remove(&mut self, id: u64) -> Option<String> {
        self.owners.remove(&id)
    }

    /// Starts a new epoch for `owner` and hands back (forgetting) its ids.
    pub fn reset(&mut self, owner: &str) -> Vec<u64> {
        let epoch = self.epochs.entry(owner.to_string()).or_default();
        *epoch = epoch.wrapping_add(1);
        let ids: Vec<u64> = self
            .owners
            .iter()
            .filter(|(_, o)| o.as_str() == owner)
            .map(|(id, _)| *id)
            .collect();
        for id in &ids {
            self.owners.remove(id);
        }
        ids
    }
}

/// The main window's native tweaks, shared by every window. macOS: no window
/// shadow and no title in the overlay title bar (the app draws its own
/// header). Must run on the main thread.
pub fn apply_chrome(window: &WebviewWindow) {
    #[cfg(target_os = "macos")]
    {
        use tauri_nspanel::cocoa;
        use tauri_nspanel::cocoa::appkit::NSWindow;
        use tauri_nspanel::cocoa::appkit::NSWindowTitleVisibility;
        use tauri_nspanel::cocoa::base::BOOL;

        match window.ns_window() {
            Ok(ns_window) => unsafe {
                let id = ns_window as cocoa::base::id;
                id.setHasShadow_(BOOL::from(false));
                id.setTitleVisibility_(NSWindowTitleVisibility::NSWindowTitleHidden);
            },
            Err(e) => warn!("Unable to adjust the native window {}: {}", window.label(), e),
        }
    }
    #[cfg(not(target_os = "macos"))]
    let _ = window;
}

/// What the frontend asked `window_open` for.
#[derive(Debug, Clone, PartialEq)]
struct WindowRequest {
    label: String,
    url: String,
    title: String,
    width: Option<f64>,
    height: Option<f64>,
    /// Logical position; centered when either is missing or off screen.
    position: Option<(f64, f64)>,
}

/// Only app paths (`/?window=pop-abc&p=...`): satellites get the main
/// window's permissions, so they must never load another origin. `//host`
/// and backslashes would resolve to another host when joined to the app URL.
fn validate_app_path(url: &str) -> Result<(), String> {
    if url.starts_with('/') && !url.starts_with("//") && !url.contains('\\') {
        Ok(())
    } else {
        Err(format!("Not an app path: {url}"))
    }
}

/// The satellite's config: the main window's (chrome, transparency, URL
/// scheme, devtools) with the requested label, page, title and geometry.
fn satellite_config(main: Option<&WindowConfig>, request: WindowRequest) -> WindowConfig {
    let mut config = main.cloned().unwrap_or_default();
    config.label = request.label;
    config.url = WebviewUrl::App(request.url.into());
    config.title = request.title;
    let size = |value: Option<f64>, default: f64, min: f64| {
        value.filter(|v| v.is_finite() && *v > 0.0).unwrap_or(default).max(min)
    };
    config.width = size(request.width, DEFAULT_WIDTH, MIN_WIDTH);
    config.height = size(request.height, DEFAULT_HEIGHT, MIN_HEIGHT);
    config.min_width = Some(MIN_WIDTH);
    config.min_height = Some(MIN_HEIGHT);
    config.max_width = None;
    config.max_height = None;
    match request.position {
        Some((x, y)) => {
            config.x = Some(x);
            config.y = Some(y);
            config.center = false;
        }
        None => {
            config.x = None;
            config.y = None;
            config.center = true;
        }
    }
    // A size restored from a larger monitor is clamped to the work area.
    config.prevent_overflow = Some(PreventOverflowConfig::Enable(true));
    config.resizable = true;
    config.fullscreen = false;
    config.maximized = false;
    config.visible = true;
    config.focus = true;
    config.parent = None;
    // What `apply_chrome` does to the main window, already at creation so the
    // title and shadow don't flash before it runs.
    #[cfg(target_os = "macos")]
    {
        config.hidden_title = true;
        config.shadow = false;
    }
    config
}

/// Monitor work areas as logical (x, y, width, height).
fn monitor_rects(app: &AppHandle) -> Vec<(f64, f64, f64, f64)> {
    app.available_monitors()
        .unwrap_or_default()
        .iter()
        .map(|monitor| {
            let scale = monitor.scale_factor();
            let position = monitor.position();
            let size = monitor.size();
            (
                position.x as f64 / scale,
                position.y as f64 / scale,
                size.width as f64 / scale,
                size.height as f64 / scale,
            )
        })
        .collect()
}

/// Whether a window at `(x, y)` can be grabbed by its title bar on one of
/// `monitors` (a position restored after a monitor was unplugged may not).
/// Without monitor information the position is trusted.
fn reachable(x: f64, y: f64, monitors: &[(f64, f64, f64, f64)]) -> bool {
    let (grab_x, grab_y) = (x + 40.0, y + 12.0);
    monitors.is_empty()
        || monitors
            .iter()
            .any(|(mx, my, mw, mh)| grab_x >= *mx && grab_x < mx + mw && grab_y >= *my && grab_y < my + mh)
}

fn bring_forward(window: &WebviewWindow) -> Result<(), String> {
    window
        .unminimize()
        .and_then(|_| window.show())
        .and_then(|_| window.set_focus())
        .map_err(|e| format!("Unable to focus the window: {e}"))?;
    // Shown and focused: count it as visible for the watch delivery pause
    // until its page reports otherwise.
    crate::watch::window_shown(window.label());
    Ok(())
}

/// Opens satellite window `label` on app page `url`, or brings it forward
/// when it is already open. Async on purpose: building a window from a
/// synchronous command (on the main thread) deadlocks on Windows.
#[tauri::command]
#[allow(clippy::too_many_arguments)] // the frontend's argument list
pub async fn window_open(
    app: AppHandle,
    label: String,
    url: String,
    title: String,
    width: Option<f64>,
    height: Option<f64>,
    x: Option<f64>,
    y: Option<f64>,
) -> Result<(), String> {
    if !is_satellite(&label) {
        return Err(format!("Only pop-out windows ({SATELLITE_PREFIX}*) can be opened, not {label:?}"));
    }
    if let Some(window) = app.get_webview_window(&label) {
        return bring_forward(&window);
    }
    validate_app_path(&url)?;

    let position = x
        .zip(y)
        .filter(|(x, y)| x.is_finite() && y.is_finite())
        .filter(|(x, y)| reachable(*x, *y, &monitor_rects(&app)));
    let request = WindowRequest {
        label: label.clone(),
        url,
        title,
        width,
        height,
        position,
    };
    let main = app.config().app.windows.iter().find(|w| w.label == MAIN);
    let config = satellite_config(main, request);

    let built = WebviewWindowBuilder::from_config(&app, &config).and_then(|builder| builder.build());
    let window = match built {
        Ok(window) => window,
        // Opened concurrently by another call meanwhile.
        Err(_) if app.get_webview_window(&label).is_some() => {
            return app.get_webview_window(&label).map_or(Ok(()), |w| bring_forward(&w));
        }
        Err(e) => return Err(format!("Unable to open the window: {e}")),
    };
    info!("Opened window {}", label);

    let chrome_window = window.clone();
    if let Err(e) = window.run_on_main_thread(move || apply_chrome(&chrome_window)) {
        warn!("Unable to adjust the native window {}: {}", label, e);
    }
    crate::watch::window_shown(&label);
    Ok(())
}

/// Unminimizes, shows and focuses any window (e.g. `main` from a satellite).
#[tauri::command]
pub async fn window_focus(app: AppHandle, label: String) -> Result<(), String> {
    let window = app
        .get_webview_window(&label)
        .ok_or_else(|| format!("There is no window {label:?}"))?;
    bring_forward(&window)
}

#[derive(Clone, Serialize)]
struct WindowClosed {
    label: String,
}

/// Frees everything a closed satellite's webview owned.
fn release_webview(label: &str) {
    let subscriptions = crate::watch::release_owner(label);
    crate::watch::forget_window(label);
    let metrics = crate::metrics::release_owner(label);
    let (streams, sessions) = crate::logs::streaming::release_owner(label);
    let terminals = crate::shell::tty::stop_sessions_of(label);
    info!(
        "Window {} closed: released {} watch and {} metrics subscriptions, {} log streams, {} log sessions, {} terminals",
        label, subscriptions, metrics, streams, sessions, terminals
    );
}

/// Exits after `delay` unless the app is exiting by then already.
fn schedule_exit(app: AppHandle, delay: Duration, reason: &'static str) {
    let fallback = app.clone();
    let spawned = std::thread::Builder::new()
        .name("exit-fallback".into())
        .spawn(move || {
            std::thread::sleep(delay);
            if !EXITING.load(Ordering::SeqCst) {
                warn!("Exiting: {}", reason);
                fallback.exit(0);
            }
        });
    if let Err(e) = spawned {
        warn!("Unable to schedule the exit ({}): exiting now", e);
        // Runs on the main thread (window event): exits through the event
        // loop, with the regular exit cleanup.
        app.exit(0);
    }
}

/// The main window was asked to close: quit the whole app. The frontend
/// flushes its settings and exits (plugin-process `exit`); the fallback
/// covers a frontend that can't.
fn request_quit(app: &AppHandle) {
    info!("Main window closed: quitting");
    if let Err(e) = app.emit_to(MAIN, QUIT_REQUESTED_EVENT, ()) {
        warn!("Unable to ask the frontend to quit: {}", e);
    }
    if !QUIT_REQUESTED.swap(true, Ordering::SeqCst) {
        schedule_exit(app.clone(), QUIT_FALLBACK, "the frontend did not quit after the main window was closed");
    }
}

/// The app is exiting (`RunEvent::ExitRequested` / `RunEvent::Exit`).
pub fn note_exit() {
    EXITING.store(true, Ordering::SeqCst);
}

/// Window lifecycle: see the module docs.
pub fn on_window_event(window: &Window, event: &WindowEvent) {
    let label = window.label();
    match event {
        WindowEvent::CloseRequested { api, .. } if label == MAIN => {
            api.prevent_close();
            request_quit(window.app_handle());
        }
        WindowEvent::Destroyed if is_satellite(label) => {
            release_webview(label);
            // Satellites closing because the app quits (Cmd+Q included, which
            // never passes the frontend) are reopened on the next start: the
            // main window must not forget them.
            if EXITING.load(Ordering::SeqCst) || QUIT_REQUESTED.load(Ordering::SeqCst) {
                return;
            }
            let payload = WindowClosed {
                label: label.to_string(),
            };
            if let Err(e) = window.emit_to(MAIN, CLOSED_EVENT, payload) {
                debug!("Unable to report the closed window {}: {}", label, e);
            }
        }
        // Destroyed without the quit path (e.g. by the frontend): satellites
        // can't work on their own, don't leave them behind.
        WindowEvent::Destroyed if label == MAIN => {
            schedule_exit(window.app_handle().clone(), MAIN_GONE_DELAY, "the main window is gone");
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_pop_labels_are_satellites() {
        assert!(is_satellite("pop-abc"));
        assert!(!is_satellite("main"));
        assert!(!is_satellite("popup"));
    }

    #[test]
    fn reset_only_touches_its_owner() {
        let mut ownership = Ownership::default();
        ownership.insert(1, "main");
        ownership.insert(2, "pop-a");
        ownership.insert(3, "pop-a");
        let main_epoch = ownership.epoch("main");
        let pop_epoch = ownership.epoch("pop-a");

        let mut released = ownership.reset("pop-a");
        released.sort();
        assert_eq!(released, vec![2, 3]);
        assert!(ownership.is_current("main", main_epoch), "a satellite loading must not reject main's subscribes");
        assert!(!ownership.is_current("pop-a", pop_epoch), "its own in-flight subscribes are rejected");
        assert_eq!(ownership.remove(1).as_deref(), Some("main"));
        assert!(ownership.reset("pop-a").is_empty());
        assert_eq!(ownership.remove(2), None);
    }

    #[test]
    fn only_app_paths_can_be_opened() {
        assert!(validate_app_path("/?window=pop-abc&p=%2Fpods").is_ok());
        assert!(validate_app_path("/").is_ok());
        assert!(validate_app_path("//evil.example/x").is_err());
        assert!(validate_app_path("/\\evil.example").is_err());
        assert!(validate_app_path("https://evil.example").is_err());
        assert!(validate_app_path("").is_err());
    }

    fn request() -> WindowRequest {
        WindowRequest {
            label: "pop-a".into(),
            url: "/?window=pop-a".into(),
            title: "Pods".into(),
            width: None,
            height: None,
            position: None,
        }
    }

    #[test]
    fn satellites_copy_the_main_window_chrome() {
        let main = WindowConfig {
            label: MAIN.into(),
            decorations: false,
            transparent: true,
            use_https_scheme: true,
            width: 1120.0,
            maximized: true,
            ..Default::default()
        };
        let config = satellite_config(Some(&main), request());
        assert_eq!(config.label, "pop-a");
        assert_eq!(config.title, "Pods");
        assert_eq!(config.url, WebviewUrl::App("/?window=pop-a".into()));
        assert!(!config.decorations && config.transparent && config.use_https_scheme);
        assert!(!config.maximized);
        assert_eq!((config.width, config.height), (DEFAULT_WIDTH, DEFAULT_HEIGHT));
        assert_eq!((config.min_width, config.min_height), (Some(MIN_WIDTH), Some(MIN_HEIGHT)));
        assert!(config.center && config.x.is_none());

        let config = satellite_config(
            None,
            WindowRequest {
                width: Some(200.0),
                height: Some(900.0),
                position: Some((10.0, 20.0)),
                ..request()
            },
        );
        assert_eq!((config.width, config.height), (MIN_WIDTH, 900.0));
        assert_eq!((config.x, config.y, config.center), (Some(10.0), Some(20.0), false));
    }

    #[test]
    fn positions_off_every_monitor_are_not_used() {
        let monitors = [(0.0, 0.0, 1920.0, 1080.0), (1920.0, 0.0, 1280.0, 1024.0)];
        assert!(reachable(100.0, 100.0, &monitors));
        assert!(reachable(2500.0, 900.0, &monitors));
        assert!(!reachable(4000.0, 100.0, &monitors));
        assert!(!reachable(100.0, -500.0, &monitors));
        assert!(reachable(4000.0, 100.0, &[]));
    }
}

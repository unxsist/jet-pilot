//! `jetpilot://` links (pasted in Slack, runbooks, alert annotations). The OS
//! starts the app with one, or hands it to the running instance (the
//! single-instance plugin forwards a second launch's arguments to the
//! deep-link plugin). Each link focuses the main window and goes to the
//! frontend as a `deep-link://open` event; links that arrive before the
//! frontend listens wait until it calls `deep_link_ready`.
//!
//! Links only navigate. Parsing, and matching them against the clusters the
//! app already knows, happens in the frontend (`src/lib/deepLink.ts`); a link
//! never makes the app read a kubeconfig or change anything.

use once_cell::sync::Lazy;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, Runtime};
use tauri_plugin_deep_link::DeepLinkExt;
use tracing::{info, warn};

use crate::util::lock;

pub const SCHEME: &str = "jetpilot";
const EVENT: &str = "deep-link://open";
/// Links are short; anything longer isn't one of ours.
const MAX_LENGTH: usize = 8 * 1024;
/// Links queued before the frontend is ready (a burst of clicks while starting).
const MAX_PENDING: usize = 8;

#[derive(Default)]
struct Inbox {
    ready: bool,
    pending: Vec<String>,
}

static INBOX: Lazy<Mutex<Inbox>> = Lazy::new(|| Mutex::new(Inbox::default()));

/// The links of our scheme among `urls`, within the length limit.
pub(crate) fn accepted(urls: impl IntoIterator<Item = String>) -> Vec<String> {
    let prefix = format!("{SCHEME}:");
    urls.into_iter()
        .filter(|url| url.len() <= MAX_LENGTH && url.get(..prefix.len()).is_some_and(|p| p.eq_ignore_ascii_case(&prefix)))
        .collect()
}

/// Brings the main window to the front (also on a plain second launch).
pub fn focus_main<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn deliver<R: Runtime>(app: &AppHandle<R>, urls: Vec<String>) {
    let urls = accepted(urls);
    if urls.is_empty() {
        return;
    }
    info!("Opening {} jetpilot:// link(s)", urls.len());
    focus_main(app);
    let mut inbox = lock(&INBOX);
    if inbox.ready {
        if let Err(e) = app.emit_to("main", EVENT, urls) {
            warn!("Failed to pass a link to the window: {}", e);
        }
    } else {
        inbox.pending.extend(urls);
        let excess = inbox.pending.len().saturating_sub(MAX_PENDING);
        inbox.pending.drain(..excess);
    }
}

/// The frontend listens for links now: returns the ones that came before
/// (the link the app was started with).
#[tauri::command]
pub fn deep_link_ready() -> Vec<String> {
    let mut inbox = lock(&INBOX);
    inbox.ready = true;
    std::mem::take(&mut inbox.pending)
}

pub fn init<R: Runtime>(app: &AppHandle<R>) {
    let deep_link = app.deep_link();
    // Started with a link: Windows and Linux pass it as the argument (macOS
    // sends it as an event, handled below).
    if let Ok(Some(urls)) = deep_link.get_current() {
        deliver(app, urls.into_iter().map(String::from).collect());
    }
    let handle = app.clone();
    deep_link.on_open_url(move |event| {
        deliver(&handle, event.urls().into_iter().map(String::from).collect());
    });
    // An AppImage isn't installed, so nothing registered the scheme for it.
    #[cfg(target_os = "linux")]
    if app.env().appimage.is_some() {
        if let Err(e) = deep_link.register_all() {
            warn!("Couldn't register jetpilot:// links for the AppImage: {}", e);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_our_scheme_is_accepted() {
        let urls = accepted([
            "jetpilot://open?context=prod&kind=Pod&name=api".to_string(),
            "JetPilot://view?page=health".to_string(),
            "https://example.com".to_string(),
            "jetpilotx://open".to_string(),
            "--flag".to_string(),
            format!("jetpilot://open?name={}", "a".repeat(MAX_LENGTH)),
        ]);
        assert_eq!(
            urls,
            vec![
                "jetpilot://open?context=prod&kind=Pod&name=api".to_string(),
                "JetPilot://view?page=health".to_string(),
            ]
        );
    }
}

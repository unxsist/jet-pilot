//! Announcements feed: a small JSON file on jet-pilot.app that reaches
//! installed versions without a release (e.g. "this version can't update
//! itself, here is how to update by hand"). The frontend validates the feed
//! and picks what to show (src/lib/announcements.ts); this only fetches it.
//!
//! Like Open VSX (openvsx.rs), the request goes through Rust so the webview's
//! CSP `connect-src` and the http plugin's URL scope stay untouched. The URL
//! is fixed and the body capped (net.rs), so the webview can't use this as a
//! fetch proxy.

use std::time::Duration;

use serde_json::Value;

use crate::net::{self, NetError};

const FEED_URL: &str = "https://www.jet-pilot.app/announcements.json";
const TIMEOUT: Duration = Duration::from_secs(10);
const MAX_FEED_BYTES: usize = 256 * 1024;

#[tauri::command]
pub async fn fetch_announcements(app: tauri::AppHandle) -> Result<Value, String> {
    let client = net::https_client_builder(&net::user_agent(&app), &[])
        .timeout(TIMEOUT)
        .build()
        .map_err(|e| format!("Failed to create the HTTP client: {e}"))?;

    let body = net::get_capped(&client, FEED_URL, MAX_FEED_BYTES)
        .await
        .map_err(|e| match e {
            NetError::Status(status) => {
                format!("Announcements are unavailable (HTTP {status}).")
            }
            NetError::TooLarge(_) => "The announcements feed is too large.".to_string(),
            e => format!("Fetching announcements failed: {e}"),
        })?;

    serde_json::from_slice(&body)
        .map_err(|_| "The announcements feed is not valid JSON.".to_string())
}

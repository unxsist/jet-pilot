//! Announcements feed: a small JSON file on jet-pilot.app that reaches
//! installed versions without a release (e.g. "this version can't update
//! itself, here is how to update by hand"). The frontend validates the feed
//! and picks what to show (src/lib/announcements.ts); this only fetches it.
//!
//! Like Open VSX (openvsx.rs), the request goes through Rust so the webview's
//! CSP `connect-src` and the http plugin's URL scope stay untouched. The URL
//! is fixed and the body capped, so the webview can't use this as a fetch
//! proxy.

use std::time::Duration;

use serde_json::Value;
use tauri_plugin_http::reqwest;

const FEED_URL: &str = "https://www.jet-pilot.app/announcements.json";
const TIMEOUT: Duration = Duration::from_secs(10);
const MAX_FEED_BYTES: usize = 256 * 1024;

#[tauri::command]
pub async fn fetch_announcements(app: tauri::AppHandle) -> Result<Value, String> {
    let client = reqwest::Client::builder()
        .user_agent(format!("JET-Pilot/{}", app.package_info().version))
        .https_only(true)
        .timeout(TIMEOUT)
        .build()
        .map_err(|e| format!("Failed to create the HTTP client: {e}"))?;

    let mut response = client
        .get(FEED_URL)
        .send()
        .await
        .map_err(|e| format!("Fetching announcements failed: {e}"))?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("Announcements are unavailable (HTTP {status})."));
    }

    let mut body = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|e| format!("Fetching announcements failed: {e}"))?
    {
        if body.len() + chunk.len() > MAX_FEED_BYTES {
            return Err("The announcements feed is too large.".to_string());
        }
        body.extend_from_slice(&chunk);
    }

    serde_json::from_slice(&body)
        .map_err(|_| "The announcements feed is not valid JSON.".to_string())
}

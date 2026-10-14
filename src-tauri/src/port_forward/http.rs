//! The HTTP tester: one request to a running forward's local port.
//!
//! Sent from Rust (no CORS, no webview CSP) and only ever to the forward's
//! own listener: the URL is built here from the forward's address and port
//! plus a path, redirects are not followed and no proxy is used, so a
//! request can't leave the machine.

use std::net::IpAddr;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri_plugin_http::reqwest;

use super::ForwardStatus;

const TIMEOUT: Duration = Duration::from_secs(30);
/// Bodies beyond this are cut (the tester shows a preview, not downloads).
const MAX_BODY: usize = 1024 * 1024;
const METHODS: &[&str] = &["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct Header {
    pub name: String,
    pub value: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpTestRequest {
    pub id: String,
    pub method: String,
    /// Path and query, e.g. `/api/orders?limit=10`.
    pub path: String,
    #[serde(default)]
    pub headers: Vec<Header>,
    pub body: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpTestResponse {
    pub status: u16,
    pub status_text: String,
    pub duration_ms: u64,
    pub headers: Vec<Header>,
    /// The body as text (empty for binary bodies).
    pub body: String,
    /// Bytes received (up to the cap).
    pub size: u64,
    pub truncated: bool,
    pub binary: bool,
    pub url: String,
}

/// The host to reach a listener bound to `address` at: loopback for
/// `localhost`, wildcard and unparseable addresses, else the address
/// itself (it's one of this machine's, the forward is listening on it).
pub fn local_host(address: &str) -> String {
    match address.parse::<IpAddr>() {
        Ok(ip) if ip.is_unspecified() => "127.0.0.1".into(),
        Ok(IpAddr::V6(ip)) => format!("[{ip}]"),
        Ok(IpAddr::V4(ip)) => ip.to_string(),
        Err(_) => "127.0.0.1".into(),
    }
}

/// Validates the method and path and builds the URL.
pub fn request_url(method: &str, address: &str, port: u16, path: &str) -> Result<(reqwest::Method, reqwest::Url), String> {
    let upper = method.trim().to_ascii_uppercase();
    if !METHODS.contains(&upper.as_str()) {
        return Err(format!("Unsupported method {method}"));
    }
    let path = if path.is_empty() { "/" } else { path };
    if !path.starts_with('/') || path.starts_with("//") {
        return Err("The path must start with a single /".into());
    }
    if path.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err("The path can't contain spaces".into());
    }
    let host = local_host(address);
    let url = reqwest::Url::parse(&format!("http://{host}:{port}{path}")).map_err(|e| format!("Invalid path: {e}"))?;
    // Belt and braces: whatever the path did, it's still our listener.
    if url.port() != Some(port) || url.host_str().map(|h| h.trim_matches(['[', ']'])) != Some(host.trim_matches(['[', ']'])) {
        return Err("The path must stay on the forwarded port".into());
    }
    let method = reqwest::Method::from_bytes(upper.as_bytes()).map_err(|e| e.to_string())?;
    Ok((method, url))
}

/// Text unless the content type says otherwise or the bytes aren't UTF-8.
pub fn is_binary(content_type: Option<&str>, bytes: &[u8]) -> bool {
    let textual = content_type.is_some_and(|ct| {
        let ct = ct.to_ascii_lowercase();
        ct.starts_with("text/")
            || ct.contains("json")
            || ct.contains("xml")
            || ct.contains("javascript")
            || ct.contains("x-www-form-urlencoded")
            || ct.contains("yaml")
    });
    if textual {
        return false;
    }
    // A cut body may end mid-character: only the start has to decode.
    let valid = match std::str::from_utf8(bytes) {
        Ok(_) => true,
        Err(e) => e.error_len().is_none() && e.valid_up_to() + 4 > bytes.len(),
    };
    !valid || bytes.contains(&0)
}

#[tauri::command]
pub async fn port_forward_http_request(request: HttpTestRequest) -> Result<HttpTestResponse, String> {
    let forward = super::snapshot(&request.id).ok_or("This forward has stopped")?;
    if !matches!(forward.status, ForwardStatus::Ready | ForwardStatus::Reconnecting) {
        return Err("This forward isn't ready".into());
    }
    let (method, url) = request_url(&request.method, &forward.address, forward.local_port, &request.path)?;

    let client = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(TIMEOUT)
        .build()
        .map_err(|e| e.to_string())?;
    let mut builder = client.request(method, url.clone());
    for header in &request.headers {
        let name = header.name.trim();
        if name.is_empty() {
            continue;
        }
        let name = reqwest::header::HeaderName::from_bytes(name.as_bytes())
            .map_err(|_| format!("Invalid header name {name}"))?;
        let value = reqwest::header::HeaderValue::from_str(&header.value)
            .map_err(|_| format!("Invalid value for header {name}"))?;
        builder = builder.header(name, value);
    }
    if let Some(body) = request.body.filter(|b| !b.is_empty()) {
        builder = builder.body(body);
    }

    let started = Instant::now();
    let mut response = builder.send().await.map_err(|e| send_error(&e, forward.local_port))?;
    let status = response.status();
    let headers: Vec<Header> = response
        .headers()
        .iter()
        .map(|(name, value)| Header {
            name: name.to_string(),
            value: String::from_utf8_lossy(value.as_bytes()).into_owned(),
        })
        .collect();
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);

    let mut bytes: Vec<u8> = Vec::new();
    let mut truncated = false;
    while let Some(chunk) = response.chunk().await.map_err(|e| send_error(&e, forward.local_port))? {
        let room = MAX_BODY - bytes.len();
        if chunk.len() > room {
            bytes.extend_from_slice(&chunk[..room]);
            truncated = true;
            break;
        }
        bytes.extend_from_slice(&chunk);
    }
    let duration_ms = started.elapsed().as_millis() as u64;
    let binary = is_binary(content_type.as_deref(), &bytes);

    Ok(HttpTestResponse {
        status: status.as_u16(),
        status_text: status.canonical_reason().unwrap_or("").to_string(),
        duration_ms,
        headers,
        body: if binary { String::new() } else { String::from_utf8_lossy(&bytes).into_owned() },
        size: bytes.len() as u64,
        truncated,
        binary,
        url: url.to_string(),
    })
}

fn send_error(e: &reqwest::Error, port: u16) -> String {
    if e.is_timeout() {
        return format!("No answer within {} seconds", TIMEOUT.as_secs());
    }
    if e.is_connect() {
        return format!("Couldn't connect to localhost:{port}");
    }
    // reqwest's own message hides the cause ("error sending request").
    let mut message = e.to_string();
    let mut source = std::error::Error::source(e);
    while let Some(cause) = source {
        message = cause.to_string();
        source = cause.source();
    }
    if message.contains("connection closed") || message.contains("reset") {
        return "The connection closed without an answer. Is this an HTTP port?".into();
    }
    message
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn requests_only_go_to_the_forward() {
        let (method, url) = request_url("get", "localhost", 8080, "/api/orders?limit=2").unwrap();
        assert_eq!(method, reqwest::Method::GET);
        assert_eq!(url.as_str(), "http://127.0.0.1:8080/api/orders?limit=2");
        assert_eq!(request_url("GET", "::1", 8080, "/").unwrap().1.as_str(), "http://[::1]:8080/");
        assert_eq!(request_url("GET", "0.0.0.0", 9090, "").unwrap().1.as_str(), "http://127.0.0.1:9090/");

        assert!(request_url("GET", "localhost", 8080, "//evil.example/x").is_err());
        assert!(request_url("GET", "localhost", 8080, "@evil.example/").is_err());
        assert!(request_url("GET", "localhost", 8080, "http://evil.example/").is_err());
        assert!(request_url("GET", "localhost", 8080, "/a b").is_err());
        assert!(request_url("TRACE", "localhost", 8080, "/").is_err());
    }

    #[test]
    fn bodies_are_text_unless_they_look_binary() {
        assert!(!is_binary(Some("application/json; charset=utf-8"), b"{}"));
        assert!(!is_binary(None, "héllo".as_bytes()));
        assert!(is_binary(Some("image/png"), &[0x89, b'P', b'N', b'G', 0, 0]));
        assert!(is_binary(None, &[0xff, 0xfe, 0xfd, 0x00, 0x41, 0x42]));
        // A body cut in the middle of a character is still text.
        let cut = &"€".as_bytes()[..2];
        assert!(!is_binary(None, &[b"price: ".as_slice(), cut].concat()));
    }
}

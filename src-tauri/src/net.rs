//! Shared HTTPS plumbing for the fixed origins the backend talks to (the
//! announcements feed, tool downloads, ...). Requests go through Rust so the
//! webview's CSP `connect-src` and the http plugin's URL scope stay
//! untouched.
//!
//! - clients are https-only (redirects included) and can be pinned to a
//!   host allowlist for redirects;
//! - bodies are read with a hard size cap (Content-Length is not trusted);
//! - downloads stream to a temp file next to the destination while the
//!   SHA-256 is computed, are verified, and only then renamed into place, so
//!   a partial or tampered file never appears under the final name.

use std::fmt;
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};
use tauri_plugin_http::reqwest;
use tokio::io::AsyncWriteExt;

const MAX_REDIRECTS: usize = 10;

#[derive(Debug, Clone, PartialEq)]
pub enum NetError {
    /// A non-success HTTP status.
    Status(u16),
    /// The body exceeded the cap (bytes).
    TooLarge(u64),
    ChecksumMismatch {
        expected: String,
        actual: String,
    },
    /// An expected checksum that is not a SHA-256 hex digest.
    InvalidChecksum,
    Timeout,
    Network(String),
    Io(String),
}

impl fmt::Display for NetError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            NetError::Status(status) => write!(f, "the server answered HTTP {status}"),
            NetError::TooLarge(limit) => {
                write!(
                    f,
                    "the download is larger than {} MB",
                    limit / (1024 * 1024)
                )
            }
            NetError::ChecksumMismatch { expected, actual } => write!(
                f,
                "the SHA-256 checksum does not match (expected {expected}, got {actual})"
            ),
            NetError::InvalidChecksum => {
                f.write_str("the published checksum is not a SHA-256 digest")
            }
            NetError::Timeout => f.write_str("the server took too long to respond"),
            NetError::Network(e) | NetError::Io(e) => f.write_str(e),
        }
    }
}

impl std::error::Error for NetError {}

impl From<reqwest::Error> for NetError {
    fn from(e: reqwest::Error) -> Self {
        if e.is_timeout() {
            return NetError::Timeout;
        }
        // reqwest's own message hides the cause ("error sending request
        // for url (...)"); the source chain has the useful part.
        let mut message = e.to_string();
        let mut source = std::error::Error::source(&e);
        while let Some(cause) = source {
            message.push_str(": ");
            message.push_str(&cause.to_string());
            source = cause.source();
        }
        NetError::Network(message)
    }
}

impl From<std::io::Error> for NetError {
    fn from(e: std::io::Error) -> Self {
        NetError::Io(e.to_string())
    }
}

/// `JET-Pilot/<version>`.
pub fn user_agent(app: &tauri::AppHandle) -> String {
    format!("JET-Pilot/{}", app.package_info().version)
}

/// An https-only client builder (redirects must stay on https too). With a
/// non-empty `redirect_hosts`, redirects may only go to those hosts; empty
/// keeps reqwest's default policy (any https host, at most 10 hops).
pub fn https_client_builder(user_agent: &str, redirect_hosts: &[&str]) -> reqwest::ClientBuilder {
    let builder = reqwest::Client::builder()
        .user_agent(user_agent)
        .https_only(true);
    if redirect_hosts.is_empty() {
        return builder;
    }
    let hosts: Vec<String> = redirect_hosts
        .iter()
        .map(|h| h.to_ascii_lowercase())
        .collect();
    builder.redirect(reqwest::redirect::Policy::custom(move |attempt| {
        if attempt.previous().len() >= MAX_REDIRECTS {
            attempt.error("too many redirects")
        } else if redirect_allowed(attempt.url(), &hosts) {
            attempt.follow()
        } else {
            let host = attempt.url().host_str().unwrap_or("").to_string();
            attempt.error(format!("refusing to follow a redirect to {host}"))
        }
    }))
}

fn redirect_allowed(url: &reqwest::Url, hosts: &[String]) -> bool {
    url.scheme() == "https"
        && url
            .host_str()
            .is_some_and(|host| hosts.iter().any(|h| h.eq_ignore_ascii_case(host)))
}

/// GETs `url` and returns the body, failing once it exceeds `max_bytes`
/// (whatever Content-Length claims).
pub async fn get_capped(
    client: &reqwest::Client,
    url: &str,
    max_bytes: usize,
) -> Result<Vec<u8>, NetError> {
    let mut response = client.get(url).send().await?;
    check_status(&response)?;
    let limit = max_bytes as u64;
    if response.content_length().is_some_and(|len| len > limit) {
        return Err(NetError::TooLarge(limit));
    }
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await? {
        if body.len() + chunk.len() > max_bytes {
            return Err(NetError::TooLarge(limit));
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

fn check_status(response: &reqwest::Response) -> Result<(), NetError> {
    let status = response.status();
    if status.is_success() {
        Ok(())
    } else {
        Err(NetError::Status(status.as_u16()))
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Downloaded {
    /// Lowercase hex SHA-256 of the file.
    pub sha256: String,
    pub size: u64,
}

/// Removes the temp file on every error path.
struct TempFile {
    path: PathBuf,
    keep: bool,
}

impl Drop for TempFile {
    fn drop(&mut self) {
        if !self.keep {
            let _ = std::fs::remove_file(&self.path);
        }
    }
}

/// Streams `url` to `dest` (its directory must exist), at most `max_bytes`.
/// The body goes to a temp file in the same directory while its SHA-256 is
/// computed; with `expected_sha256` a mismatch is an error and nothing is
/// left behind. Only a complete (and verified) file is renamed to `dest`,
/// replacing an existing one. `on_progress(received, total)` is called for
/// every chunk (`total` from Content-Length, when sent).
pub async fn download_verified(
    client: &reqwest::Client,
    url: &str,
    dest: &Path,
    max_bytes: u64,
    expected_sha256: Option<&str>,
    mut on_progress: impl FnMut(u64, Option<u64>),
) -> Result<Downloaded, NetError> {
    let expected = expected_sha256
        .map(|hash| normalize_sha256(hash).ok_or(NetError::InvalidChecksum))
        .transpose()?;
    let dir = dest
        .parent()
        .ok_or_else(|| NetError::Io("the download has no target directory".to_string()))?;
    let name = dest
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "download".to_string());

    let mut response = client.get(url).send().await?;
    check_status(&response)?;
    let total = response.content_length();
    if total.is_some_and(|len| len > max_bytes) {
        return Err(NetError::TooLarge(max_bytes));
    }

    let mut temp = TempFile {
        path: dir.join(format!(".{name}.{}.part", uuid::Uuid::new_v4().simple())),
        keep: false,
    };
    let mut file = tokio::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temp.path)
        .await?;

    let mut hasher = Sha256::new();
    let mut received: u64 = 0;
    on_progress(0, total);
    let streamed: Result<(), NetError> = async {
        while let Some(chunk) = response.chunk().await? {
            received += chunk.len() as u64;
            if received > max_bytes {
                return Err(NetError::TooLarge(max_bytes));
            }
            hasher.update(&chunk);
            file.write_all(&chunk).await?;
            on_progress(received, total);
        }
        file.flush().await?;
        file.sync_all().await?;
        Ok(())
    }
    .await;
    // Also on errors: let tokio finish its background write so the handle
    // is closed here, before the temp file is removed (Windows refuses to
    // delete open files) and so nothing writes to it afterwards.
    let _ = file.flush().await;
    drop(file);
    streamed?;

    let actual = format!("{:x}", hasher.finalize());
    if let Some(expected) = expected {
        if expected != actual {
            return Err(NetError::ChecksumMismatch { expected, actual });
        }
    }

    tokio::fs::rename(&temp.path, dest).await?;
    temp.keep = true;
    Ok(Downloaded {
        sha256: actual,
        size: received,
    })
}

/// A SHA-256 hex digest, lowercased; None when `hash` isn't one.
pub fn normalize_sha256(hash: &str) -> Option<String> {
    let hash = hash.trim();
    (hash.len() == 64 && hash.bytes().all(|b| b.is_ascii_hexdigit()))
        .then(|| hash.to_ascii_lowercase())
}

/// The SHA-256 from a published checksum file: either a bare digest
/// (`kubectl.sha256`) or `sha256sum` lines (`<digest>  <file>`, optionally
/// `*<file>`), in which case the line for `file_name` is used.
pub fn parse_sha256_file(text: &str, file_name: &str) -> Option<String> {
    for line in text.lines() {
        let mut parts = line.split_whitespace();
        let Some(hash) = parts.next().and_then(normalize_sha256) else {
            continue;
        };
        match parts.next() {
            None => return Some(hash),
            Some(name) => {
                let name = name.trim_start_matches('*');
                let base = name.rsplit(['/', '\\']).next().unwrap_or(name);
                if base == file_name {
                    return Some(hash);
                }
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::AsyncReadExt;

    /// A one-route HTTP/1.1 server on localhost answering every request
    /// with `status` and `body` (Content-Length only when `length`).
    async fn serve(status: u16, body: Vec<u8>, length: bool) -> String {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            while let Ok((mut socket, _)) = listener.accept().await {
                let body = body.clone();
                tokio::spawn(async move {
                    let mut head = Vec::new();
                    let mut buf = [0u8; 1024];
                    while !head.windows(4).any(|w| w == b"\r\n\r\n") {
                        match socket.read(&mut buf).await {
                            Ok(0) | Err(_) => return,
                            Ok(n) => head.extend_from_slice(&buf[..n]),
                        }
                    }
                    let mut response = format!("HTTP/1.1 {status} X\r\nConnection: close\r\n");
                    if length {
                        response.push_str(&format!("Content-Length: {}\r\n", body.len()));
                    }
                    response.push_str("\r\n");
                    let _ = socket.write_all(response.as_bytes()).await;
                    let _ = socket.write_all(&body).await;
                    let _ = socket.shutdown().await;
                });
            }
        });
        format!("http://{addr}/file")
    }

    fn client() -> reqwest::Client {
        reqwest::Client::builder().no_proxy().build().unwrap()
    }

    fn sha256(bytes: &[u8]) -> String {
        format!("{:x}", Sha256::digest(bytes))
    }

    fn leftovers(dir: &Path) -> Vec<String> {
        std::fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect()
    }

    #[tokio::test]
    async fn downloads_verifies_and_reports_progress() {
        let body = vec![7u8; 300 * 1024];
        let url = serve(200, body.clone(), true).await;
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("kubectl");
        // A previous version is replaced.
        std::fs::write(&dest, b"old").unwrap();

        let mut progress = Vec::new();
        let expected = sha256(&body).to_uppercase();
        let done = download_verified(
            &client(),
            &url,
            &dest,
            1024 * 1024,
            Some(&expected),
            |r, t| progress.push((r, t)),
        )
        .await
        .unwrap();

        assert_eq!(
            done,
            Downloaded {
                sha256: sha256(&body),
                size: body.len() as u64
            }
        );
        assert_eq!(std::fs::read(&dest).unwrap(), body);
        assert_eq!(progress.first(), Some(&(0, Some(body.len() as u64))));
        assert_eq!(
            progress.last(),
            Some(&(body.len() as u64, Some(body.len() as u64)))
        );
        assert_eq!(leftovers(dir.path()), vec!["kubectl"]);
    }

    #[tokio::test]
    async fn checksum_mismatch_leaves_nothing_behind() {
        let url = serve(200, b"tampered".to_vec(), true).await;
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("kubectl");
        let err = download_verified(
            &client(),
            &url,
            &dest,
            1024,
            Some(&sha256(b"original")),
            |_, _| {},
        )
        .await
        .unwrap_err();
        assert!(matches!(err, NetError::ChecksumMismatch { .. }), "{err}");
        assert!(leftovers(dir.path()).is_empty());

        let err = download_verified(&client(), &url, &dest, 1024, Some("not-a-hash"), |_, _| {})
            .await
            .unwrap_err();
        assert_eq!(err, NetError::InvalidChecksum);
    }

    #[tokio::test]
    async fn size_cap_holds_with_and_without_content_length() {
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("big");
        for length in [true, false] {
            let url = serve(200, vec![1u8; 64 * 1024], length).await;
            let err = download_verified(&client(), &url, &dest, 1024, None, |_, _| {})
                .await
                .unwrap_err();
            assert_eq!(err, NetError::TooLarge(1024));
            assert!(leftovers(dir.path()).is_empty());

            let err = get_capped(&client(), &url, 1024).await.unwrap_err();
            assert_eq!(err, NetError::TooLarge(1024));
        }
    }

    #[tokio::test]
    async fn http_errors_are_reported() {
        let url = serve(404, b"not found".to_vec(), true).await;
        let dir = tempfile::tempdir().unwrap();
        let err = download_verified(
            &client(),
            &url,
            &dir.path().join("x"),
            1024,
            None,
            |_, _| {},
        )
        .await
        .unwrap_err();
        assert_eq!(err, NetError::Status(404));
        assert_eq!(
            get_capped(&client(), &url, 1024).await.unwrap_err(),
            NetError::Status(404)
        );

        let url = serve(200, b"{}".to_vec(), true).await;
        assert_eq!(get_capped(&client(), &url, 1024).await.unwrap(), b"{}");
    }

    #[test]
    fn redirects_stay_on_allowed_https_hosts() {
        let hosts = vec!["dl.k8s.io".to_string(), "cdn.dl.k8s.io".to_string()];
        let url = |u: &str| reqwest::Url::parse(u).unwrap();
        assert!(redirect_allowed(
            &url("https://cdn.dl.k8s.io/release/x"),
            &hosts
        ));
        assert!(redirect_allowed(&url("https://DL.K8S.IO/x"), &hosts));
        assert!(!redirect_allowed(&url("http://dl.k8s.io/x"), &hosts));
        assert!(!redirect_allowed(&url("https://evil.example/x"), &hosts));
        assert!(!redirect_allowed(
            &url("https://dl.k8s.io.evil.example/x"),
            &hosts
        ));
    }

    #[test]
    fn checksum_files() {
        let hash = "7721f265e18709862655affba5343e85e1980639395d5754473dafaadcaa69e3";
        // dl.k8s.io: a bare digest.
        assert_eq!(
            parse_sha256_file(&format!("{hash}\n"), "kubectl"),
            Some(hash.to_string())
        );
        // get.helm.sh: sha256sum format.
        let line = format!("{}  helm-v3.19.0-linux-amd64.tar.gz\n", hash.to_uppercase());
        assert_eq!(
            parse_sha256_file(&line, "helm-v3.19.0-linux-amd64.tar.gz"),
            Some(hash.to_string())
        );
        assert_eq!(
            parse_sha256_file(&line, "helm-v3.19.0-darwin-arm64.tar.gz"),
            None
        );
        // Several files, binary marker and paths.
        let other = "a".repeat(64);
        let multi = format!("{other} *./dist/other.zip\n{hash} *./dist/helm.zip\n");
        assert_eq!(
            parse_sha256_file(&multi, "helm.zip"),
            Some(hash.to_string())
        );
        // Garbage.
        assert_eq!(parse_sha256_file("<html>404</html>", "kubectl"), None);
        assert_eq!(parse_sha256_file(&hash[..63], "kubectl"), None);
    }
}

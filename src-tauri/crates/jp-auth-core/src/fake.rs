//! A tiny HTTP/1.1 server for tests: AWS and cloud API clients get its URL
//! as their endpoint override. One request per connection
//! (`connection: close`).

use std::sync::{Arc, Mutex};

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

#[derive(Debug, Clone)]
pub struct FakeRequest {
    pub method: String,
    /// Without the query.
    pub path: String,
    pub query: String,
    pub headers: Vec<(String, String)>,
    pub body: String,
}

impl FakeRequest {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(n, _)| n.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
    }

    /// A query parameter (not percent-decoded).
    pub fn query_param(&self, name: &str) -> Option<&str> {
        self.query
            .split('&')
            .filter_map(|pair| pair.split_once('='))
            .find(|(k, _)| *k == name)
            .map(|(_, v)| v)
    }

    pub fn json(&self) -> serde_json::Value {
        serde_json::from_str(&self.body).unwrap_or(serde_json::Value::Null)
    }
}

#[derive(Debug, Clone)]
pub struct FakeResponse {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: String,
}

impl FakeResponse {
    pub fn json(status: u16, body: serde_json::Value) -> FakeResponse {
        FakeResponse {
            status,
            headers: vec![("content-type".into(), "application/json".into())],
            body: body.to_string(),
        }
    }

    pub fn xml(status: u16, body: &str) -> FakeResponse {
        FakeResponse {
            status,
            headers: vec![("content-type".into(), "text/xml".into())],
            body: body.to_string(),
        }
    }

    /// A restJson error with `x-amzn-errortype`.
    pub fn error(status: u16, code: &str, message: &str) -> FakeResponse {
        FakeResponse {
            status,
            headers: vec![
                ("content-type".into(), "application/json".into()),
                (
                    "x-amzn-errortype".into(),
                    format!("{code}:http://internal.amazon.com/coral/"),
                ),
            ],
            body:
                serde_json::json!({"error": code, "error_description": message, "message": message})
                    .to_string(),
        }
    }
}

type Handler = dyn Fn(&FakeRequest) -> FakeResponse + Send + Sync;

pub struct FakeServer {
    pub url: String,
    requests: Arc<Mutex<Vec<FakeRequest>>>,
    task: tokio::task::JoinHandle<()>,
}

impl Drop for FakeServer {
    fn drop(&mut self) {
        self.task.abort();
    }
}

fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).position(|w| w == needle)
}

async fn serve(
    mut stream: tokio::net::TcpStream,
    handler: Arc<Handler>,
    log: Arc<Mutex<Vec<FakeRequest>>>,
) {
    let mut buffer = Vec::new();
    let mut chunk = [0u8; 8192];
    let head_end = loop {
        if let Some(at) = find(&buffer, b"\r\n\r\n") {
            break at;
        }
        match stream.read(&mut chunk).await {
            Ok(0) | Err(_) => return,
            Ok(n) => buffer.extend_from_slice(&chunk[..n]),
        }
    };
    let head = String::from_utf8_lossy(&buffer[..head_end]).into_owned();
    let mut lines = head.split("\r\n");
    let mut first = lines.next().unwrap_or_default().split(' ');
    let method = first.next().unwrap_or_default().to_string();
    let target = first.next().unwrap_or_default().to_string();
    let headers: Vec<(String, String)> = lines
        .filter_map(|l| l.split_once(':'))
        .map(|(n, v)| (n.trim().to_ascii_lowercase(), v.trim().to_string()))
        .collect();
    let length: usize = headers
        .iter()
        .find(|(n, _)| n == "content-length")
        .and_then(|(_, v)| v.parse().ok())
        .unwrap_or(0);
    let mut body = buffer[head_end + 4..].to_vec();
    while body.len() < length {
        match stream.read(&mut chunk).await {
            Ok(0) | Err(_) => break,
            Ok(n) => body.extend_from_slice(&chunk[..n]),
        }
    }
    let (path, query) = match target.split_once('?') {
        Some((p, q)) => (p.to_string(), q.to_string()),
        None => (target.clone(), String::new()),
    };
    let request = FakeRequest {
        method,
        path,
        query,
        headers,
        body: String::from_utf8_lossy(&body).into_owned(),
    };
    let response = handler(&request);
    log.lock().unwrap().push(request);
    let reason = match response.status {
        200 => "OK",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        429 => "Too Many Requests",
        500 => "Internal Server Error",
        503 => "Service Unavailable",
        _ => "Status",
    };
    let mut out = format!("HTTP/1.1 {} {reason}\r\n", response.status);
    for (name, value) in &response.headers {
        out.push_str(&format!("{name}: {value}\r\n"));
    }
    out.push_str(&format!(
        "content-length: {}\r\nconnection: close\r\n\r\n",
        response.body.len()
    ));
    out.push_str(&response.body);
    let _ = stream.write_all(out.as_bytes()).await;
    let _ = stream.shutdown().await;
}

impl FakeServer {
    /// Serves `handler` on `127.0.0.1:<random>` until dropped.
    pub async fn start(
        handler: impl Fn(&FakeRequest) -> FakeResponse + Send + Sync + 'static,
    ) -> FakeServer {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind a local port");
        let url = format!("http://{}", listener.local_addr().unwrap());
        let requests = Arc::new(Mutex::new(Vec::new()));
        let handler: Arc<Handler> = Arc::new(handler);
        let log = requests.clone();
        let task = tokio::spawn(async move {
            while let Ok((stream, _)) = listener.accept().await {
                tokio::spawn(serve(stream, handler.clone(), log.clone()));
            }
        });
        FakeServer {
            url,
            requests,
            task,
        }
    }

    pub fn requests(&self) -> Vec<FakeRequest> {
        self.requests.lock().unwrap().clone()
    }
}

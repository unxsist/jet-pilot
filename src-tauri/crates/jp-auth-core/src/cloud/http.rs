//! The HTTP client of the cloud APIs: the AWS SDK's hyper + rustls (ring)
//! connector (never aws-lc or OpenSSL), the system trust store and
//! `HTTPS_PROXY` / `NO_PROXY` from the environment.
//!
//! - Requests only go to the provider's own API hosts over https (or the
//!   context's loopback test endpoint); redirects are never followed.
//! - Each attempt has a timeout; 429 and 5xx answers and network errors are
//!   retried with exponential backoff (or `Retry-After`).
//! - Bodies are capped at 8 MiB.

use std::sync::OnceLock;
use std::time::Duration;

use aws_smithy_async::rt::sleep::TokioSleep;
use aws_smithy_http_client::proxy::ProxyConfig;
use aws_smithy_http_client::tls::{self, rustls_provider::CryptoMode};
use aws_smithy_http_client::Connector;
use aws_smithy_runtime_api::client::http::{HttpConnector, HttpConnectorSettings};
use aws_smithy_runtime_api::client::orchestrator::HttpRequest;
use aws_smithy_types::body::SdkBody;
use aws_smithy_types::byte_stream::ByteStream;
use aws_smithy_types::error::display::DisplayErrorContext;

use super::{CloudContext, CloudError, Provider};

const MAX_BODY: usize = 8 * 1024 * 1024;
const MAX_BACKOFF: Duration = Duration::from_secs(10);
const USER_AGENT: &str = "JET-Pilot";

fn connector() -> &'static Connector {
    static CONNECTOR: OnceLock<Connector> = OnceLock::new();
    CONNECTOR.get_or_init(|| {
        Connector::builder()
            .proxy_config(ProxyConfig::from_env())
            .sleep_impl(TokioSleep::new())
            .connector_settings(
                HttpConnectorSettings::builder()
                    .connect_timeout(Duration::from_secs(10))
                    .read_timeout(Duration::from_secs(30))
                    .build(),
            )
            .tls_provider(tls::Provider::Rustls(CryptoMode::Ring))
            .build()
    })
}

/// A request; built again for every attempt (Exoscale signatures expire).
pub struct ApiRequest {
    pub method: &'static str,
    pub url: String,
    pub headers: Vec<(&'static str, String)>,
    pub body: Option<Vec<u8>>,
}

impl std::fmt::Debug for ApiRequest {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // Headers carry credentials: only their names.
        f.debug_struct("ApiRequest")
            .field("method", &self.method)
            .field("url", &self.url)
            .field(
                "headers",
                &self.headers.iter().map(|(n, _)| *n).collect::<Vec<_>>(),
            )
            .finish()
    }
}

impl ApiRequest {
    pub fn get(url: String) -> ApiRequest {
        ApiRequest {
            method: "GET",
            url,
            headers: Vec::new(),
            body: None,
        }
    }

    pub fn post_json(url: String, body: &serde_json::Value) -> ApiRequest {
        ApiRequest {
            method: "POST",
            url,
            headers: vec![("content-type", "application/json".to_string())],
            body: Some(body.to_string().into_bytes()),
        }
    }

    pub fn header(mut self, name: &'static str, value: String) -> ApiRequest {
        self.headers.push((name, value));
        self
    }

    pub fn bearer(self, token: &str) -> ApiRequest {
        self.header("authorization", format!("Bearer {token}"))
    }
}

#[derive(Debug, Clone)]
pub struct ApiResponse {
    pub status: u16,
    pub retry_after: Option<Duration>,
    pub body: Vec<u8>,
}

impl ApiResponse {
    pub fn is_success(&self) -> bool {
        (200..300).contains(&self.status)
    }

    /// The body as JSON (an empty body is `null`).
    pub fn json(&self) -> Result<serde_json::Value, CloudError> {
        if self.body.iter().all(u8::is_ascii_whitespace) {
            return Ok(serde_json::Value::Null);
        }
        serde_json::from_slice(&self.body)
            .map_err(|_| CloudError::Invalid("The provider sent an unreadable answer.".into()))
    }

    /// The provider's error message, if the body has one.
    pub fn error_message(&self) -> Option<String> {
        let value: serde_json::Value = serde_json::from_slice(&self.body).ok()?;
        let pick = |v: &serde_json::Value| -> Option<String> {
            for key in ["message", "error_description", "reason", "error", "detail"] {
                if let Some(text) = v.get(key).and_then(|m| m.as_str()) {
                    if !text.trim().is_empty() {
                        return Some(text.trim().to_string());
                    }
                }
            }
            None
        };
        let message = pick(&value)
            .or_else(|| value.get("error").and_then(pick))
            .or_else(|| value.get("errors")?.as_array()?.first().and_then(pick))?;
        let message: String = message.chars().take(300).collect();
        Some(crate::redact(&message))
    }

    /// Fails unless 2xx: 401 / 403 `Unauthorized`, 404 `NotFound`, else
    /// `Service`.
    pub fn check(self, provider: Provider) -> Result<ApiResponse, CloudError> {
        if self.is_success() {
            return Ok(self);
        }
        let detail = self
            .error_message()
            .unwrap_or_else(|| format!("HTTP {}", self.status));
        Err(match self.status {
            401 | 403 => CloudError::Unauthorized(format!(
                "{} did not accept the credentials: {detail}",
                provider.name()
            )),
            404 => CloudError::NotFound(format!("{}: {detail}", provider.name())),
            status => CloudError::Service {
                status,
                message: format!("{}: {detail}", provider.name()),
            },
        })
    }
}

/// Whether `url` may be requested for `provider`: https to one of its API
/// hosts (default port), or below the context's test endpoint.
pub fn allowed(ctx: &CloudContext, provider: Provider, url: &str) -> bool {
    if let Some(endpoint) = &ctx.endpoint {
        let base = endpoint.trim_end_matches('/');
        if url
            .strip_prefix(base)
            .is_some_and(|rest| rest.starts_with('/'))
        {
            return true;
        }
    }
    let Some(rest) = url.strip_prefix("https://") else {
        return false;
    };
    let authority = rest.split(['/', '?', '#']).next().unwrap_or_default();
    if authority.contains('@') {
        return false;
    }
    let host = match authority.rsplit_once(':') {
        Some((host, "443")) => host,
        Some(_) => return false,
        None => authority,
    };
    provider.allows_host(host)
}

fn retryable(status: u16) -> bool {
    status == 429 || (500..600).contains(&status) && status != 501
}

async fn once(request: &ApiRequest) -> Result<ApiResponse, CloudError> {
    let mut builder = ::http::Request::builder()
        .method(request.method)
        .uri(&request.url)
        .header("user-agent", USER_AGENT)
        .header("accept", "application/json");
    for (name, value) in &request.headers {
        builder = builder.header(*name, value);
    }
    let body = request
        .body
        .clone()
        .map(SdkBody::from)
        .unwrap_or_else(SdkBody::empty);
    let http_request = builder
        .body(body)
        .map_err(|e| CloudError::Invalid(format!("The request is not valid: {e}")))?;
    let http_request = HttpRequest::try_from(http_request)
        .map_err(|e| CloudError::Invalid(format!("The request is not valid: {e}")))?;
    let response = connector().call(http_request).await.map_err(|e| {
        CloudError::Network(crate::redact(&format!(
            "could not be reached: {}",
            DisplayErrorContext(&e)
        )))
    })?;
    let status = response.status().as_u16();
    let headers = response.headers();
    if headers
        .get("content-length")
        .and_then(|v| v.trim().parse::<usize>().ok())
        .is_some_and(|len| len > MAX_BODY)
    {
        return Err(CloudError::Invalid(
            "The provider's answer is too large.".into(),
        ));
    }
    let retry_after = headers
        .get("retry-after")
        .and_then(|v| v.trim().parse::<u64>().ok())
        .map(Duration::from_secs);
    let body = ByteStream::new(response.into_body())
        .collect()
        .await
        .map_err(|e| CloudError::Network(format!("the answer was cut off: {e}")))?
        .into_bytes();
    if body.len() > MAX_BODY {
        return Err(CloudError::Invalid(
            "The provider's answer is too large.".into(),
        ));
    }
    Ok(ApiResponse {
        status,
        retry_after,
        body: body.to_vec(),
    })
}

/// Sends the request `build` makes, retrying 429 / 5xx answers and network
/// failures. The last answer is returned as it is (check its status).
pub async fn send(
    ctx: &CloudContext,
    provider: Provider,
    build: &(dyn Fn() -> Result<ApiRequest, CloudError> + Send + Sync),
) -> Result<ApiResponse, CloudError> {
    let attempts = ctx.max_attempts.max(1);
    let mut attempt = 0;
    loop {
        attempt += 1;
        let request = build()?;
        if !allowed(ctx, provider, &request.url) {
            return Err(CloudError::Invalid(format!(
                "Refusing to send a request for {} to {}.",
                provider.name(),
                request.url.split('?').next().unwrap_or_default()
            )));
        }
        let wait = match tokio::time::timeout(ctx.timeout, once(&request)).await {
            Ok(Ok(response)) if retryable(response.status) && attempt < attempts => {
                response.retry_after
            }
            Ok(Ok(response)) => return Ok(response),
            Ok(Err(CloudError::Network(message))) => {
                if attempt >= attempts {
                    return Err(CloudError::Network(format!(
                        "{} {message}",
                        provider.name()
                    )));
                }
                None
            }
            Ok(Err(other)) => return Err(other),
            Err(_) => {
                if attempt >= attempts {
                    return Err(CloudError::Network(format!(
                        "{} did not answer in time",
                        provider.name()
                    )));
                }
                None
            }
        };
        let backoff = wait
            .unwrap_or_else(|| ctx.initial_backoff * 2u32.saturating_pow(attempt - 1))
            .min(MAX_BACKOFF);
        tokio::time::sleep(backoff).await;
    }
}

/// [`send`], then the JSON of a 2xx answer (see [`ApiResponse::check`]).
pub async fn json(
    ctx: &CloudContext,
    provider: Provider,
    build: &(dyn Fn() -> Result<ApiRequest, CloudError> + Send + Sync),
) -> Result<serde_json::Value, CloudError> {
    send(ctx, provider, build).await?.check(provider)?.json()
}

//! The HTTP client of every AWS SDK client: hyper + rustls with ring
//! (never aws-lc), the system trust store, and `HTTPS_PROXY` / `NO_PROXY`
//! from the environment. Plain `http://` is only ever used for endpoint
//! overrides (tests).

use std::sync::OnceLock;

use aws_smithy_async::rt::sleep::{SharedAsyncSleep, TokioSleep};
use aws_smithy_async::time::{SharedTimeSource, SystemTimeSource};
use aws_smithy_http_client::proxy::ProxyConfig;
use aws_smithy_http_client::tls::{self, rustls_provider::CryptoMode};
use aws_smithy_http_client::{Builder, Connector};
use aws_smithy_runtime_api::client::http::SharedHttpClient;
use aws_smithy_types::retry::RetryConfig;
use aws_smithy_types::timeout::TimeoutConfig;

use super::AwsContext;

/// The shared client (connection pool) of the process.
pub fn http_client() -> SharedHttpClient {
    static CLIENT: OnceLock<SharedHttpClient> = OnceLock::new();
    CLIENT
        .get_or_init(|| {
            Builder::new().build_with_connector_fn(|settings, components| {
                let mut builder = Connector::builder().proxy_config(ProxyConfig::from_env());
                builder.set_connector_settings(settings.cloned());
                if let Some(sleep) = components.and_then(|c| c.sleep_impl()) {
                    builder.set_sleep_impl(Some(sleep));
                }
                builder
                    .tls_provider(tls::Provider::Rustls(CryptoMode::Ring))
                    .build()
            })
        })
        .clone()
}

impl AwsContext {
    pub fn retry_config(&self) -> RetryConfig {
        RetryConfig::standard()
            .with_max_attempts(self.max_attempts.max(1))
            .with_initial_backoff(self.initial_backoff)
    }

    pub fn timeout_config(&self) -> TimeoutConfig {
        TimeoutConfig::builder()
            .connect_timeout(self.timeout)
            .operation_attempt_timeout(self.timeout)
            .operation_timeout(self.timeout * self.max_attempts.max(1) + self.initial_backoff * 8)
            .build()
    }
}

/// Sets the common parts of an SDK client config builder: behavior
/// version, region, HTTP client, sleep, time, retries, timeouts and an
/// optional endpoint override (`Option<&str>`).
#[macro_export]
macro_rules! aws_client_config {
    ($builder:expr, $ctx:expr, $region:expr, $endpoint:expr) => {{
        let mut builder = $builder
            .behavior_version($crate::aws::aws_config::BehaviorVersion::latest())
            .region($crate::aws::aws_config::Region::new($region.to_string()))
            .http_client($crate::aws::http::http_client())
            .sleep_impl($crate::aws::http::shared_sleep())
            .time_source($crate::aws::http::shared_time_source())
            .retry_config($ctx.retry_config())
            .timeout_config($ctx.timeout_config());
        if let Some(url) = $endpoint {
            builder = builder.endpoint_url(url.to_string());
        }
        builder
    }};
}

#[doc(hidden)]
pub fn shared_sleep() -> SharedAsyncSleep {
    SharedAsyncSleep::new(TokioSleep::new())
}

#[doc(hidden)]
pub fn shared_time_source() -> SharedTimeSource {
    SharedTimeSource::new(SystemTimeSource::new())
}

//! Tower layers of the API clients (see `kubernetes::client::build_client`):
//!
//! - `BrokerTokenLayer` asks the broker for the exec credential's token on
//!   every request (cached there until shortly before it expires) and sets
//!   the `Authorization` header. A credential failure fails the request
//!   with an `AuthFailure` (and is reported to the auth center).
//! - `ObserveLayer` watches responses: a 401 is reported as an auth issue
//!   and (for broker credentials) drops the cached credential so the next
//!   request mints a new one.
//!
//! The services run their futures in the caller's task (kube's buffer only
//! moves `call` to its worker), so `center::current_source()` tells whether
//! a watch, the metrics poller or a command sent the request.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};
use std::time::Duration;

use futures::future::BoxFuture;
use http::header::AUTHORIZATION;
use http::{HeaderValue, Request, Response, StatusCode};
use kube::client::Body;
use kube::config::ExecConfig;
use tower::buffer::Buffer;
use tower::{BoxError, Layer, Service, ServiceExt};

use super::broker::{self, Slot};
use super::center::{self, AuthErrorKind, AuthIssue};

/// Requests queued in front of the client stack.
const BUFFER: usize = 1024;
/// A rejected credential is only re-minted when it is at least this old (a
/// server that rejects fresh credentials, e.g. an unmapped IAM identity,
/// must not cause a plugin run per request).
const REMINT_AFTER_401: Duration = Duration::from_secs(60);

/// Which context a client belongs to, for issues and errors.
#[derive(Debug, Clone, PartialEq)]
pub struct ClientTarget {
    pub kube_config: String,
    pub context: String,
    /// Basename of the exec plugin, if any.
    pub command: Option<String>,
}

#[derive(Clone)]
pub struct BrokerTokenLayer {
    slot: Arc<Slot>,
    exec: Arc<ExecConfig>,
    target: Arc<ClientTarget>,
}

impl BrokerTokenLayer {
    pub fn new(slot: Arc<Slot>, exec: ExecConfig, target: ClientTarget) -> Self {
        BrokerTokenLayer {
            slot,
            exec: Arc::new(exec),
            target: Arc::new(target),
        }
    }
}

impl<S> Layer<S> for BrokerTokenLayer
where
    S: Service<Request<Body>> + Send + 'static,
    S::Future: Send + 'static,
    S::Error: Into<BoxError> + Send + Sync,
{
    type Service = BrokerTokenService<S::Future>;

    fn layer(&self, inner: S) -> Self::Service {
        BrokerTokenService {
            // The inner stack isn't Clone; the buffer is, so the future can
            // own a handle to it while it waits for the token.
            inner: Buffer::new(inner, BUFFER),
            slot: self.slot.clone(),
            exec: self.exec.clone(),
            target: self.target.clone(),
        }
    }
}

pub struct BrokerTokenService<F> {
    inner: Buffer<Request<Body>, F>,
    slot: Arc<Slot>,
    exec: Arc<ExecConfig>,
    target: Arc<ClientTarget>,
}

impl<F, Rsp, E> Service<Request<Body>> for BrokerTokenService<F>
where
    F: Future<Output = Result<Rsp, E>> + Send + 'static,
    E: Into<BoxError>,
    Rsp: Send + 'static,
{
    type Response = Rsp;
    type Error = BoxError;
    type Future = BoxFuture<'static, Result<Rsp, BoxError>>;

    fn poll_ready(&mut self, _cx: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        // Readiness of the inner stack is awaited in the future, after the
        // token: a slot must not be held while a plugin runs.
        Poll::Ready(Ok(()))
    }

    fn call(&mut self, mut request: Request<Body>) -> Self::Future {
        let mut inner = self.inner.clone();
        let slot = self.slot.clone();
        let exec = self.exec.clone();
        let target = self.target.clone();
        Box::pin(async move {
            let credential = broker::credential_in(&slot, &exec, broker::BACKGROUND_TIMEOUT)
                .await
                .map_err(|err| {
                    let failure = err.to_failure(&target.kube_config, &target.context);
                    center::report_failure(&failure, center::current_source());
                    BoxError::from(failure)
                })?;
            if let Some(token) = credential.token.as_deref() {
                let mut value = HeaderValue::try_from(format!("Bearer {token}"))
                    .map_err(|_| BoxError::from("the exec credential plugin returned an invalid token"))?;
                value.set_sensitive(true);
                request.headers_mut().insert(AUTHORIZATION, value);
            }
            inner.ready().await?.call(request).await
        })
    }
}

#[derive(Clone)]
pub struct ObserveLayer {
    target: Arc<ClientTarget>,
    slot: Option<Arc<Slot>>,
}

impl ObserveLayer {
    pub fn new(target: ClientTarget, slot: Option<Arc<Slot>>) -> Self {
        ObserveLayer {
            target: Arc::new(target),
            slot,
        }
    }
}

impl<S> Layer<S> for ObserveLayer {
    type Service = ObserveService<S>;

    fn layer(&self, inner: S) -> Self::Service {
        ObserveService {
            inner,
            target: self.target.clone(),
            slot: self.slot.clone(),
        }
    }
}

pub struct ObserveService<S> {
    inner: S,
    target: Arc<ClientTarget>,
    slot: Option<Arc<Slot>>,
}

impl<S, B> Service<Request<Body>> for ObserveService<S>
where
    S: Service<Request<Body>, Response = Response<B>>,
    S::Future: Send + 'static,
    S::Error: Send + 'static,
    B: Send + 'static,
{
    type Response = Response<B>;
    type Error = S::Error;
    type Future = Pin<Box<dyn Future<Output = Result<Response<B>, S::Error>> + Send>>;

    fn poll_ready(&mut self, cx: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        self.inner.poll_ready(cx)
    }

    fn call(&mut self, request: Request<Body>) -> Self::Future {
        let response = self.inner.call(request);
        let target = self.target.clone();
        let slot = self.slot.clone();
        Box::pin(async move {
            let response = response.await?;
            if response.status() == StatusCode::UNAUTHORIZED {
                rejected(&target, slot.as_deref());
            }
            Ok(response)
        })
    }
}

/// The server answered 401.
fn rejected(target: &ClientTarget, slot: Option<&Slot>) {
    center::report(AuthIssue {
        kube_config: target.kube_config.clone(),
        context: target.context.clone(),
        kind: AuthErrorKind::Unauthorized,
        source: center::current_source(),
        message: "The API server rejected the credentials (401 Unauthorized)".to_string(),
        command: target.command.clone(),
    });
    if let Some(slot) = slot {
        slot.clear_if_older(REMINT_AFTER_401);
    }
}

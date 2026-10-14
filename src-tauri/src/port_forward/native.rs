//! Native forwarding over the Kubernetes API (kube-rs, WebSocket).
//!
//! The local listener stays open for the whole life of the forward. Every
//! accepted connection gets its own port-forward stream to the pod the
//! supervisor currently trusts. The supervisor resolves the target to a
//! ready pod, watches that pod, and when it goes away (rollout, crash,
//! eviction) or a stream can't be opened, resolves again with backoff.
//! Connections that arrive meanwhile wait for the next pod, so clients
//! reconnect transparently.
//!
//! The cluster side is behind [`Backends`], so the listener, the
//! supervisor and the state machine run in tests against a fake.

use std::net::SocketAddr;
use std::pin::Pin;
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll};
use std::time::Duration;

use futures::future::BoxFuture;
use futures::{FutureExt, StreamExt};
use kube::runtime::watcher::{self, Event};
use kube::runtime::WatchStreamExt;
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{mpsc, watch};
use tokio::task::JoinSet;
use tokio::time::Instant;
use tracing::{debug, info, warn};

use super::machine::{self, Decision, Failure, FailureKind};
use super::resolve::{self, Resolver, TargetKind};
use super::{now_ms, ForwardStatus, PortForwardInfo, TrafficSnapshot};
use crate::auth::center::{self, IssueSource};
use crate::util::lock;

/// How long a new connection waits for a pod while the forward reconnects.
const CONNECT_WAIT: Duration = Duration::from_secs(20);
/// How long a probe waits for the pod to report that nothing listens.
const PROBE_WAIT: Duration = Duration::from_millis(300);

pub trait AsyncIo: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send> AsyncIo for T {}

/// One stream to the pod's port.
pub struct Upstream {
    pub io: Box<dyn AsyncIo>,
    /// Resolves once the stream is closed, with the error the pod reported
    /// for it (if any).
    pub done: BoxFuture<'static, Option<String>>,
}

/// The cluster side of a forward.
pub trait Backends: Send + Sync + 'static {
    /// A pod and container port to use, checked by opening a stream.
    fn resolve(&self, current: Option<String>, avoid: Option<String>) -> BoxFuture<'static, Result<(String, u16), Failure>>;
    /// A stream to `port` on `pod`.
    fn open(&self, pod: &str, port: u16) -> BoxFuture<'static, Result<Upstream, Failure>>;
    /// Resolves (with the reason) when `pod` should no longer be used.
    fn watch(&self, pod: &str) -> BoxFuture<'static, &'static str>;
}

/// Byte and connection counters, cheap enough to keep for every forward.
#[derive(Default)]
pub struct Traffic {
    open: AtomicU32,
    total: AtomicU64,
    sent: AtomicU64,
    received: AtomicU64,
}

impl Traffic {
    pub fn snapshot(&self) -> TrafficSnapshot {
        TrafficSnapshot {
            open_connections: self.open.load(Ordering::Relaxed),
            connections: self.total.load(Ordering::Relaxed),
            bytes_sent: self.sent.load(Ordering::Relaxed),
            bytes_received: self.received.load(Ordering::Relaxed),
        }
    }

    fn connection(self: &Arc<Self>) -> OpenConnection {
        self.open.fetch_add(1, Ordering::Relaxed);
        self.total.fetch_add(1, Ordering::Relaxed);
        OpenConnection(self.clone())
    }
}

struct OpenConnection(Arc<Traffic>);

impl Drop for OpenConnection {
    fn drop(&mut self) {
        self.0.open.fetch_sub(1, Ordering::Relaxed);
    }
}

/// The local side of a connection, counting bytes both ways.
struct Counted<S> {
    inner: S,
    traffic: Arc<Traffic>,
}

impl<S: AsyncRead + Unpin> AsyncRead for Counted<S> {
    fn poll_read(mut self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &mut ReadBuf<'_>) -> Poll<std::io::Result<()>> {
        let before = buf.filled().len();
        let result = Pin::new(&mut self.inner).poll_read(cx, buf);
        let read = (buf.filled().len() - before) as u64;
        self.traffic.sent.fetch_add(read, Ordering::Relaxed);
        result
    }
}

impl<S: AsyncWrite + Unpin> AsyncWrite for Counted<S> {
    fn poll_write(mut self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &[u8]) -> Poll<std::io::Result<usize>> {
        let result = Pin::new(&mut self.inner).poll_write(cx, buf);
        if let Poll::Ready(Ok(n)) = &result {
            self.traffic.received.fetch_add(*n as u64, Ordering::Relaxed);
        }
        result
    }

    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.inner).poll_flush(cx)
    }

    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.inner).poll_shutdown(cx)
    }
}

/// The pod connections use, numbered so a failure report about an older
/// pod doesn't trigger another reconnect.
#[derive(Clone, Debug, PartialEq)]
struct Backend {
    pod: String,
    port: u16,
    generation: u64,
}

/// A connection couldn't open a stream to the pod of `generation`.
struct Lost {
    generation: u64,
    reason: &'static str,
}

pub type Emit = Arc<dyn Fn(&'static str, PortForwardInfo) + Send + Sync>;

pub struct Forward<B> {
    pub info: Arc<Mutex<PortForwardInfo>>,
    pub traffic: Arc<Traffic>,
    pub backends: Arc<B>,
    pub emit: Emit,
}

impl<B> Forward<B> {
    /// Applies a transition and emits its event.
    fn update(&self, transition: impl FnOnce(&mut PortForwardInfo) -> Option<&'static str>) {
        let event = {
            let mut info = lock(&self.info);
            transition(&mut info).map(|event| (event, info.clone()))
        };
        if let Some((event, mut payload)) = event {
            payload.traffic = self.traffic.snapshot();
            (self.emit)(event, payload);
        }
    }

    fn status(&self) -> ForwardStatus {
        lock(&self.info).status
    }
}

/// How a native forward ended.
#[derive(Debug, PartialEq)]
pub enum Outcome {
    /// It went to error; `started` = it had been ready before.
    Failed { started: bool },
    /// The cluster doesn't do WebSocket port-forwarding: use kubectl.
    Fallback(String),
}

/// Binds the local address. `localhost` listens on IPv4 and (when
/// available) IPv6 like kubectl; port 0 picks a free port.
pub async fn bind(address: &str, port: u16) -> Result<Vec<TcpListener>, String> {
    let addrs: Vec<SocketAddr> = if address.eq_ignore_ascii_case("localhost") {
        vec![SocketAddr::from(([127, 0, 0, 1], port)), SocketAddr::from((std::net::Ipv6Addr::LOCALHOST, port))]
    } else {
        tokio::net::lookup_host((address, port))
            .await
            .map_err(|e| format!("Can't listen on {address}: {e}"))?
            .collect()
    };

    let mut listeners: Vec<TcpListener> = Vec::new();
    let mut first_error: Option<std::io::Error> = None;
    for addr in addrs {
        // With port 0, the other addresses must use the port the first got.
        let addr = match listeners.first().and_then(|l| l.local_addr().ok()) {
            Some(bound) if port == 0 => SocketAddr::new(addr.ip(), bound.port()),
            _ => addr,
        };
        match TcpListener::bind(addr).await {
            Ok(listener) => listeners.push(listener),
            // The first address (IPv4 for localhost) must work.
            Err(e) if listeners.is_empty() => {
                first_error = Some(e);
                break;
            }
            Err(e) => debug!("Not listening on {addr}: {e}"),
        }
    }
    if listeners.is_empty() {
        return Err(bind_error(address, port, first_error));
    }
    Ok(listeners)
}

fn bind_error(address: &str, port: u16, error: Option<std::io::Error>) -> String {
    use std::io::ErrorKind;
    match error {
        Some(e) if e.kind() == ErrorKind::AddrInUse => format!("Port {port} is already in use on {address}"),
        Some(e) if e.kind() == ErrorKind::PermissionDenied => {
            format!("Port {port} needs administrator rights on this machine; pick one from 1024 up")
        }
        Some(e) if e.kind() == ErrorKind::AddrNotAvailable => format!("{address} isn't an address of this machine"),
        Some(e) => format!("Can't listen on {address}:{port}: {e}"),
        None => format!("Can't listen on {address}:{port}"),
    }
}

/// Runs a forward on bound listeners until it fails or falls back to
/// kubectl (stopping aborts the task). Listeners and connections close
/// when this returns.
pub async fn run<B: Backends>(forward: Forward<B>, listeners: Vec<TcpListener>, startup: Duration) -> Outcome {
    let (pod_tx, pod_rx) = watch::channel::<Option<Backend>>(None);
    let (lost_tx, lost_rx) = mpsc::unbounded_channel::<Lost>();
    let mut accepting = JoinSet::new();
    for listener in listeners {
        accepting.spawn(accept_loop(
            listener,
            forward.backends.clone(),
            pod_rx.clone(),
            lost_tx.clone(),
            forward.traffic.clone(),
        ));
    }
    supervise(&forward, pod_tx, lost_rx, startup).await
}

async fn accept_loop<B: Backends>(
    listener: TcpListener,
    backends: Arc<B>,
    pod_rx: watch::Receiver<Option<Backend>>,
    lost_tx: mpsc::UnboundedSender<Lost>,
    traffic: Arc<Traffic>,
) {
    let mut connections = JoinSet::new();
    loop {
        tokio::select! {
            accepted = listener.accept() => match accepted {
                Ok((tcp, peer)) => {
                    debug!("Port forward connection from {peer}");
                    let _ = tcp.set_nodelay(true);
                    connections.spawn(center::with_source(
                        IssueSource::PortForward,
                        serve(tcp, backends.clone(), pod_rx.clone(), lost_tx.clone(), traffic.clone()),
                    ));
                }
                Err(e) => {
                    // E.g. out of file descriptors: don't spin.
                    warn!("Port forward accept failed: {e}");
                    tokio::time::sleep(Duration::from_millis(100)).await;
                }
            },
            // Reap finished connections.
            Some(_) = connections.join_next(), if !connections.is_empty() => {}
        }
    }
}

/// One local connection: waits for a pod, opens a stream and copies bytes
/// until either side closes. A stream that can't be opened makes the
/// supervisor reconnect, and the connection tries the next pod.
async fn serve<B: Backends>(
    tcp: TcpStream,
    backends: Arc<B>,
    mut pod_rx: watch::Receiver<Option<Backend>>,
    lost_tx: mpsc::UnboundedSender<Lost>,
    traffic: Arc<Traffic>,
) {
    let _open = traffic.connection();
    let mut tried: Option<u64> = None;
    for _ in 0..3 {
        let backend = {
            let next = pod_rx.wait_for(|b| b.as_ref().is_some_and(|b| Some(b.generation) != tried));
            match tokio::time::timeout(CONNECT_WAIT, next).await {
                Ok(Ok(backend)) => backend.clone().expect("checked by wait_for"),
                // No pod in time, or the forward stopped: the client sees
                // the connection close.
                _ => return,
            }
        };
        match backends.open(&backend.pod, backend.port).await {
            Ok(upstream) => {
                bridge(tcp, upstream, traffic).await;
                return;
            }
            Err(failure) => {
                warn!("Port forward stream to {} failed: {}", backend.pod, failure.message);
                tried = Some(backend.generation);
                let reason = match failure.kind {
                    FailureKind::NotFound => resolve::LOST_DELETED,
                    FailureKind::Unreachable => resolve::LOST_CLUSTER,
                    _ => resolve::LOST_BROKEN,
                };
                let _ = lost_tx.send(Lost {
                    generation: backend.generation,
                    reason,
                });
            }
        }
    }
}

async fn bridge(tcp: TcpStream, upstream: Upstream, traffic: Arc<Traffic>) {
    let Upstream { mut io, done } = upstream;
    let mut local = Counted { inner: tcp, traffic };
    if let Err(e) = tokio::io::copy_bidirectional(&mut local, &mut io).await {
        debug!("Port forward connection ended: {e}");
    }
    drop(io);
    drop(local);
    if let Some(message) = done.await {
        // Per connection (e.g. nothing listening right now): the forward
        // itself is fine, like kubectl's "an error occurred forwarding".
        warn!("Port forward connection error: {message}");
    }
}

async fn next_lost(lost_rx: &mut mpsc::UnboundedReceiver<Lost>, generation: u64) -> &'static str {
    loop {
        match lost_rx.recv().await {
            Some(lost) if lost.generation == generation => return lost.reason,
            Some(_) => continue,
            None => return std::future::pending().await,
        }
    }
}

async fn supervise<B: Backends>(
    forward: &Forward<B>,
    pod_tx: watch::Sender<Option<Backend>>,
    mut lost_rx: mpsc::UnboundedReceiver<Lost>,
    startup: Duration,
) -> Outcome {
    let deadline = Instant::now() + startup;
    let mut generation = 0u64;
    let mut attempt = 0u32;
    let mut current: Option<String> = None;
    let mut avoid: Option<String> = None;
    let mut lost: Option<&'static str> = None;

    loop {
        match forward.backends.resolve(current.clone(), avoid.clone()).await {
            Ok((pod, port)) => {
                attempt = 0;
                generation += 1;
                forward.update(|info| machine::on_ready(info, &pod, lost.take(), now_ms()));
                let _ = pod_tx.send(Some(Backend {
                    pod: pod.clone(),
                    port,
                    generation,
                }));

                let reason = tokio::select! {
                    reason = forward.backends.watch(&pod) => reason,
                    reason = next_lost(&mut lost_rx, generation) => reason,
                };
                let _ = pod_tx.send(None);
                info!("Port forward lost pod {pod}: {reason}");
                forward.update(|info| machine::on_lost(info, reason));
                lost = Some(reason);
                // A broken stream says nothing about the pod: try it again
                // first. A pod that went away is only a last resort.
                if matches!(reason, resolve::LOST_BROKEN | resolve::LOST_CLUSTER) {
                    current = Some(pod);
                    avoid = None;
                } else {
                    current = None;
                    avoid = Some(pod);
                }
            }
            Err(failure) => {
                let status = forward.status();
                let past_deadline = Instant::now() >= deadline;
                match machine::decide(status, failure.kind, past_deadline) {
                    Decision::Fallback => return Outcome::Fallback(failure.message),
                    Decision::Fail => {
                        let message = if status == ForwardStatus::Starting && past_deadline {
                            format!(
                                "The forward didn't become ready within {} seconds. {}",
                                startup.as_secs(),
                                failure.message
                            )
                        } else {
                            failure.message
                        };
                        forward.update(|info| Some(machine::on_failed(info, &message)));
                        return Outcome::Failed {
                            started: status != ForwardStatus::Starting,
                        };
                    }
                    Decision::Retry => {
                        debug!("Port forward waiting: {}", failure.message);
                        forward.update(|info| machine::on_waiting(info, &failure.message));
                        let mut wait = machine::backoff(attempt);
                        attempt += 1;
                        if status == ForwardStatus::Starting {
                            // One last try right at the deadline.
                            wait = wait.min(deadline.saturating_duration_since(Instant::now()));
                        }
                        tokio::time::sleep(wait).await;
                    }
                }
            }
        }
    }
}

/* ------------------------------------------------------- kube backends -- */

/// [`Backends`] on a real cluster.
pub struct KubeBackends {
    pub resolver: Resolver,
}

impl KubeBackends {
    fn strict(&self) -> bool {
        self.resolver.kind != TargetKind::Pod
    }
}

impl Backends for KubeBackends {
    fn resolve(&self, current: Option<String>, avoid: Option<String>) -> BoxFuture<'static, Result<(String, u16), Failure>> {
        let resolver = Resolver {
            client: self.resolver.client.clone(),
            namespace: self.resolver.namespace.clone(),
            kind: self.resolver.kind,
            name: self.resolver.name.clone(),
            remote_port: self.resolver.remote_port,
        };
        async move {
            let (pod, port) = resolver.resolve(current.as_deref(), avoid.as_deref()).await?;
            probe(&resolver, &pod, port).await?;
            Ok((pod, port))
        }
        .boxed()
    }

    fn open(&self, pod: &str, port: u16) -> BoxFuture<'static, Result<Upstream, Failure>> {
        let pods = self.resolver.pods();
        let pod = pod.to_string();
        async move {
            let mut forwarder = pods.portforward(&pod, &[port]).await.map_err(|e| resolve::classify(&e))?;
            let io = forwarder
                .take_stream(port)
                .ok_or_else(|| Failure::new(FailureKind::Unreachable, "The pod didn't open a stream"))?;
            let error = forwarder.take_error(port);
            let done = async move {
                // Once our stream is closed the pod may still report an
                // error; then the stream's task goes, whether or not it
                // wound down on its own.
                let message = match error {
                    Some(error) => tokio::time::timeout(Duration::from_secs(1), error).await.ok().flatten(),
                    None => None,
                };
                forwarder.abort();
                message
            }
            .boxed();
            Ok(Upstream { io: Box::new(io), done })
        }
        .boxed()
    }

    fn watch(&self, pod: &str) -> BoxFuture<'static, &'static str> {
        let api = self.resolver.pods();
        let strict = self.strict();
        let config = watcher::Config::default().fields(&format!("metadata.name={pod}"));
        async move {
            let mut events = watcher::watcher(api, config).default_backoff().boxed();
            let mut seen = false;
            while let Some(event) = events.next().await {
                match event {
                    Ok(Event::Init) => seen = false,
                    Ok(Event::Apply(pod)) | Ok(Event::InitApply(pod)) => {
                        seen = true;
                        if let Some(reason) = resolve::lost_reason(&pod, strict) {
                            return reason;
                        }
                    }
                    Ok(Event::InitDone) if !seen => return deleted(strict),
                    Ok(Event::Delete(_)) => return deleted(strict),
                    Ok(Event::InitDone) => {}
                    // The watcher retries with backoff; meanwhile failing
                    // streams still tell the supervisor.
                    Err(e) => debug!("Port forward pod watch: {e}"),
                }
            }
            std::future::pending().await
        }
        .boxed()
    }
}

fn deleted(strict: bool) -> &'static str {
    if strict {
        resolve::LOST_REPLACED
    } else {
        resolve::LOST_DELETED
    }
}

/// Opens (and closes) a stream to the pod: proves credentials, RBAC and
/// the WebSocket upgrade work, and catches a port nothing listens on.
async fn probe(resolver: &Resolver, pod: &str, port: u16) -> Result<(), Failure> {
    let mut forwarder = resolver.pods().portforward(pod, &[port]).await.map_err(|e| {
        let failure = resolve::classify(&e);
        match failure.kind {
            // The upgrade answer carries no message: say what's missing.
            FailureKind::Forbidden => Failure::new(
                FailureKind::Forbidden,
                format!("You don't have permission to port-forward to pods in {}", resolver.namespace),
            ),
            _ => failure,
        }
    })?;
    let error = forwarder.take_error(port);
    let reported = match error {
        Some(error) => tokio::time::timeout(PROBE_WAIT, error).await.ok().flatten(),
        None => None,
    };
    forwarder.abort();
    match reported {
        Some(message) => {
            debug!("Port forward probe of {pod}:{port}: {message}");
            Err(Failure::new(
                FailureKind::NotListening,
                format!("Nothing is listening on port {port} in pod {pod}"),
            ))
        }
        None => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::port_forward::tests::info;
    use std::collections::VecDeque;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::sync::Notify;

    /// A fake cluster: scripted resolve results, pods that echo with their
    /// name as prefix, and a pod "deletion" the test triggers.
    struct Fake {
        resolves: Mutex<VecDeque<Result<(String, u16), Failure>>>,
        opened: Mutex<Vec<String>>,
        delete: Arc<Notify>,
    }

    impl Fake {
        fn new(resolves: Vec<Result<(String, u16), Failure>>) -> Arc<Self> {
            Arc::new(Fake {
                resolves: Mutex::new(resolves.into()),
                opened: Mutex::new(Vec::new()),
                delete: Arc::new(Notify::new()),
            })
        }
    }

    impl Backends for Fake {
        fn resolve(&self, _: Option<String>, _: Option<String>) -> BoxFuture<'static, Result<(String, u16), Failure>> {
            let next = lock(&self.resolves)
                .pop_front()
                .unwrap_or_else(|| Err(Failure::new(FailureKind::NoReadyPod, "No pods left")));
            async move { next }.boxed()
        }

        fn open(&self, pod: &str, _port: u16) -> BoxFuture<'static, Result<Upstream, Failure>> {
            lock(&self.opened).push(pod.to_string());
            let (near, far) = tokio::io::duplex(1024);
            let prefix = pod.to_string();
            // The "pod": answers every chunk with "<pod>:<chunk>".
            tokio::spawn(async move {
                let (mut read, mut write) = tokio::io::split(far);
                let mut buf = [0u8; 256];
                while let Ok(n) = read.read(&mut buf).await {
                    if n == 0 {
                        break;
                    }
                    let reply = [prefix.as_bytes(), b":", &buf[..n]].concat();
                    if write.write_all(&reply).await.is_err() {
                        break;
                    }
                }
            });
            async move {
                Ok(Upstream {
                    io: Box::new(near),
                    done: async { None }.boxed(),
                })
            }
            .boxed()
        }

        fn watch(&self, _pod: &str) -> BoxFuture<'static, &'static str> {
            let delete = self.delete.clone();
            async move {
                delete.notified().await;
                resolve::LOST_REPLACED
            }
            .boxed()
        }
    }

    type Events = Arc<Mutex<Vec<(&'static str, ForwardStatus, Option<String>)>>>;

    fn make_forward(backends: Arc<Fake>) -> (Forward<Fake>, Events) {
        let events: Events = Arc::new(Mutex::new(Vec::new()));
        let sink = events.clone();
        let forward = Forward {
            info: Arc::new(Mutex::new(info())),
            traffic: Arc::new(Traffic::default()),
            backends,
            emit: Arc::new(move |event, info| lock(&sink).push((event, info.status, info.pod.clone()))),
        };
        (forward, events)
    }

    async fn round_trip(port: u16, message: &str) -> String {
        let mut client = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        client.write_all(message.as_bytes()).await.unwrap();
        let mut buf = vec![0u8; 256];
        let n = client.read(&mut buf).await.unwrap();
        String::from_utf8_lossy(&buf[..n]).into_owned()
    }

    async fn wait_until(mut check: impl FnMut() -> bool) {
        for _ in 0..200 {
            if check() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("condition not reached");
    }

    #[tokio::test]
    async fn bridges_connections_and_heals_after_the_pod_is_replaced() {
        let fake = Fake::new(vec![
            Err(Failure::new(FailureKind::NoReadyPod, "Waiting for a ready pod")),
            Ok(("web-a".into(), 8080)),
            Ok(("web-b".into(), 8080)),
        ]);
        let (forward, events) = make_forward(fake.clone());
        let info = forward.info.clone();
        let traffic = forward.traffic.clone();
        let listeners = bind("127.0.0.1", 0).await.unwrap();
        let port = listeners[0].local_addr().unwrap().port();
        let task = tokio::spawn(run(forward, listeners, Duration::from_secs(5)));

        // Connections made while starting wait for the pod.
        assert_eq!(round_trip(port, "hi").await, "web-a:hi");
        assert_eq!(lock(&info).status, ForwardStatus::Ready);

        // The pod goes away: the next connection lands on the new one, and
        // the listener never closed.
        fake.delete.notify_one();
        wait_until(|| lock(&info).pod.as_deref() == Some("web-b")).await;
        assert_eq!(round_trip(port, "again").await, "web-b:again");

        let snapshot = lock(&info).clone();
        assert_eq!(snapshot.status, ForwardStatus::Ready);
        assert_eq!(snapshot.reconnects, 1);
        assert_eq!(snapshot.last_reconnect.unwrap().reason, resolve::LOST_REPLACED);
        let names: Vec<_> = lock(&events).iter().map(|(event, _, _)| *event).collect();
        assert_eq!(
            names,
            vec![
                machine::EVENT_UPDATED,
                machine::EVENT_READY,
                machine::EVENT_RECONNECTING,
                machine::EVENT_READY
            ]
        );
        assert_eq!(*lock(&fake.opened), vec!["web-a".to_string(), "web-b".to_string()]);

        wait_until(|| traffic.snapshot().open_connections == 0).await;
        let counted = traffic.snapshot();
        assert_eq!(counted.connections, 2);
        assert_eq!(counted.bytes_sent, ("hi".len() + "again".len()) as u64);
        assert_eq!(counted.bytes_received, ("web-a:hi".len() + "web-b:again".len()) as u64);
        task.abort();
    }

    #[tokio::test]
    async fn fails_fast_when_forbidden_and_falls_back_when_unsupported() {
        let fake = Fake::new(vec![Err(Failure::new(FailureKind::Forbidden, "pods/portforward is forbidden"))]);
        let (forward, _) = make_forward(fake);
        let info = forward.info.clone();
        let outcome = run(forward, bind("127.0.0.1", 0).await.unwrap(), Duration::from_secs(5)).await;
        assert_eq!(outcome, Outcome::Failed { started: false });
        assert_eq!(lock(&info).status, ForwardStatus::Error);
        assert_eq!(lock(&info).error.as_deref(), Some("pods/portforward is forbidden"));

        let fake = Fake::new(vec![Err(Failure::new(FailureKind::Unsupported, "HTTP 400"))]);
        let (forward, _) = make_forward(fake);
        let outcome = run(forward, bind("127.0.0.1", 0).await.unwrap(), Duration::from_secs(5)).await;
        assert_eq!(outcome, Outcome::Fallback("HTTP 400".into()));
    }

    #[tokio::test]
    async fn start_up_gives_up_at_the_deadline() {
        let fake = Fake::new(vec![]);
        let (forward, _) = make_forward(fake);
        let info = forward.info.clone();
        let outcome = run(forward, bind("127.0.0.1", 0).await.unwrap(), Duration::from_millis(600)).await;
        assert_eq!(outcome, Outcome::Failed { started: false });
        let error = lock(&info).error.clone().unwrap();
        assert!(error.starts_with("The forward didn't become ready"), "{error}");
        assert!(error.ends_with("No pods left"), "{error}");
    }

    #[tokio::test]
    async fn binding_a_busy_port_says_so() {
        let taken = bind("127.0.0.1", 0).await.unwrap();
        let port = taken[0].local_addr().unwrap().port();
        let error = bind("127.0.0.1", port).await.unwrap_err();
        assert_eq!(error, format!("Port {port} is already in use on 127.0.0.1"));
    }
}

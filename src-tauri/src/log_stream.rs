//! Log streams that run entirely in the backend.
//!
//! The log viewer used to spawn `kubectl logs` through the shell plugin:
//! every line went kubectl -> Rust -> JS (event per line) -> Rust (parse into
//! the session) -> JS (fetch). Now kubectl is spawned here, its output is
//! parsed in batches straight into the structured logging session, and the
//! frontend only gets a small "appended" notification over a channel, after
//! which it fetches the (filtered) new entries.
//!
//! - a single pod / object streams through one `kubectl logs` process
//! - a label selector (all pods of a Deployment, StatefulSet, Service, ...)
//!   streams one process per pod and keeps following pod churn: pods are
//!   rediscovered every few seconds, new pods are picked up, streams of pods
//!   that are still running are resumed with `--since-time` (duplicates are
//!   dropped by timestamp)
//! - lines carry their pod / container (`--prefix`), used for the colour
//!   coded source column and the pod / container facets
//! - memory is bounded: the reader -> batcher queue is bounded (backpressure
//!   on kubectl), the session keeps at most `MAX_ENTRIES_PER_SESSION` lines
//! - streams stop when the session ends, a new stream replaces them, the
//!   frontend is gone (channel closed, webview reloaded: `log_stream_reset`)
//!   or the app exits; kubectl processes are killed through their process
//!   handles (kill_on_drop + exit sweep of the registered children)

use super::structured_logging::{
    blocking, get_session, normalize_timestamp, parse_line_from, split_prefix, ParsedLine,
};
use crate::util::lock;
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::ipc::Channel;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::mpsc;
use tokio::task::JoinSet;
use tokio::time::Instant;
use tracing::{info, warn};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

/// Lines queued between the kubectl readers and the batcher. Bounded, so a
/// flood applies backpressure to the readers (and kubectl's pipe) instead of
/// growing memory.
const LINE_QUEUE: usize = 16_384;
/// Upper bound of lines parsed and stored per batch.
const MAX_BATCH: usize = 5_000;
/// How long the batcher collects lines before storing them. Bounds the
/// notification rate to the frontend to ~12/s.
const BATCH_WINDOW: Duration = Duration::from_millis(80);
/// How often the pods of a selector are rediscovered while following.
const DISCOVERY_INTERVAL: Duration = Duration::from_secs(5);
const DISCOVERY_TIMEOUT: Duration = Duration::from_secs(30);
/// Pods streamed at once for a selector (one kubectl process each).
const DEFAULT_MAX_PODS: usize = 25;
const MAX_PODS_LIMIT: usize = 100;
/// Containers of one pod followed at once (`--all-containers`).
const MAX_LOG_REQUESTS: u32 = 20;
/// Tail of kubectl's stderr kept for error messages.
const STDERR_LIMIT: usize = 4096;
/// Delay before a stream of a still running pod is resumed.
const RESUME_DELAY: Duration = Duration::from_secs(2);
const MAX_RETRY_DELAY: Duration = Duration::from_secs(60);

#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum LogTarget {
    /// One pod by name.
    Pod { name: String },
    /// Every pod matching a label selector, following pod churn.
    Selector { selector: String },
    /// Anything else kubectl accepts (`deployment/web`); kubectl picks a pod.
    Object { name: String },
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogStreamSpec {
    pub context: String,
    #[serde(default)]
    pub namespace: String,
    #[serde(default)]
    pub kube_config: Option<String>,
    pub target: LogTarget,
    /// One container; all containers when omitted.
    #[serde(default)]
    pub container: Option<String>,
    #[serde(default)]
    pub follow: bool,
    /// Logs of the previous (crashed / restarted) container instance.
    #[serde(default)]
    pub previous: bool,
    /// `--since` duration, e.g. `5m`.
    #[serde(default)]
    pub since: Option<String>,
    /// `--tail` per pod (negative or omitted: everything).
    #[serde(default)]
    pub tail: Option<i64>,
    #[serde(default)]
    pub max_pods: Option<usize>,
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SourceState {
    Streaming,
    /// Matched, but not streamable yet (pending) or waiting for a retry.
    Waiting,
    /// Matched and running, but over the pod limit of the stream (picked up
    /// when a streamed pod goes away).
    Skipped,
    Ended,
    Failed,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PodSource {
    pub name: String,
    pub state: SourceState,
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum NoticeLevel {
    Info,
    Warning,
    Error,
}

/// Messages on the stream channel.
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum LogStreamEvent {
    /// Lines were stored in the session; fetch entries newer than the last
    /// known sequence number.
    Appended {
        latest_seq: u64,
        total: u32,
        added: u32,
        columns_changed: bool,
    },
    /// The pods of the stream (selector streams only).
    Sources { pods: Vec<PodSource> },
    /// Something worth showing: kubectl errors, skipped pods, ...
    Notice { level: NoticeLevel, message: String },
    /// Every stream finished (not following, or the pods are gone).
    Ended,
}

/// Where stream events go: the IPC channel, or a collector in tests.
pub(crate) trait EventSink: Send + Sync + 'static {
    /// Returns false when the receiver is gone (the stream then stops).
    fn send(&self, event: LogStreamEvent) -> bool;
}

impl EventSink for Channel<LogStreamEvent> {
    fn send(&self, event: LogStreamEvent) -> bool {
        Channel::send(self, event).is_ok()
    }
}

struct StreamHandle {
    generation: u64,
    supervisor: tauri::async_runtime::JoinHandle<()>,
}

static STREAMS: Lazy<Mutex<HashMap<String, StreamHandle>>> = Lazy::new(|| Mutex::new(HashMap::new()));

type SharedChild = Arc<Mutex<Option<Child>>>;

/// Running `kubectl logs` processes, killed on app exit (the async tasks
/// owning them may not get to run their destructors then). Entries hold the
/// process handle, never a bare pid: an entry is removed (by `TrackedChild`'s
/// drop) before the child is reaped, so a kill never hits a recycled pid.
static CHILDREN: Lazy<Mutex<HashMap<u64, SharedChild>>> = Lazy::new(|| Mutex::new(HashMap::new()));
static NEXT_CHILD_ID: AtomicU64 = AtomicU64::new(1);

/// How often an exiting kubectl is polled for its exit status.
const EXIT_POLL: Duration = Duration::from_millis(20);

/// A `kubectl logs` process registered in `CHILDREN` for as long as this
/// guard lives. Dropping it (the stream finished, or its task was aborted
/// when the tab closed / the stream was replaced) unregisters the process
/// and, if it still runs, kills it (kill_on_drop).
struct TrackedChild {
    id: u64,
    child: SharedChild,
}

impl TrackedChild {
    fn register(child: Child) -> Self {
        let id = NEXT_CHILD_ID.fetch_add(1, Ordering::Relaxed);
        let child = Arc::new(Mutex::new(Some(child)));
        lock(&CHILDREN).insert(id, child.clone());
        TrackedChild { id, child }
    }

    fn start_kill(&self) {
        if let Some(child) = lock(&self.child).as_mut() {
            let _ = child.start_kill();
        }
    }

    /// Waits for the process to exit. `None` when it was taken by the exit
    /// sweep or its status could not be read.
    async fn wait(&self) -> Option<std::process::ExitStatus> {
        loop {
            {
                let mut child = lock(&self.child);
                match child.as_mut().map(|c| c.try_wait()) {
                    None | Some(Err(_)) => return None,
                    Some(Ok(Some(status))) => return Some(status),
                    Some(Ok(None)) => {}
                }
            }
            tokio::time::sleep(EXIT_POLL).await;
        }
    }
}

impl Drop for TrackedChild {
    fn drop(&mut self) {
        lock(&CHILDREN).remove(&self.id);
        // Kill (kill_on_drop) and hand it to tokio's reaper now, not when
        // the last Arc goes.
        drop(lock(&self.child).take());
    }
}

/// Kills a registered child through its handle (TerminateProcess on
/// Windows, SIGKILL on unix).
fn kill_child(child: &SharedChild) -> bool {
    match lock(child).take() {
        Some(mut child) => {
            let _ = child.start_kill();
            true
        }
        None => false,
    }
}

/// One line read from kubectl, parsed by the batcher.
struct RawLine {
    text: String,
    /// Source for lines without a `--prefix` prefix.
    pod: Option<Arc<str>>,
}

fn flag(name: &str, value: &str) -> String {
    format!("--{}={}", name, value)
}

fn connection_args(spec: &LogStreamSpec) -> Vec<String> {
    let mut args = vec![flag("context", &spec.context)];
    if !spec.namespace.is_empty() {
        args.push(flag("namespace", &spec.namespace));
    }
    if let Some(kube_config) = spec.kube_config.as_deref().filter(|k| !k.is_empty()) {
        args.push(flag("kubeconfig", kube_config));
    }
    args
}

/// `kubectl logs` argv (without the program) for one target. `resume_since`
/// replaces `--since` / `--tail` when a stream of the same pod is resumed.
pub(crate) fn log_args(spec: &LogStreamSpec, target: &str, resume_since: Option<&str>) -> Vec<String> {
    let mut args = vec!["logs".to_string()];
    args.extend(connection_args(spec));
    args.push("--timestamps".to_string());
    args.push("--prefix".to_string());

    if spec.previous {
        args.push("--previous".to_string());
    } else if spec.follow {
        args.push("--follow".to_string());
    }

    match resume_since {
        Some(since_time) => args.push(flag("since-time", since_time)),
        None => {
            if let Some(since) = spec.since.as_deref().filter(|s| !s.is_empty()) {
                args.push(flag("since", since));
            }
            if let Some(tail) = spec.tail.filter(|tail| *tail >= 0) {
                args.push(flag("tail", &tail.to_string()));
            }
        }
    }

    match spec.container.as_deref().filter(|c| !c.is_empty()) {
        Some(container) => args.push(flag("container", container)),
        None => {
            args.push("--all-containers".to_string());
            args.push(flag("max-log-requests", &MAX_LOG_REQUESTS.to_string()));
        }
    }

    args.push(target.to_string());
    args
}

/// `kubectl get pods` argv listing name, phase and deletion state of the
/// pods matching `selector`, one tab separated line per pod.
pub(crate) fn discovery_args(spec: &LogStreamSpec, selector: &str) -> Vec<String> {
    let mut args = vec!["get".to_string(), "pods".to_string()];
    args.extend(connection_args(spec));
    args.push(flag("selector", selector));
    args.push(
        "--output=jsonpath={range .items[*]}{.metadata.name}{\"\\t\"}{.status.phase}{\"\\t\"}{.metadata.deletionTimestamp}{\"\\n\"}{end}"
            .to_string(),
    );
    args
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct DiscoveredPod {
    pub name: String,
    pub phase: String,
    pub deleting: bool,
}

pub(crate) fn parse_discovery(output: &str) -> Vec<DiscoveredPod> {
    output
        .lines()
        .filter_map(|line| {
            let mut parts = line.split('\t');
            let name = parts.next()?.trim();
            if name.is_empty() {
                return None;
            }
            Some(DiscoveredPod {
                name: name.to_string(),
                phase: parts.next().unwrap_or("").trim().to_string(),
                deleting: !parts.next().unwrap_or("").trim().is_empty(),
            })
        })
        .collect()
}

/// Whether kubectl can return logs for a pod: its containers have started.
/// Previous logs are requested for every pod (kubectl reports the ones
/// without a previous instance).
fn streamable(pod: &DiscoveredPod, previous: bool) -> bool {
    previous || matches!(pod.phase.as_str(), "Running" | "Succeeded" | "Failed")
}

fn is_finished_phase(phase: &str) -> bool {
    matches!(phase, "Succeeded" | "Failed")
}

/// Keeps the tail of a stream (kubectl's stderr) for error messages.
async fn read_tail(mut reader: impl tokio::io::AsyncRead + Unpin) -> String {
    let mut tail: Vec<u8> = Vec::new();
    let mut buf = [0u8; 4096];
    loop {
        match reader.read(&mut buf).await {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                tail.extend_from_slice(&buf[..n]);
                if tail.len() > STDERR_LIMIT {
                    tail.drain(..tail.len() - STDERR_LIMIT);
                }
            }
        }
    }
    String::from_utf8_lossy(&tail).trim().to_string()
}

fn command(program: &str, args: &[String]) -> Command {
    let mut cmd = Command::new(program);
    cmd.args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    // No console window per kubectl process on Windows (issue #70).
    #[cfg(windows)]
    cmd.creation_flags(0x08000000);
    cmd
}

/// Result of one `kubectl logs` process.
struct StreamOutcome {
    pod: String,
    /// Last timestamp per container (raw, as printed by kubectl).
    last_timestamps: HashMap<String, String>,
    lines: u64,
    error: Option<String>,
}

/// Runs one `kubectl logs` process and forwards its lines to the batcher.
/// Lines not newer than `resume` (normalized timestamp per container) are
/// duplicates of an earlier stream of the same pod and are dropped.
async fn stream_logs(
    program: Arc<str>,
    args: Vec<String>,
    pod: String,
    source: Option<Arc<str>>,
    mut resume: HashMap<String, String>,
    tx: mpsc::Sender<RawLine>,
) -> StreamOutcome {
    let mut outcome = StreamOutcome {
        pod,
        last_timestamps: HashMap::new(),
        lines: 0,
        error: None,
    };

    let mut child = match command(&program, &args).spawn() {
        Ok(child) => child,
        Err(e) => {
            outcome.error = Some(format!("Unable to run kubectl: {}", e));
            return outcome;
        }
    };
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let child = TrackedChild::register(child);

    let read_stdout = async {
        let Some(stdout) = stdout else { return };
        let mut reader = BufReader::with_capacity(64 * 1024, stdout);
        let mut buf = Vec::with_capacity(512);
        loop {
            buf.clear();
            match reader.read_until(b'\n', &mut buf).await {
                Ok(0) | Err(_) => break,
                Ok(_) => {}
            }
            let text = String::from_utf8_lossy(&buf).into_owned();

            let (_, container, rest) = split_prefix(&text);
            let container = container.unwrap_or("");
            let timestamp = rest.split(' ').next().unwrap_or("");

            if !resume.is_empty() {
                if let Some(last) = resume.get(container) {
                    if normalize_timestamp(timestamp) <= *last {
                        continue;
                    }
                    // Everything after the first new line is new as well.
                    resume.remove(container);
                }
            }

            match outcome.last_timestamps.get_mut(container) {
                Some(last) => {
                    last.clear();
                    last.push_str(timestamp);
                }
                None => {
                    outcome
                        .last_timestamps
                        .insert(container.to_string(), timestamp.to_string());
                }
            }
            outcome.lines += 1;

            let line = RawLine {
                text,
                pod: source.clone(),
            };
            if tx.send(line).await.is_err() {
                // The batcher is gone: the stream was stopped.
                break;
            }
        }
    };

    let read_stderr = async {
        match stderr {
            Some(stderr) => read_tail(stderr).await,
            None => String::new(),
        }
    };

    let stderr_tail = tokio::select! {
        ((), stderr_tail) = async { tokio::join!(read_stdout, read_stderr) } => stderr_tail,
        // The batcher is gone (stream stopped / frontend gone) while kubectl
        // is idle (e.g. following a quiet pod): don't wait for a next line.
        () = tx.closed() => String::new(),
    };
    // Stops kubectl when the reader quit early (stream stopped).
    child.start_kill();
    let status = child.wait().await;
    drop(child);

    let failed = match status {
        Some(status) => !status.success(),
        None => true,
    };
    // A kill after a complete read is not a failure; only report errors
    // kubectl explained on stderr.
    if failed && !stderr_tail.is_empty() {
        outcome.error = Some(stderr_tail);
    }
    outcome
}

/// Collects lines into batches, parses them off the async runtime and
/// stores them in the session, then notifies the frontend.
async fn run_batcher(
    session_id: String,
    generation: u64,
    mut rx: mpsc::Receiver<RawLine>,
    sink: Arc<dyn EventSink>,
) {
    let mut buf: Vec<RawLine> = Vec::with_capacity(1024);
    loop {
        if rx.recv_many(&mut buf, MAX_BATCH).await == 0 {
            break;
        }
        let deadline = Instant::now() + BATCH_WINDOW;
        while buf.len() < MAX_BATCH {
            let room = MAX_BATCH - buf.len();
            tokio::select! {
                received = rx.recv_many(&mut buf, room) => {
                    if received == 0 {
                        break;
                    }
                }
                _ = tokio::time::sleep_until(deadline) => break,
            }
        }

        let batch = std::mem::take(&mut buf);
        let parsed: Vec<ParsedLine> = blocking(move || {
            batch
                .iter()
                .filter_map(|line| parse_line_from(&line.text, line.pod.as_deref(), None))
                .collect()
        })
        .await;

        let Some(session) = get_session(&session_id) else {
            break;
        };
        let event = {
            let mut session = lock(&session);
            if session.stream_generation != generation {
                break;
            }
            let added = parsed.len() as u32;
            let columns_changed = session.push_lines(parsed);
            LogStreamEvent::Appended {
                latest_seq: session.latest_seq(),
                total: session.len() as u32,
                added,
                columns_changed,
            }
        };
        if !sink.send(event) {
            break;
        }
    }
}

/// Aborts the wrapped task when dropped (the supervisor being aborted).
struct AbortOnDrop(tokio::task::JoinHandle<()>);

impl Drop for AbortOnDrop {
    fn drop(&mut self) {
        self.0.abort();
    }
}

/// Per pod bookkeeping of a selector stream.
#[derive(Default)]
struct PodTrack {
    state: Option<SourceState>,
    phase: String,
    /// Normalized last timestamps per container, to resume without
    /// duplicates.
    last_timestamps: HashMap<String, String>,
    failures: u32,
    retry_at: Option<Instant>,
    /// Finished pod whose logs were read completely.
    done: bool,
}

struct Supervisor {
    program: Arc<str>,
    spec: LogStreamSpec,
    sink: Arc<dyn EventSink>,
}

impl Supervisor {
    fn notice(&self, level: NoticeLevel, message: impl Into<String>) {
        self.sink.send(LogStreamEvent::Notice {
            level,
            message: message.into(),
        });
    }

    async fn discover(&self, selector: &str) -> Result<Vec<DiscoveredPod>, String> {
        let args = discovery_args(&self.spec, selector);
        let output = tokio::time::timeout(DISCOVERY_TIMEOUT, command(&self.program, &args).output())
            .await
            .map_err(|_| "Listing the pods timed out".to_string())?
            .map_err(|e| format!("Unable to run kubectl: {}", e))?;
        if !output.status.success() {
            return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
        }
        Ok(parse_discovery(&String::from_utf8_lossy(&output.stdout)))
    }

    async fn run_single(&self, target: &str, source: Option<Arc<str>>, tx: mpsc::Sender<RawLine>) {
        let args = log_args(&self.spec, target, None);
        let outcome = stream_logs(
            self.program.clone(),
            args,
            target.to_string(),
            source,
            HashMap::new(),
            tx,
        )
        .await;
        if let Some(error) = outcome.error {
            self.notice(NoticeLevel::Error, error);
        }
    }

    fn sources(pods: &HashMap<String, PodTrack>) -> LogStreamEvent {
        let mut sources: Vec<PodSource> = pods
            .iter()
            .map(|(name, track)| PodSource {
                name: name.clone(),
                state: track.state.unwrap_or(SourceState::Waiting),
            })
            .collect();
        sources.sort_by(|a, b| a.name.cmp(&b.name));
        LogStreamEvent::Sources { pods: sources }
    }

    fn finish(&self, pods: &mut HashMap<String, PodTrack>, outcome: StreamOutcome) {
        let track = pods.entry(outcome.pod.clone()).or_default();
        for (container, timestamp) in outcome.last_timestamps {
            track
                .last_timestamps
                .insert(container, normalize_timestamp(&timestamp));
        }

        let now = Instant::now();
        match outcome.error {
            Some(error) if outcome.lines == 0 => {
                track.state = Some(SourceState::Failed);
                track.failures += 1;
                let delay = RESUME_DELAY
                    .saturating_mul(1 << track.failures.min(5))
                    .min(MAX_RETRY_DELAY);
                track.retry_at = Some(now + delay);
                // Report a pod's error once, not on every retry.
                if track.failures == 1 {
                    let first_line = error.lines().next().unwrap_or("").to_string();
                    self.notice(NoticeLevel::Warning, format!("{}: {}", outcome.pod, first_line));
                }
            }
            _ => {
                track.state = Some(SourceState::Ended);
                track.failures = 0;
                track.retry_at = Some(now + RESUME_DELAY);
                track.done = is_finished_phase(&track.phase) || !self.spec.follow;
            }
        }
    }

    async fn run_selector(&self, selector: &str, tx: mpsc::Sender<RawLine>) {
        let max_pods = self
            .spec
            .max_pods
            .unwrap_or(DEFAULT_MAX_PODS)
            .clamp(1, MAX_PODS_LIMIT);
        let mut pods: HashMap<String, PodTrack> = HashMap::new();
        let mut streams: JoinSet<StreamOutcome> = JoinSet::new();
        let mut first = true;
        let mut capped_notice = false;
        let mut last_error: Option<String> = None;

        loop {
            // Nobody reads the lines anymore (the batcher stopped because the
            // session ended or the frontend is gone): stop discovering.
            if tx.is_closed() {
                break;
            }
            match self.discover(selector).await {
                Ok(found) => {
                    last_error = None;
                    let now = Instant::now();
                    let names: HashSet<&str> = found.iter().map(|p| p.name.as_str()).collect();
                    let mut active = pods
                        .values()
                        .filter(|t| t.state == Some(SourceState::Streaming))
                        .count();
                    let mut skipped = 0usize;

                    for pod in found.iter() {
                        let track = pods.entry(pod.name.clone()).or_default();
                        track.phase = pod.phase.clone();
                        if track.state == Some(SourceState::Streaming) || track.done {
                            continue;
                        }
                        if pod.deleting && track.state.is_some() {
                            continue;
                        }
                        if !streamable(pod, self.spec.previous) {
                            track.state = Some(SourceState::Waiting);
                            continue;
                        }
                        if track.retry_at.is_some_and(|at| now < at) {
                            continue;
                        }
                        if active >= max_pods {
                            track.state = Some(SourceState::Skipped);
                            skipped += 1;
                            continue;
                        }

                        // Resume after the last line seen of every container.
                        let resume = track.last_timestamps.clone();
                        let since_time = resume.values().min().cloned();
                        let args = log_args(&self.spec, &pod.name, since_time.as_deref());
                        track.state = Some(SourceState::Streaming);
                        active += 1;
                        streams.spawn(stream_logs(
                            self.program.clone(),
                            args,
                            pod.name.clone(),
                            Some(Arc::from(pod.name.as_str())),
                            resume,
                            tx.clone(),
                        ));
                    }

                    // Forget pods that are gone (unless their stream is
                    // still draining).
                    pods.retain(|name, track| {
                        track.state == Some(SourceState::Streaming) || names.contains(name.as_str())
                    });

                    if first && found.is_empty() {
                        self.notice(
                            NoticeLevel::Info,
                            format!("No pods match {}{}", selector, if self.spec.follow { " yet" } else { "" }),
                        );
                    }
                    if skipped > 0 && !capped_notice {
                        capped_notice = true;
                        self.notice(
                            NoticeLevel::Warning,
                            format!("Streaming {} pods at most; {} more matching pods are not shown", max_pods, skipped),
                        );
                    }
                    if !self.sink.send(Self::sources(&pods)) {
                        break;
                    }
                }
                Err(error) => {
                    if last_error.as_deref() != Some(error.as_str()) {
                        self.notice(NoticeLevel::Error, format!("Unable to list pods: {}", error));
                        last_error = Some(error);
                    }
                    if !self.spec.follow {
                        break;
                    }
                }
            }
            first = false;

            if !self.spec.follow {
                break;
            }

            let tick = tokio::time::sleep(DISCOVERY_INTERVAL);
            tokio::pin!(tick);
            loop {
                tokio::select! {
                    _ = &mut tick => break,
                    () = tx.closed() => break,
                    Some(result) = streams.join_next(), if !streams.is_empty() => {
                        if let Ok(outcome) = result {
                            self.finish(&mut pods, outcome);
                            self.sink.send(Self::sources(&pods));
                        }
                    }
                }
            }
        }

        if tx.is_closed() {
            // Kills their kubectl processes (TrackedChild).
            streams.abort_all();
        }
        while let Some(result) = streams.join_next().await {
            if let Ok(outcome) = result {
                self.finish(&mut pods, outcome);
            }
        }
        if !pods.is_empty() && !tx.is_closed() {
            self.sink.send(Self::sources(&pods));
        }
    }

    async fn run(self, session_id: String, generation: u64) {
        let (tx, rx) = mpsc::channel::<RawLine>(LINE_QUEUE);
        let mut batcher = AbortOnDrop(tokio::spawn(run_batcher(
            session_id.clone(),
            generation,
            rx,
            self.sink.clone(),
        )));

        match self.spec.target.clone() {
            LogTarget::Pod { name } => {
                let source: Arc<str> = Arc::from(name.as_str());
                self.run_single(&name, Some(source), tx).await
            }
            LogTarget::Object { name } => self.run_single(&name, None, tx).await,
            LogTarget::Selector { selector } => self.run_selector(&selector, tx).await,
        }

        // All senders are gone: the batcher stores what is left and ends.
        let _ = (&mut batcher.0).await;
        self.sink.send(LogStreamEvent::Ended);

        let mut streams = lock(&STREAMS);
        if streams.get(&session_id).is_some_and(|s| s.generation == generation) {
            streams.remove(&session_id);
        }
    }
}

fn validate(spec: &LogStreamSpec) -> Result<(), String> {
    if spec.context.is_empty() {
        return Err("No context given".to_string());
    }
    let target = match &spec.target {
        LogTarget::Pod { name } | LogTarget::Object { name } => name,
        LogTarget::Selector { selector } => selector,
    };
    if target.trim().is_empty() {
        return Err("No pods to stream logs from".to_string());
    }
    Ok(())
}

pub(crate) fn start_stream_with(
    session_id: String,
    spec: LogStreamSpec,
    sink: Arc<dyn EventSink>,
    program: &str,
) -> Result<(), String> {
    validate(&spec)?;
    stop_stream(&session_id);

    let session = get_session(&session_id).ok_or("The log session has ended")?;
    let generation = {
        let mut session = lock(&session);
        session.stream_generation += 1;
        session.clear_entries();
        session.stream_generation
    };

    info!("Starting log stream for session {}: {:?}", session_id, spec.target);
    let supervisor = Supervisor {
        program: Arc::from(program),
        spec,
        sink,
    };
    let handle = tauri::async_runtime::spawn(supervisor.run(session_id.clone(), generation));

    if let Some(previous) = lock(&STREAMS).insert(
        session_id,
        StreamHandle {
            generation,
            supervisor: handle,
        },
    ) {
        previous.supervisor.abort();
    }
    Ok(())
}

/// Stops the stream of a session (if any): its kubectl processes are
/// killed when their tasks are dropped.
pub fn stop_stream(session_id: &str) {
    if let Some(stream) = lock(&STREAMS).remove(session_id) {
        info!("Stopping log stream for session {}", session_id);
        stream.supervisor.abort();
    }
}

/// Clears the session and streams logs into it with kubectl, replacing a
/// running stream of the session. Progress is reported on `on_event`.
#[tauri::command]
pub async fn start_log_stream(
    session_id: String,
    spec: LogStreamSpec,
    on_event: Channel<LogStreamEvent>,
) -> Result<(), String> {
    start_stream_with(session_id, spec, Arc::new(on_event), "kubectl")
}

#[tauri::command]
pub async fn stop_log_stream(session_id: String) {
    stop_stream(&session_id);
}

/// Stops every stream (their kubectl processes are killed when the aborted
/// tasks drop them).
fn stop_all_streams() -> usize {
    let streams = std::mem::take(&mut *lock(&STREAMS));
    let count = streams.len();
    for (_, stream) in streams {
        stream.supervisor.abort();
    }
    count
}

/// Stops the streams a previous load of the webview left behind (their
/// channels are gone) and ends their log sessions. Called once per page
/// load, before the frontend starts a log session.
#[tauri::command]
pub async fn log_stream_reset() {
    let stopped = stop_all_streams();
    let sessions = super::structured_logging::clear_sessions();
    if stopped > 0 || sessions > 0 {
        info!("Log stream reset: stopped {} streams, ended {} sessions", stopped, sessions);
    }
}

/// Stops every stream and kills their kubectl processes (app exit). The
/// aborted tasks may never run again, so the registered children are
/// killed here, through their process handles (works on Windows too).
pub fn kill_all_log_streams() {
    stop_all_streams();

    let children = std::mem::take(&mut *lock(&CHILDREN));
    let killed = children.values().filter(|child| kill_child(child)).count();
    if killed > 0 {
        warn!("Stopped {} kubectl logs processes on exit", killed);
    }
}

#[cfg(test)]
mod tests {
    use super::super::structured_logging::{insert_session, StructuredLoggingSession};
    use super::*;

    fn spec(target: LogTarget) -> LogStreamSpec {
        LogStreamSpec {
            context: "-ctx".to_string(),
            namespace: "ns".to_string(),
            kube_config: Some("/kc".to_string()),
            target,
            container: None,
            follow: true,
            previous: false,
            since: None,
            tail: Some(100),
            max_pods: None,
        }
    }

    #[test]
    fn log_args_cover_follow_previous_and_resume() {
        let s = spec(LogTarget::Pod { name: "web-1".into() });
        assert_eq!(
            log_args(&s, "web-1", None),
            vec![
                "logs",
                "--context=-ctx",
                "--namespace=ns",
                "--kubeconfig=/kc",
                "--timestamps",
                "--prefix",
                "--follow",
                "--tail=100",
                "--all-containers",
                "--max-log-requests=20",
                "web-1",
            ]
        );

        let mut s = spec(LogTarget::Pod { name: "web-1".into() });
        s.previous = true;
        s.container = Some("app".into());
        s.since = Some("5m".into());
        s.tail = None;
        let args = log_args(&s, "web-1", None);
        assert!(args.contains(&"--previous".to_string()));
        assert!(!args.contains(&"--follow".to_string()));
        assert!(args.contains(&"--since=5m".to_string()));
        assert!(args.contains(&"--container=app".to_string()));
        assert!(!args.contains(&"--all-containers".to_string()));

        // Resuming replaces since / tail.
        let s = spec(LogTarget::Pod { name: "web-1".into() });
        let args = log_args(&s, "web-1", Some("2024-01-01T00:00:00.000000000Z"));
        assert!(args.contains(&"--since-time=2024-01-01T00:00:00.000000000Z".to_string()));
        assert!(!args.iter().any(|a| a.starts_with("--tail")));
    }

    #[test]
    fn discovery_output_is_parsed() {
        let pods = parse_discovery("web-1\tRunning\t\nweb-2\tPending\t\nweb-3\tRunning\t2024-01-01T00:00:00Z\n\n");
        assert_eq!(pods.len(), 3);
        assert_eq!(pods[1].phase, "Pending");
        assert!(!pods[0].deleting);
        assert!(pods[2].deleting);
        assert!(streamable(&pods[0], false));
        assert!(!streamable(&pods[1], false));
        assert!(streamable(&pods[1], true));

        let s = spec(LogTarget::Selector { selector: "app=web".into() });
        let args = discovery_args(&s, "app=web");
        assert!(args.contains(&"--selector=app=web".to_string()));
        assert!(args.last().unwrap().starts_with("--output=jsonpath="));
    }

    #[test]
    fn spec_deserializes_from_the_frontend_shape() {
        let s: LogStreamSpec = serde_json::from_value(serde_json::json!({
            "context": "c",
            "namespace": "n",
            "kubeConfig": "/k",
            "target": { "kind": "selector", "selector": "app=web" },
            "follow": true,
            "tail": 50
        }))
        .unwrap();
        assert_eq!(s.target, LogTarget::Selector { selector: "app=web".into() });
        assert!(!s.previous);
        assert!(validate(&s).is_ok());

        let event = serde_json::to_value(LogStreamEvent::Appended {
            latest_seq: 3,
            total: 3,
            added: 3,
            columns_changed: true,
        })
        .unwrap();
        assert_eq!(event["type"], "appended");
        assert_eq!(event["latestSeq"], 3);
        assert_eq!(event["columnsChanged"], true);
    }

    #[derive(Default)]
    struct Collector(Mutex<Vec<LogStreamEvent>>);

    impl EventSink for Collector {
        fn send(&self, event: LogStreamEvent) -> bool {
            lock(&self.0).push(event);
            true
        }
    }

    impl Collector {
        fn ended(&self) -> bool {
            lock(&self.0).iter().any(|e| *e == LogStreamEvent::Ended)
        }

        fn added(&self) -> u64 {
            lock(&self.0)
                .iter()
                .map(|e| match e {
                    LogStreamEvent::Appended { added, .. } => *added as u64,
                    _ => 0,
                })
                .sum()
        }
    }

    /// A fake kubectl: `get` lists two running pods and a pending one,
    /// `logs` prints `$LINES` prefixed JSON lines for the pod (last arg).
    #[cfg(unix)]
    fn fake_kubectl(lines: u32, plain: bool) -> std::path::PathBuf {
        let message = if plain {
            r#"10.0.0.%d - - [01/Jan/2024:00:00:00 +0000] \"GET /api HTTP/1.1\" 200 512"#
        } else {
            r#"{\"level\":\"info\",\"msg\":\"request done\",\"n\":%d}"#
        };
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("jet-fake-kubectl-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("kubectl");
        let script = format!(
            r#"#!/bin/sh
if [ "$1" = "get" ]; then
  printf 'web-1\tRunning\t\nweb-2\tRunning\t\nweb-3\tPending\t\n'
  exit 0
fi
for last; do :; done
awk -v pod="$last" 'BEGIN {{ for (i = 1; i <= {lines}; i++) printf "[pod/%s/app] 2024-01-01T00:00:%02d.%09dZ {message}\n", pod, i % 60, i, i }}'
"#
        );
        std::fs::write(&path, script).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        path
    }

    #[cfg(unix)]
    fn run_selector_stream(lines: u32, plain: bool) -> (Arc<Collector>, Duration, String) {
        let program = fake_kubectl(lines, plain);
        let session_id = uuid::Uuid::new_v4().to_string();
        insert_session(session_id.clone(), StructuredLoggingSession::default());

        let collector = Arc::new(Collector::default());
        let mut s = spec(LogTarget::Selector { selector: "app=web".into() });
        s.follow = false;
        let started = std::time::Instant::now();
        start_stream_with(
            session_id.clone(),
            s,
            collector.clone(),
            program.to_str().unwrap(),
        )
        .unwrap();

        while !collector.ended() {
            assert!(started.elapsed() < Duration::from_secs(60), "stream did not end");
            std::thread::sleep(Duration::from_millis(5));
        }
        let _ = std::fs::remove_dir_all(program.parent().unwrap());
        (collector, started.elapsed(), session_id)
    }

    #[cfg(unix)]
    #[test]
    fn selector_stream_reads_every_running_pod() {
        let (collector, _, session_id) = run_selector_stream(50, false);
        // Two running pods, the pending one is skipped.
        assert_eq!(collector.added(), 100);

        let events = lock(&collector.0).clone();
        let sources = events
            .iter()
            .rev()
            .find_map(|e| match e {
                LogStreamEvent::Sources { pods } => Some(pods.clone()),
                _ => None,
            })
            .unwrap();
        let states: Vec<(&str, SourceState)> =
            sources.iter().map(|p| (p.name.as_str(), p.state)).collect();
        assert_eq!(
            states,
            vec![
                ("web-1", SourceState::Ended),
                ("web-2", SourceState::Ended),
                ("web-3", SourceState::Waiting),
            ]
        );

        let session = get_session(&session_id).unwrap();
        assert_eq!(lock(&session).len(), 100);
        assert!(!lock(&STREAMS).contains_key(&session_id));
    }

    /// A sink whose reader is gone: every Appended fails (the batcher stops).
    #[derive(Default)]
    struct DeadReader(Collector);

    impl EventSink for DeadReader {
        fn send(&self, event: LogStreamEvent) -> bool {
            let appended = matches!(event, LogStreamEvent::Appended { .. });
            self.0.send(event);
            !appended
        }
    }

    #[cfg(unix)]
    fn spawn_sleep() -> Child {
        command("sleep", &["30".to_string()]).spawn().unwrap()
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn tracked_child_unregisters_when_its_task_is_aborted() {
        let (id_tx, id_rx) = tokio::sync::oneshot::channel();
        let task = tokio::spawn(async move {
            let child = TrackedChild::register(spawn_sleep());
            let _ = id_tx.send(child.id);
            child.wait().await
        });
        let id = id_rx.await.unwrap();
        assert!(lock(&CHILDREN).contains_key(&id));

        // Closing / replacing a stream aborts its task.
        task.abort();
        assert!(task.await.unwrap_err().is_cancelled());
        assert!(!lock(&CHILDREN).contains_key(&id), "aborted stream left its child registered");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn tracked_child_unregisters_after_exit_and_kills_by_handle() {
        let child = TrackedChild::register(spawn_sleep());
        let id = child.id;
        let shared = lock(&CHILDREN).get(&id).cloned().unwrap();

        // The exit sweep kills through the handle and takes the child.
        assert!(kill_child(&shared));
        assert!(!kill_child(&shared), "a child is killed once");
        assert!(child.wait().await.is_none());
        drop(child);
        assert!(!lock(&CHILDREN).contains_key(&id));

        // A normally exiting child reports its status and unregisters.
        let child = TrackedChild::register(command("true", &[]).spawn().unwrap());
        let id = child.id;
        assert!(child.wait().await.is_some_and(|status| status.success()));
        drop(child);
        assert!(!lock(&CHILDREN).contains_key(&id));
    }

    /// The frontend stopped reading (the batcher ended): a following
    /// selector stream must stop discovering pods and kill its kubectl
    /// processes instead of polling every 5 s forever.
    #[cfg(unix)]
    #[test]
    fn selector_stream_stops_when_nobody_reads() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("jet-fake-kubectl-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("kubectl");
        let gets = dir.join("gets");
        let pids = dir.join("pids");
        let script = format!(
            r#"#!/bin/sh
if [ "$1" = "get" ]; then
  echo get >> '{gets}'
  printf 'web-1\tRunning\t\n'
  exit 0
fi
echo $$ >> '{pids}'
printf '[pod/web-1/app] 2024-01-01T00:00:01.000000000Z hello\n'
exec sleep 300
"#,
            gets = gets.display(),
            pids = pids.display()
        );
        std::fs::write(&path, script).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();

        let session_id = uuid::Uuid::new_v4().to_string();
        insert_session(session_id.clone(), StructuredLoggingSession::default());
        let sink = Arc::new(DeadReader::default());
        let s = spec(LogTarget::Selector { selector: "app=web".into() });
        assert!(s.follow);
        let started = std::time::Instant::now();
        start_stream_with(session_id.clone(), s, sink.clone(), path.to_str().unwrap()).unwrap();

        while !sink.0.ended() {
            assert!(started.elapsed() < Duration::from_secs(20), "stream did not stop");
            std::thread::sleep(Duration::from_millis(10));
        }
        // Well before the next discovery round.
        assert!(started.elapsed() < DISCOVERY_INTERVAL);
        std::thread::sleep(Duration::from_millis(200));
        let discoveries = std::fs::read_to_string(&gets).unwrap().lines().count();
        assert_eq!(discoveries, 1);
        assert!(!lock(&STREAMS).contains_key(&session_id));

        // The idle `kubectl logs --follow` was killed.
        #[cfg(target_os = "linux")]
        for pid in std::fs::read_to_string(&pids).unwrap().lines() {
            let stat = std::fs::read_to_string(format!("/proc/{}/stat", pid)).unwrap_or_default();
            let state = stat.rsplit(')').next().unwrap_or("").split_whitespace().next();
            assert!(matches!(state, None | Some("Z") | Some("X")), "kubectl {} still runs: {}", pid, stat);
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// End-to-end throughput: kubectl output -> batches -> parsed session
    /// entries. `cargo test -- --ignored --nocapture log_stream_throughput`
    #[cfg(unix)]
    #[test]
    #[ignore]
    fn log_stream_throughput() {
        let per_pod = 100_000;
        let (collector, elapsed, _) = run_selector_stream(per_pod, std::env::var("PLAIN").is_ok());
        let lines = collector.added();
        assert_eq!(lines, 2 * per_pod as u64);
        let batches = lock(&collector.0)
            .iter()
            .filter(|e| matches!(e, LogStreamEvent::Appended { .. }))
            .count();
        println!(
            "{} lines in {:?} = {:.0} lines/s, {} notifications",
            lines,
            elapsed,
            lines as f64 / elapsed.as_secs_f64(),
            batches
        );
    }
}

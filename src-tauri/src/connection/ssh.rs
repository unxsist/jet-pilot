//! SSH jump hosts: one `ssh -N -D 127.0.0.1:<port>` per bastion, shared by
//! every cluster behind it, that the app connects through as a SOCKS5 proxy.
//!
//! - started on first use and reused; its local port stays the same across
//!   restarts so clients and kubeconfigs built for it keep working;
//! - restarted with backoff after a drop; a failure ssh can't get past by
//!   itself (a password prompt, an unknown host key) stops it until the next
//!   use, so many watchers don't hammer the bastion;
//! - `BatchMode=yes`: ssh never asks for a password or passphrase, keys come
//!   from ssh-agent or the identity file;
//! - stopped when nothing uses it (see `reap`) and when the app quits.

use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::process::Stdio;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::Child;
use tokio::sync::watch;
use tracing::{info, warn};

use crate::util::lock;

/// How long a start may take: TCP connect (`ConnectTimeout`), key exchange, auth.
const START_TIMEOUT: Duration = Duration::from_secs(30);
/// A tunnel that stayed up this long starts over with the shortest backoff.
const STABLE_AFTER: Duration = Duration::from_secs(60);
/// After a failure ssh can't get past, the next use tries again only after this.
const RETRY_FAILED_AFTER: Duration = Duration::from_secs(10);
const POLL: Duration = Duration::from_millis(150);
/// The stderr ssh writes is short; keep the tail for the error message.
const STDERR_LIMIT: usize = 8 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshSpec {
    /// `host` or `user@host`.
    pub host: String,
    pub port: Option<u16>,
    pub identity_file: Option<String>,
    /// An extra `-J` jump (`user@host[:port]`, comma separated for several).
    pub jump: Option<String>,
}

impl SshSpec {
    /// The host name, for "Through bastion.example.com".
    pub fn host_name(&self) -> &str {
        self.host.rsplit_once('@').map_or(self.host.as_str(), |(_, host)| host)
    }
}

/// Values that end up as ssh arguments: never an option, never more than one
/// argument, nothing a shell or ssh would interpret.
fn plain(value: &str) -> bool {
    !value.is_empty() && !value.starts_with('-') && !value.chars().any(|c| c.is_whitespace() || c.is_control())
}

pub fn validate(spec: &SshSpec) -> Result<(), String> {
    let host = spec.host.trim();
    if host.is_empty() {
        return Err("Enter the jump host, for example user@bastion.example.com".to_string());
    }
    if !plain(host) || host.ends_with('@') {
        return Err(format!("'{host}' isn't a host name"));
    }
    if spec.port == Some(0) {
        return Err("The SSH port can't be 0".to_string());
    }
    if let Some(jump) = spec.jump.as_deref().map(str::trim).filter(|j| !j.is_empty()) {
        if !plain(jump) {
            return Err(format!("'{jump}' isn't a jump host"));
        }
    }
    if let Some(identity) = spec.identity_file.as_deref().map(str::trim).filter(|i| !i.is_empty()) {
        if identity.starts_with('-') || identity.chars().any(char::is_control) {
            return Err(format!("'{identity}' isn't a file"));
        }
    }
    Ok(())
}

/// The ssh argv (without the program) of a tunnel listening on `local_port`.
pub fn ssh_args(spec: &SshSpec, local_port: u16) -> Vec<String> {
    let mut args: Vec<String> = vec!["-N".into(), "-D".into(), format!("127.0.0.1:{local_port}")];
    for option in [
        // Never prompt (passwords, passphrases, host keys): fail instead.
        "BatchMode=yes",
        // Exit when the SOCKS port can't be opened, so another one is tried.
        "ExitOnForwardFailure=yes",
        // Notice a dead connection within ~45s and restart.
        "ServerAliveInterval=15",
        "ServerAliveCountMax=3",
        "ConnectTimeout=15",
    ] {
        args.push("-o".into());
        args.push(option.into());
    }
    if let Some(port) = spec.port.filter(|p| *p != 22) {
        args.push("-p".into());
        args.push(port.to_string());
    }
    if let Some(identity) = spec.identity_file.as_deref().map(str::trim).filter(|i| !i.is_empty()) {
        args.push("-i".into());
        args.push(identity.into());
        // Only that key: many keys in the agent end in "Too many
        // authentication failures" before it is tried.
        args.push("-o".into());
        args.push("IdentitiesOnly=yes".into());
    }
    if let Some(jump) = spec.jump.as_deref().map(str::trim).filter(|j| !j.is_empty()) {
        args.push("-J".into());
        args.push(jump.into());
    }
    args.push("--".into());
    args.push(spec.host.trim().into());
    args
}

/// What went wrong, in plain words, from ssh's stderr.
#[derive(Debug, Clone, PartialEq)]
pub struct Failure {
    pub message: String,
    /// Trying again won't help until the user changes something.
    pub fatal: bool,
    /// The local SOCKS port was taken: try another one.
    pub port_in_use: bool,
}

pub fn describe_failure(stderr: &str, spec: &SshSpec) -> Failure {
    let host = spec.host_name();
    let lower = stderr.to_lowercase();
    let has = |needle: &str| lower.contains(needle);
    let failure = |message: String, fatal: bool| Failure { message, fatal, port_in_use: false };

    if has("address already in use") || has("cannot listen to port") || has("could not request local forwarding") {
        return Failure { message: "The local port for the tunnel was taken".into(), fatal: false, port_in_use: true };
    }
    if has("remote host identification has changed") {
        return failure(format!("{host}'s host key changed. Check it with your admin before connecting again"), true);
    }
    if has("host key verification failed") || has("no matching host key") {
        return failure(
            format!("{host}'s host key isn't trusted yet. Connect once with ssh in a terminal to accept it"),
            true,
        );
    }
    if has("too many authentication failures") {
        return failure(format!("{host} refused your keys. Choose the identity file to use"), true);
    }
    if has("permission denied") {
        return failure("SSH asked for a password; add your key to ssh-agent".into(), true);
    }
    if (has("identity file") && has("not accessible")) || has("no such identity") {
        let file = spec.identity_file.as_deref().unwrap_or_default();
        return failure(format!("The identity file {file} doesn't exist"), true);
    }
    if has("could not resolve hostname") || has("name or service not known") || has("nodename nor servname") {
        return failure(format!("Couldn't find {host}"), true);
    }
    if has("connection refused") {
        return failure(format!("{host} refused the connection"), false);
    }
    if has("timed out") || has("no route to host") || has("network is unreachable") {
        return failure(format!("{host} didn't answer"), false);
    }
    if has("connection closed") || has("connection reset") || has("kex_exchange_identification") || has("broken pipe") {
        return failure(format!("{host} closed the connection"), false);
    }
    let last = stderr
        .lines()
        .map(str::trim)
        .rfind(|line| !line.is_empty() && !line.starts_with("Warning: Permanently added"));
    failure(
        match last {
            Some(line) => format!("SSH to {host} stopped: {}", line.trim_end_matches('.')),
            None => format!("SSH to {host} stopped"),
        },
        false,
    )
}

/// Delay before restart `attempt` (1-based): 1s, 2s, 4s, ... at most 30s.
pub fn backoff(attempt: u32) -> Duration {
    Duration::from_secs((1u64 << attempt.saturating_sub(1).min(5)).min(30))
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "state", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum TunnelState {
    Connecting,
    /// Since (ms since the epoch).
    Connected { since: u64 },
    /// It dropped; the next attempt is on its way.
    Retrying { error: String, attempt: u32 },
    /// Stopped by a failure ssh can't get past; the next use tries again.
    Failed { error: String },
    Stopped,
}

pub struct Tunnel {
    pub spec: SshSpec,
    port: Mutex<u16>,
    state: watch::Sender<TunnelState>,
    /// Long-running users (port forwards, terminals, log streams, kubectl runs).
    holds: AtomicUsize,
    last_used: Mutex<Instant>,
    failed_at: Mutex<Option<Instant>>,
    supervisor: Mutex<Option<tauri::async_runtime::JoinHandle<()>>>,
    child: Mutex<Option<Child>>,
}

/// Keeps a tunnel from being reaped while held.
pub struct Lease(Arc<Tunnel>);

impl Lease {
    fn new(tunnel: Arc<Tunnel>) -> Self {
        tunnel.holds.fetch_add(1, Ordering::SeqCst);
        Lease(tunnel)
    }
}

impl std::fmt::Debug for Lease {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Lease({})", self.0.spec.host_name())
    }
}

impl Drop for Lease {
    fn drop(&mut self) {
        self.0.touch();
        self.0.holds.fetch_sub(1, Ordering::SeqCst);
    }
}

static TUNNELS: Lazy<Mutex<HashMap<SshSpec, Arc<Tunnel>>>> = Lazy::new(|| Mutex::new(HashMap::new()));

/// Called after a state change (status events) and when a tunnel had to
/// move to another port (clients built for the old one are rebuilt).
pub trait Observer: Send + Sync {
    fn state_changed(&self, spec: &SshSpec);
    fn port_changed(&self, spec: &SshSpec);
}

static OBSERVER: Lazy<Mutex<Option<Arc<dyn Observer>>>> = Lazy::new(|| Mutex::new(None));

pub fn set_observer(observer: Arc<dyn Observer>) {
    *lock(&OBSERVER) = Some(observer);
}

fn observer() -> Option<Arc<dyn Observer>> {
    lock(&OBSERVER).clone()
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64)
}

/// Tests run a stand-in (a script, or ssh with extra options) instead.
#[cfg(test)]
static PROGRAM: Lazy<Mutex<Option<std::path::PathBuf>>> = Lazy::new(|| Mutex::new(None));

fn program() -> std::ffi::OsString {
    #[cfg(test)]
    if let Some(program) = lock(&PROGRAM).clone() {
        return program.into();
    }
    "ssh".into()
}

/// A free local port (the OS picks one; ssh binds it right after).
fn free_port() -> std::io::Result<u16> {
    Ok(std::net::TcpListener::bind("127.0.0.1:0")?.local_addr()?.port())
}

impl Tunnel {
    fn touch(&self) {
        *lock(&self.last_used) = Instant::now();
    }

    pub fn port(&self) -> u16 {
        *lock(&self.port)
    }

    pub fn state(&self) -> TunnelState {
        self.state.borrow().clone()
    }

    fn set_state(&self, state: TunnelState) {
        if *self.state.borrow() != state {
            self.state.send_replace(state);
            if let Some(observer) = observer() {
                observer.state_changed(&self.spec);
            }
        }
    }

    fn kill_child(&self) {
        if let Some(mut child) = lock(&self.child).take() {
            let _ = child.start_kill();
        }
    }

    fn start(self: &Arc<Self>) {
        let mut supervisor = lock(&self.supervisor);
        if supervisor.as_ref().is_some_and(|task| !task.inner().is_finished()) {
            return;
        }
        self.set_state(TunnelState::Connecting);
        let tunnel = self.clone();
        *supervisor = Some(tauri::async_runtime::spawn(async move { tunnel.supervise().await }));
    }

    fn stop(&self) {
        if let Some(task) = lock(&self.supervisor).take() {
            task.abort();
        }
        self.kill_child();
        self.set_state(TunnelState::Stopped);
    }

    async fn supervise(self: Arc<Self>) {
        let mut attempt: u32 = 0;
        loop {
            let started = Instant::now();
            let outcome = self.run_once().await;
            let stable = started.elapsed() >= STABLE_AFTER;
            let failure = describe_failure(&outcome.stderr, &self.spec);

            if failure.port_in_use {
                match free_port() {
                    Ok(port) => {
                        *lock(&self.port) = port;
                        if let Some(observer) = observer() {
                            observer.port_changed(&self.spec);
                        }
                        continue;
                    }
                    Err(e) => warn!("No free local port for the SSH tunnel: {}", e),
                }
            }
            if let Some(message) = outcome.spawn_error {
                self.fail(message);
                return;
            }
            if failure.fatal {
                self.fail(failure.message);
                return;
            }
            attempt = if stable { 1 } else { attempt + 1 };
            warn!("SSH tunnel to {} stopped ({}); retry {} soon", self.spec.host_name(), failure.message, attempt);
            self.set_state(TunnelState::Retrying { error: failure.message, attempt });
            tokio::time::sleep(backoff(attempt)).await;
        }
    }

    fn fail(&self, message: String) {
        warn!("SSH tunnel to {} failed: {}", self.spec.host_name(), message);
        *lock(&self.failed_at) = Some(Instant::now());
        self.set_state(TunnelState::Failed { error: message });
    }

    /// One ssh process, until it exits.
    async fn run_once(&self) -> RunOutcome {
        let port = self.port();
        let mut cmd = crate::process::command(program());
        cmd.args(ssh_args(&self.spec, port)).stdout(Stdio::null()).stderr(Stdio::piped());
        let mut child = match cmd.spawn() {
            Ok(child) => child,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                return RunOutcome::spawn_error("ssh isn't installed (or not on PATH)".into());
            }
            Err(e) => return RunOutcome::spawn_error(format!("Couldn't start ssh: {e}")),
        };
        info!("Starting SSH tunnel to {} on 127.0.0.1:{}", self.spec.host_name(), port);
        let stderr = child.stderr.take();
        let stderr_tail = tokio::spawn(async move {
            let mut tail = Vec::new();
            if let Some(mut stderr) = stderr {
                let mut buf = [0u8; 2048];
                while let Ok(n) = stderr.read(&mut buf).await {
                    if n == 0 {
                        break;
                    }
                    tail.extend_from_slice(&buf[..n]);
                    let excess = tail.len().saturating_sub(STDERR_LIMIT);
                    tail.drain(..excess);
                }
            }
            String::from_utf8_lossy(&tail).into_owned()
        });
        *lock(&self.child) = Some(child);

        let started = Instant::now();
        let mut connected = false;
        let mut timed_out = false;
        loop {
            let exited = match lock(&self.child).as_mut() {
                Some(child) => !matches!(child.try_wait(), Ok(None)),
                // Killed by stop().
                None => true,
            };
            if exited {
                break;
            }
            if !connected {
                if socks_ready(port).await {
                    connected = true;
                    info!("SSH tunnel to {} is up", self.spec.host_name());
                    self.set_state(TunnelState::Connected { since: now_ms() });
                } else if started.elapsed() > START_TIMEOUT {
                    timed_out = true;
                    self.kill_child();
                    break;
                }
            }
            tokio::time::sleep(POLL).await;
        }
        self.kill_child();
        let mut stderr = tokio::time::timeout(Duration::from_secs(2), stderr_tail)
            .await
            .ok()
            .and_then(Result::ok)
            .unwrap_or_default();
        if timed_out && stderr.trim().is_empty() {
            stderr = "Connection timed out".into();
        }
        RunOutcome { stderr, spawn_error: None }
    }
}

struct RunOutcome {
    stderr: String,
    spawn_error: Option<String>,
}

impl RunOutcome {
    fn spawn_error(message: String) -> Self {
        RunOutcome { stderr: String::new(), spawn_error: Some(message) }
    }
}

/// Whether a SOCKS5 server answers on `port` (ssh opens it once logged in).
pub async fn socks_ready(port: u16) -> bool {
    let attempt = async {
        let mut stream = tokio::net::TcpStream::connect(("127.0.0.1", port)).await?;
        // Version 5, one method: no authentication.
        stream.write_all(&[5, 1, 0]).await?;
        let mut reply = [0u8; 2];
        stream.read_exact(&mut reply).await?;
        Ok::<_, std::io::Error>(reply == [5, 0])
    };
    matches!(tokio::time::timeout(Duration::from_millis(500), attempt).await, Ok(Ok(true)))
}

/// The SOCKS port of the tunnel for `spec`, started (or reused) and held
/// while the lease lives.
pub async fn ensure(spec: &SshSpec) -> Result<(u16, Lease), String> {
    validate(spec)?;
    let tunnel = {
        let mut tunnels = lock(&TUNNELS);
        match tunnels.get(spec) {
            Some(tunnel) => tunnel.clone(),
            None => {
                let port = free_port().map_err(|e| format!("No free local port for the SSH tunnel: {e}"))?;
                let tunnel = Arc::new(Tunnel {
                    spec: spec.clone(),
                    port: Mutex::new(port),
                    state: watch::channel(TunnelState::Stopped).0,
                    holds: AtomicUsize::new(0),
                    last_used: Mutex::new(Instant::now()),
                    failed_at: Mutex::new(None),
                    supervisor: Mutex::new(None),
                    child: Mutex::new(None),
                });
                tunnels.insert(spec.clone(), tunnel.clone());
                tunnel
            }
        }
    };
    tunnel.touch();
    let lease = Lease::new(tunnel.clone());

    match tunnel.state() {
        TunnelState::Failed { error } => {
            let recent = lock(&tunnel.failed_at).is_some_and(|at| at.elapsed() < RETRY_FAILED_AFTER);
            if recent {
                return Err(error);
            }
            tunnel.start();
        }
        TunnelState::Stopped => tunnel.start(),
        _ => {}
    }

    let mut states = tunnel.state.subscribe();
    let wait = async {
        loop {
            let state = states.borrow_and_update().clone();
            match state {
                TunnelState::Connected { .. } => return Ok(()),
                TunnelState::Failed { error } => return Err(error),
                // Don't keep callers waiting through a backoff: the
                // supervisor keeps trying, they retry on their own.
                TunnelState::Retrying { error, .. } => return Err(error),
                TunnelState::Stopped => return Err("The SSH tunnel stopped".to_string()),
                TunnelState::Connecting => {}
            }
            if states.changed().await.is_err() {
                return Err("The SSH tunnel stopped".to_string());
            }
        }
    };
    match tokio::time::timeout(START_TIMEOUT + Duration::from_secs(5), wait).await {
        Ok(Ok(())) => Ok((tunnel.port(), lease)),
        Ok(Err(error)) => Err(error),
        Err(_) => Err(format!("{} didn't answer", spec.host_name())),
    }
}

/// Starts the tunnel again now, even right after a failure ("Try again").
pub fn retry(spec: &SshSpec) {
    let tunnel = lock(&TUNNELS).get(spec).cloned();
    if let Some(tunnel) = tunnel {
        *lock(&tunnel.failed_at) = None;
        if matches!(tunnel.state(), TunnelState::Failed { .. } | TunnelState::Stopped) {
            tunnel.start();
        }
    }
}

pub fn state_of(spec: &SshSpec) -> Option<TunnelState> {
    lock(&TUNNELS).get(spec).map(|tunnel| tunnel.state())
}

/// Stops and forgets the tunnels `keep` rejects that nobody holds and that
/// weren't used for `idle`. Returns the stopped specs.
pub fn reap(idle: Duration, keep: impl Fn(&SshSpec) -> bool) -> Vec<SshSpec> {
    let stale: Vec<Arc<Tunnel>> = {
        let mut tunnels = lock(&TUNNELS);
        let specs: Vec<SshSpec> = tunnels
            .iter()
            .filter(|(spec, tunnel)| {
                tunnel.holds.load(Ordering::SeqCst) == 0
                    && lock(&tunnel.last_used).elapsed() >= idle
                    && !keep(spec)
            })
            .map(|(spec, _)| spec.clone())
            .collect();
        specs.iter().filter_map(|spec| tunnels.remove(spec)).collect()
    };
    for tunnel in &stale {
        info!("Stopping the unused SSH tunnel to {}", tunnel.spec.host_name());
        tunnel.stop();
    }
    stale.into_iter().map(|tunnel| tunnel.spec.clone()).collect()
}

/// Stops the tunnel of `spec` (its setting changed or was removed).
pub fn stop(spec: &SshSpec) {
    let tunnel = lock(&TUNNELS).remove(spec);
    if let Some(tunnel) = tunnel {
        tunnel.stop();
    }
}

/// Kills every tunnel (app exit).
pub fn stop_all() {
    let tunnels: Vec<Arc<Tunnel>> = lock(&TUNNELS).drain().map(|(_, tunnel)| tunnel).collect();
    for tunnel in tunnels {
        if let Some(task) = lock(&tunnel.supervisor).take() {
            task.abort();
        }
        tunnel.kill_child();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec(host: &str) -> SshSpec {
        SshSpec { host: host.into(), port: None, identity_file: None, jump: None }
    }

    #[test]
    fn argv_is_batch_mode_socks_only() {
        assert_eq!(
            ssh_args(&spec("ops@bastion.example.com"), 41000),
            vec![
                "-N",
                "-D",
                "127.0.0.1:41000",
                "-o",
                "BatchMode=yes",
                "-o",
                "ExitOnForwardFailure=yes",
                "-o",
                "ServerAliveInterval=15",
                "-o",
                "ServerAliveCountMax=3",
                "-o",
                "ConnectTimeout=15",
                "--",
                "ops@bastion.example.com",
            ]
        );
    }

    #[test]
    fn argv_has_port_identity_and_jump() {
        let full = SshSpec {
            host: " ops@bastion ".into(),
            port: Some(2222),
            identity_file: Some("~/.ssh/bastion".into()),
            jump: Some("me@edge.example.com:2200".into()),
        };
        let args = ssh_args(&full, 41000);
        let tail: Vec<&str> = args[13..].iter().map(String::as_str).collect();
        assert_eq!(
            tail,
            vec![
                "-p",
                "2222",
                "-i",
                "~/.ssh/bastion",
                "-o",
                "IdentitiesOnly=yes",
                "-J",
                "me@edge.example.com:2200",
                "--",
                "ops@bastion",
            ]
        );
        // The default port and empty fields add nothing.
        let quiet = SshSpec { port: Some(22), identity_file: Some(" ".into()), jump: Some("".into()), ..spec("b") };
        assert_eq!(ssh_args(&quiet, 1).len(), 15);
    }

    #[test]
    fn options_can_not_be_smuggled_in() {
        assert!(validate(&spec("-oProxyCommand=evil")).is_err());
        assert!(validate(&spec("bastion -oProxyCommand=evil")).is_err());
        assert!(validate(&spec("")).is_err());
        assert!(validate(&spec("ops@")).is_err());
        assert!(validate(&SshSpec { jump: Some("-oProxyCommand=x".into()), ..spec("b") }).is_err());
        assert!(validate(&SshSpec { identity_file: Some("-F/etc/x".into()), ..spec("b") }).is_err());
        assert!(validate(&SshSpec { port: Some(0), ..spec("b") }).is_err());
        assert!(validate(&SshSpec {
            port: Some(2222),
            identity_file: Some("/home/me/My Keys/id_ed25519".into()),
            jump: Some("a@edge,b@inner".into()),
            ..spec("ops@bastion.example.com")
        })
        .is_ok());
    }

    #[test]
    fn failures_read_like_sentences() {
        let s = SshSpec { identity_file: Some("~/.ssh/nope".into()), ..spec("ops@bastion.example.com") };
        let cases = [
            ("ops@bastion.example.com: Permission denied (publickey,password).", "SSH asked for a password; add your key to ssh-agent", true),
            ("Host key verification failed.", "bastion.example.com's host key isn't trusted yet. Connect once with ssh in a terminal to accept it", true),
            ("@@@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @@@", "bastion.example.com's host key changed. Check it with your admin before connecting again", true),
            ("ssh: Could not resolve hostname bastion.example.com: Name or service not known", "Couldn't find bastion.example.com", true),
            ("ssh: connect to host bastion.example.com port 22: Connection refused", "bastion.example.com refused the connection", false),
            ("ssh: connect to host bastion.example.com port 22: Connection timed out", "bastion.example.com didn't answer", false),
            ("Warning: Identity file ~/.ssh/nope not accessible: No such file or directory.", "The identity file ~/.ssh/nope doesn't exist", true),
            ("Received disconnect from 10.0.0.1 port 22:2: Too many authentication failures", "bastion.example.com refused your keys. Choose the identity file to use", true),
            ("Connection closed by 10.0.0.1 port 22", "bastion.example.com closed the connection", false),
            ("Warning: Permanently added 'b' (ED25519) to the list of known hosts.\nclient_loop: send disconnect: Something odd.", "SSH to bastion.example.com stopped: client_loop: send disconnect: Something odd", false),
            ("", "SSH to bastion.example.com stopped", false),
        ];
        for (stderr, message, fatal) in cases {
            let failure = describe_failure(stderr, &s);
            assert_eq!(failure.message, message, "{stderr}");
            assert_eq!(failure.fatal, fatal, "{stderr}");
            assert!(!failure.port_in_use);
        }
        let taken = describe_failure("bind [127.0.0.1]:41000: Address already in use\nCould not request local forwarding.", &s);
        assert!(taken.port_in_use && !taken.fatal);
    }

    #[test]
    fn backoff_doubles_up_to_thirty_seconds() {
        let secs: Vec<u64> = (1..=8).map(|n| backoff(n).as_secs()).collect();
        assert_eq!(secs, vec![1, 2, 4, 8, 16, 30, 30, 30]);
        assert_eq!(backoff(0).as_secs(), 1);
    }

    /// PROGRAM is shared by the tests that replace ssh.
    static PROGRAM_TESTS: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

    #[cfg(unix)]
    fn script(dir: &std::path::Path, body: &str) -> std::path::PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let path = dir.join("ssh");
        std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        path
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_password_prompt_fails_in_plain_words_without_retrying() {
        let _guard = PROGRAM_TESTS.lock().await;
        let dir = tempfile::tempdir().unwrap();
        let calls = dir.path().join("calls");
        *lock(&PROGRAM) = Some(script(
            dir.path(),
            &format!(
                "echo started >> '{}'\necho 'ops@bastion: Permission denied (publickey,password).' >&2\nexit 255",
                calls.display()
            ),
        ));
        let spec = spec("ops@password-bastion.test");
        let error = ensure(&spec).await.unwrap_err();
        assert_eq!(error, "SSH asked for a password; add your key to ssh-agent");
        assert_eq!(state_of(&spec), Some(TunnelState::Failed { error: error.clone() }));
        // Used again right away: no second ssh, the same answer.
        assert_eq!(ensure(&spec).await.unwrap_err(), error);
        assert_eq!(std::fs::read_to_string(&calls).unwrap().lines().count(), 1);
        stop(&spec);
        *lock(&PROGRAM) = None;
    }

    #[test]
    fn unused_tunnels_are_reaped_unless_kept() {
        let tunnel = |host: &str| {
            let spec = spec(host);
            let tunnel = Arc::new(Tunnel {
                spec: spec.clone(),
                port: Mutex::new(1),
                state: watch::channel(TunnelState::Stopped).0,
                holds: AtomicUsize::new(0),
                last_used: Mutex::new(Instant::now() - Duration::from_secs(600)),
                failed_at: Mutex::new(None),
                supervisor: Mutex::new(None),
                child: Mutex::new(None),
            });
            lock(&TUNNELS).insert(spec.clone(), tunnel.clone());
            (spec, tunnel)
        };
        let (idle, _) = tunnel("idle.reap.test");
        let (kept, _) = tunnel("kept.reap.test");
        let (held, held_tunnel) = tunnel("held.reap.test");
        let lease = Lease::new(held_tunnel);

        let reaped = reap(Duration::from_secs(90), |s| s == &kept || !s.host.ends_with(".reap.test"));
        assert_eq!(reaped, vec![idle.clone()]);
        assert!(state_of(&idle).is_none());
        assert!(state_of(&kept).is_some() && state_of(&held).is_some());

        // Dropping the last lease counts as a use: still not idle.
        drop(lease);
        assert!(reap(Duration::from_secs(90), |s| !s.host.ends_with(".reap.test") || s == &kept).is_empty());
        stop(&kept);
        stop(&held);
    }

    /// A real `ssh -D` (run with JP_SSH_E2E_HOST=user@host and, optionally,
    /// JP_SSH_E2E_KNOWN_HOSTS=<file> to keep ~/.ssh/known_hosts untouched):
    /// the tunnel starts, and a kube client reaches a local API server
    /// through it by name (resolved on the far side).
    #[cfg(unix)]
    #[tokio::test]
    #[ignore]
    async fn a_real_ssh_tunnel_carries_kube_traffic() {
        let Ok(host) = std::env::var("JP_SSH_E2E_HOST") else { return };
        let _guard = PROGRAM_TESTS.lock().await;
        let dir = tempfile::tempdir().unwrap();
        let known_hosts = std::env::var("JP_SSH_E2E_KNOWN_HOSTS")
            .map(|file| format!("-o UserKnownHostsFile='{file}' -o StrictHostKeyChecking=accept-new "))
            .unwrap_or_default();
        *lock(&PROGRAM) = Some(script(dir.path(), &format!("exec ssh {known_hosts}\"$@\"")));

        let api = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let api_port = api.local_addr().unwrap().port();
        tokio::spawn(async move {
            while let Ok((mut stream, _)) = api.accept().await {
                let mut buf = [0u8; 4096];
                let _ = stream.read(&mut buf).await;
                let body = r#"{"major":"1","minor":"31","gitVersion":"v1.31.2","gitCommit":"","gitTreeState":"","buildDate":"","goVersion":"","compiler":"","platform":""}"#;
                let _ = stream
                    .write_all(format!("HTTP/1.1 200 OK\r\ncontent-length: {}\r\n\r\n{body}", body.len()).as_bytes())
                    .await;
            }
        });

        let spec = spec(&host);
        let (port, lease) = ensure(&spec).await.expect("tunnel");
        assert!(matches!(state_of(&spec), Some(TunnelState::Connected { .. })));
        let mut config = kube::Config::new(format!("http://localhost:{api_port}").parse().unwrap());
        config.proxy_url = Some(format!("socks5://127.0.0.1:{port}").parse().unwrap());
        let version = kube::Client::try_from(config).unwrap().apiserver_version().await.unwrap();
        assert_eq!(version.git_version, "v1.31.2");
        drop(lease);
        stop(&spec);
        *lock(&PROGRAM) = None;
    }

    #[test]
    fn host_name_drops_the_user() {
        assert_eq!(spec("ops@bastion.example.com").host_name(), "bastion.example.com");
        assert_eq!(spec("bastion").host_name(), "bastion");
    }

    #[test]
    fn state_serializes_for_the_frontend() {
        let json = serde_json::to_value(TunnelState::Retrying { error: "x".into(), attempt: 2 }).unwrap();
        assert_eq!(json, serde_json::json!({ "state": "retrying", "error": "x", "attempt": 2 }));
        let json = serde_json::to_value(TunnelState::Connected { since: 5 }).unwrap();
        assert_eq!(json, serde_json::json!({ "state": "connected", "since": 5 }));
    }

    /// A stand-in for `ssh -D`: a SOCKS5 greeting server.
    async fn fake_socks() -> u16 {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            while let Ok((mut stream, _)) = listener.accept().await {
                let mut greeting = [0u8; 3];
                if stream.read_exact(&mut greeting).await.is_ok() {
                    let _ = stream.write_all(&[5, 0]).await;
                }
            }
        });
        port
    }

    #[tokio::test]
    async fn readiness_needs_a_socks_answer() {
        assert!(socks_ready(fake_socks().await).await);
        // Nothing listening.
        assert!(!socks_ready(free_port().unwrap()).await);
        // Something else listening that doesn't speak SOCKS.
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            while let Ok((mut stream, _)) = listener.accept().await {
                let _ = stream.write_all(b"HTTP/1.1 400 Bad Request\r\n\r\n").await;
            }
        });
        assert!(!socks_ready(port).await);
    }
}

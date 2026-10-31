//! Pseudo terminal sessions for the Shell (`kubectl exec`) and local Terminal tabs.
//!
//! - every session runs the requested command line inside a pty on all
//!   platforms (the old Windows code ignored it and spawned a bare
//!   `powershell.exe`, issue #52)
//! - output is read by a blocking reader thread and streamed to the frontend
//!   over a Tauri channel (raw bytes, no busy polling); the process exit is
//!   reported on the same channel as a JSON message, after the last output
//! - a terminal can move to another window: `tty_release` detaches it (the
//!   process keeps running, output only goes to the session's scrollback, the
//!   last 256 KiB), `tty_attach` replays the scrollback on the new channel and
//!   streams from there on. A session that ends while detached keeps its
//!   scrollback and exit message for the next attach (for 5 minutes)
//! - sessions belong to the webview their terminal is attached to: closing
//!   that window stops them (detached ones keep running)
//! - the pty master is kept alive for the lifetime of the session: dropping it
//!   on Windows closes the pseudo console while the child is still starting
//!   (STATUS_DLL_INIT_FAILED / 0xc0000142)
//! - input is queued to a per-session writer thread, so a child that stops
//!   reading (full pty buffer) cannot block the main thread or other commands
//! - errors are returned to the frontend instead of panicking
//! - sessions are killed when their tab closes and when the app exits; on
//!   unix a child that ignores SIGHUP is SIGKILLed after a grace period
//! - local terminals get a temporary single-context kubeconfig via
//!   `KUBECONFIG` (owner-only 0600 permissions on unix; on Windows it lives in
//!   the per-user temp directory), removed again when the session ends and
//!   swept at startup in case a previous run crashed
//! - clusters with a proxy or SSH jump host (see `connection`): the temporary
//!   kubeconfig gets its `proxy-url`, `kubectl exec` gets a proxied
//!   kubeconfig, and the session keeps the SSH tunnel up while it runs

pub mod tty {
    use once_cell::sync::Lazy;
    use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
    use serde::Serialize;
    use std::collections::{HashMap, VecDeque};
    use std::ffi::{OsStr, OsString};
    use std::io::{Read, Write};
    use std::path::{Path, PathBuf};
    use std::process::Command;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{mpsc, Arc, Mutex};
    use std::thread;
    use std::time::{Duration, Instant};
    use tauri::ipc::{Channel, InvokeResponseBody};
    use tracing::{info, warn};
    use uuid::Uuid;

    #[cfg(windows)]
    use std::os::windows::process::CommandExt;

    const DEFAULT_ROWS: u16 = 24;
    const DEFAULT_COLS: u16 = 80;
    const MAX_DIMENSION: u16 = 1000;
    const TEMP_KUBECONFIG_PREFIX: &str = "jet-pilot-terminal-";
    const TEMP_KUBECONFIG_SUFFIX: &str = ".yaml";
    /// How long a stopped child gets to exit after SIGHUP before it is killed.
    #[cfg(unix)]
    const KILL_GRACE_PERIOD: Duration = Duration::from_secs(2);
    /// Output kept per session for a terminal attaching later (moved to
    /// another window).
    const SCROLLBACK_LIMIT: usize = 256 * 1024;
    /// A trimmed scrollback starts after the first newline this close to the
    /// cut, so a replay doesn't begin in the middle of a line (or an escape
    /// sequence).
    const SCROLLBACK_LINE_SEARCH: usize = 4 * 1024;
    /// How long a session that ended while detached keeps its output for the
    /// next attach.
    const DETACHED_EXIT_TTL: Duration = Duration::from_secs(5 * 60);

    /// The parts of a session are locked independently: a writer blocked on a
    /// full pty must never keep stop / resize / exit cleanup waiting.
    struct TtySession {
        /// Input for the writer thread; dropping it ends that thread.
        input: mpsc::Sender<Vec<u8>>,
        /// Kept alive on purpose: dropping the master closes the pty (and on
        /// Windows the pseudo console, which kills the child).
        master: Mutex<Box<dyn MasterPty + Send>>,
        killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
        #[cfg_attr(not(unix), allow(dead_code))]
        pid: Option<u32>,
        /// Set by the waiter thread once the child has been reaped.
        #[cfg_attr(not(unix), allow(dead_code))]
        exited: Arc<AtomicBool>,
        temp_files: Vec<PathBuf>,
    }

    static TTY_SESSIONS: Lazy<Mutex<HashMap<String, Arc<TtySession>>>> =
        Lazy::new(|| Mutex::new(HashMap::new()));

    /// The last `SCROLLBACK_LIMIT` bytes of a session's output.
    #[derive(Default)]
    struct Scrollback {
        bytes: VecDeque<u8>,
    }

    impl Scrollback {
        fn push(&mut self, data: &[u8]) {
            self.bytes.extend(data);
            trim_scrollback(&mut self.bytes, SCROLLBACK_LIMIT, SCROLLBACK_LINE_SEARCH);
        }

        fn is_empty(&self) -> bool {
            self.bytes.is_empty()
        }

        fn to_vec(&self) -> Vec<u8> {
            let (front, back) = self.bytes.as_slices();
            [front, back].concat()
        }
    }

    /// Drops the oldest bytes beyond `limit`, through the first newline
    /// within `line_search` bytes after the cut (only the excess when there
    /// is none, e.g. a full screen program redrawing).
    fn trim_scrollback(bytes: &mut VecDeque<u8>, limit: usize, line_search: usize) {
        if bytes.len() <= limit {
            return;
        }
        let cut = bytes.len() - limit;
        let search_end = (cut + line_search).min(bytes.len());
        let start = bytes
            .range(cut..search_end)
            .position(|b| *b == b'\n')
            .map_or(cut, |newline| cut + newline + 1);
        bytes.drain(..start);
    }

    /// Where a session's output goes: the attached terminal's channel, and
    /// the scrollback for a terminal attaching later. The channel is swapped
    /// by `tty_release` / `tty_attach`. Locked only for short, non-blocking
    /// work (channel sends are queued to the webview), so the reader never
    /// stalls and writers never wait for it; never locked while holding the
    /// `OUTPUTS` map lock (the other way around is fine).
    #[derive(Default)]
    struct Output {
        /// None while detached: output only goes to the scrollback.
        channel: Option<Channel<InvokeResponseBody>>,
        /// Label of the webview the terminal is attached to.
        owner: Option<String>,
        scrollback: Scrollback,
        /// The exit message once the process has ended, and when.
        ended: Option<(String, Instant)>,
    }

    impl Output {
        fn write(&mut self, data: &[u8]) {
            self.scrollback.push(data);
            if let Some(channel) = &self.channel {
                let _ = channel.send(InvokeResponseBody::Raw(data.to_vec()));
            }
        }
    }

    /// Outputs of the running sessions, and of sessions that ended while
    /// detached (until attached, stopped or `DETACHED_EXIT_TTL` passed).
    static OUTPUTS: Lazy<Mutex<HashMap<String, Arc<Mutex<Output>>>>> =
        Lazy::new(|| Mutex::new(HashMap::new()));

    /// JSON message sent on the session channel when the process has exited.
    /// Terminal output is sent as raw bytes on the same channel.
    #[derive(Clone, Debug, Serialize, PartialEq)]
    #[serde(
        tag = "type",
        rename_all = "camelCase",
        rename_all_fields = "camelCase"
    )]
    enum TtyEvent {
        Exit {
            exit_code: Option<u32>,
            error: Option<String>,
        },
    }

    // A panic while holding a lock must not take every terminal down.
    fn lock<T: ?Sized>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
        mutex.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn lock_sessions() -> std::sync::MutexGuard<'static, HashMap<String, Arc<TtySession>>> {
        lock(&TTY_SESSIONS)
    }

    fn get_session(session_id: &str) -> Result<Arc<TtySession>, String> {
        lock_sessions()
            .get(session_id)
            .cloned()
            .ok_or_else(|| format!("Terminal session {} not found", session_id))
    }

    fn remove_session(session_id: &str) -> Option<Arc<TtySession>> {
        lock_sessions().remove(session_id)
    }

    /// A snapshot of `OUTPUTS`, so outputs can be locked without the map.
    fn outputs() -> Vec<(String, Arc<Mutex<Output>>)> {
        lock(&OUTPUTS)
            .iter()
            .map(|(id, output)| (id.clone(), output.clone()))
            .collect()
    }

    /// Forgets sessions that ended while detached longer than
    /// `DETACHED_EXIT_TTL` ago (nobody attached them).
    fn prune_ended() {
        let expired: Vec<String> = outputs()
            .into_iter()
            .filter(|(_, output)| {
                lock(output)
                    .ended
                    .as_ref()
                    .is_some_and(|(_, at)| at.elapsed() > DETACHED_EXIT_TTL)
            })
            .map(|(id, _)| id)
            .collect();
        if !expired.is_empty() {
            let mut outputs = lock(&OUTPUTS);
            for id in &expired {
                outputs.remove(id);
            }
        }
    }

    fn get_output(session_id: &str) -> Result<Arc<Mutex<Output>>, String> {
        prune_ended();
        lock(&OUTPUTS)
            .get(session_id)
            .cloned()
            .ok_or_else(|| "The terminal session has ended".to_string())
    }

    /// SIGKILL the child's process group (the child is a session leader, so
    /// its pgid is its pid) and the child itself.
    #[cfg(unix)]
    fn force_kill(pid: u32) {
        let Ok(pid) = libc::pid_t::try_from(pid) else {
            return;
        };
        unsafe {
            libc::kill(-pid, libc::SIGKILL);
            libc::kill(pid, libc::SIGKILL);
        }
    }

    /// Ask the child to stop (SIGHUP on unix, TerminateProcess on Windows).
    /// On unix a child still running after `KILL_GRACE_PERIOD` is SIGKILLed,
    /// so the waiter always returns and the session always ends.
    fn terminate(session: &TtySession) -> std::io::Result<()> {
        let result = lock(&session.killer).kill();

        #[cfg(unix)]
        if let Some(pid) = session.pid {
            let exited = session.exited.clone();
            let _ = thread::Builder::new()
                .name(format!("tty-kill-{}", pid))
                .spawn(move || {
                    thread::sleep(KILL_GRACE_PERIOD);
                    if !exited.load(Ordering::SeqCst) {
                        warn!("TTY process {} ignored SIGHUP, killing it", pid);
                        force_kill(pid);
                    }
                });
        }

        result
    }

    fn remove_temp_files(files: &[PathBuf]) {
        for file in files {
            match std::fs::remove_file(file) {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => warn!("Failed to remove {}: {}", file.display(), e),
            }
        }
    }

    /// Clamp the requested terminal size to something the pty accepts.
    pub(crate) fn pty_size(rows: Option<u16>, cols: Option<u16>) -> PtySize {
        let clamp = |value: Option<u16>, default: u16| match value {
            Some(v) if v > 0 => v.min(MAX_DIMENSION),
            _ => default,
        };

        PtySize {
            rows: clamp(rows, DEFAULT_ROWS),
            cols: clamp(cols, DEFAULT_COLS),
            pixel_width: 0,
            pixel_height: 0,
        }
    }

    /// Build the pty command from an argv and extra environment variables.
    pub(crate) fn build_command(
        argv: Vec<String>,
        env: HashMap<String, String>,
    ) -> Result<CommandBuilder, String> {
        if argv
            .first()
            .map_or(true, |program| program.trim().is_empty())
        {
            return Err("No command to run in the terminal".to_string());
        }

        let mut cmd = CommandBuilder::from_argv(argv.into_iter().map(OsString::from).collect());

        // xterm.js is the terminal on the other end. GUI apps usually have no
        // TERM set, which leaves full screen programs in dumb mode.
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");

        for (key, value) in env {
            cmd.env(key, value);
        }

        Ok(cmd)
    }

    fn exit_message(exit_code: Option<u32>, error: Option<String>) -> String {
        let event = TtyEvent::Exit { exit_code, error };
        serde_json::to_string(&event).unwrap_or_else(|e| {
            warn!("Failed to serialize terminal exit event: {}", e);
            r#"{"type":"exit","exitCode":null,"error":null}"#.to_string()
        })
    }

    /// Reports the exit on the attached terminal, or keeps it (with the
    /// scrollback) for the next attach when the terminal is detached.
    fn report_exit(session_id: &str, output: &Mutex<Output>, message: String) {
        let mut output = lock(output);
        let attached = output.channel.is_some();
        if let Some(channel) = &output.channel {
            let _ = channel.send(InvokeResponseBody::Json(message.clone()));
        }
        output.ended = Some((message, Instant::now()));
        if attached {
            // Still under the output lock: an attach racing this one either
            // finds nothing or sees the ended session.
            lock(&OUTPUTS).remove(session_id);
        }
    }

    /// Spawn `cmd` in a new pty and start streaming its output to `on_event`,
    /// owned by webview `owner`. `temp_files` are removed once the session
    /// ends (also on failure); `route` (a cluster's SSH tunnel) is held
    /// until then.
    fn spawn_session(
        cmd: CommandBuilder,
        size: PtySize,
        owner: &str,
        on_event: Channel<InvokeResponseBody>,
        temp_files: Vec<PathBuf>,
        route: Option<crate::connection::Lease>,
    ) -> Result<String, String> {
        prune_ended();
        let program = cmd
            .get_argv()
            .first()
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_default();

        let result = (|| {
            let pair = native_pty_system()
                .openpty(size)
                .map_err(|e| format!("Failed to open a pseudo terminal: {}", e))?;

            let child = pair
                .slave
                .spawn_command(cmd)
                .map_err(|e| format!("Failed to start {}: {}", program, e))?;
            // Only the child should hold the slave side, so the reader sees
            // EOF once it exits.
            drop(pair.slave);

            let mut killer = child.clone_killer();
            let io = pair
                .master
                .try_clone_reader()
                .and_then(|reader| Ok((reader, pair.master.take_writer()?)));
            let (reader, writer) = match io {
                Ok(io) => io,
                Err(e) => {
                    let _ = killer.kill();
                    return Err(format!("Failed to attach to the pseudo terminal: {}", e));
                }
            };

            Ok((pair.master, child, killer, reader, writer))
        })();

        let (master, mut child, killer, mut reader, mut writer) = match result {
            Ok(parts) => parts,
            Err(e) => {
                remove_temp_files(&temp_files);
                return Err(e);
            }
        };

        let session_id = Uuid::new_v4().to_string();
        info!("Started TTY session {} running {}", session_id, program);

        // Writes block when the child stops reading (full pty buffer), so they
        // happen on a dedicated thread fed by a queue. The thread ends when the
        // session is dropped (queue closed) or the pty is gone.
        let (input_tx, input_rx) = mpsc::channel::<Vec<u8>>();
        let spawned_writer = thread::Builder::new()
            .name(format!("tty-writer-{}", session_id))
            .spawn(move || {
                for data in input_rx {
                    if writer
                        .write_all(&data)
                        .and_then(|_| writer.flush())
                        .is_err()
                    {
                        break;
                    }
                }
            });
        if let Err(e) = spawned_writer {
            let mut killer = killer;
            let _ = killer.kill();
            remove_temp_files(&temp_files);
            return Err(format!("Failed to start the terminal writer: {}", e));
        }

        let exited = Arc::new(AtomicBool::new(false));
        lock_sessions().insert(
            session_id.clone(),
            Arc::new(TtySession {
                input: input_tx,
                master: Mutex::new(master),
                killer: Mutex::new(killer),
                pid: child.process_id(),
                exited: exited.clone(),
                temp_files: temp_files.clone(),
            }),
        );

        let output = Arc::new(Mutex::new(Output {
            channel: Some(on_event),
            owner: Some(owner.to_string()),
            ..Output::default()
        }));
        lock(&OUTPUTS).insert(session_id.clone(), output.clone());

        let (reader_done_tx, reader_done_rx) = mpsc::channel::<()>();
        let reader_output = output.clone();
        let spawned_reader = thread::Builder::new()
            .name(format!("tty-reader-{}", session_id))
            .spawn(move || {
                let mut buf = [0u8; 16 * 1024];
                loop {
                    match reader.read(&mut buf) {
                        // EOF, or EIO on Linux once the child has exited.
                        Ok(0) => break,
                        Ok(n) => lock(&reader_output).write(&buf[..n]),
                        Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                        Err(_) => break,
                    }
                }
                let _ = reader_done_tx.send(());
            });

        if let Err(e) = spawned_reader {
            lock(&OUTPUTS).remove(&session_id);
            if let Some(session) = remove_session(&session_id) {
                let _ = terminate(&session);
            }
            remove_temp_files(&temp_files);
            return Err(format!("Failed to start the terminal reader: {}", e));
        }

        let waiter_session_id = session_id.clone();
        let spawned_waiter = thread::Builder::new()
            .name(format!("tty-waiter-{}", session_id))
            .spawn(move || {
                let status = child.wait();
                exited.store(true, Ordering::SeqCst);
                drop(route);

                // Closing the master is what makes the reader see EOF on
                // Windows (ClosePseudoConsole); on unix it is a no-op for the
                // reader, which already got EOF/EIO.
                drop(remove_session(&waiter_session_id));
                // Give the reader a moment to flush the last output before
                // reporting the exit.
                let _ = reader_done_rx.recv_timeout(Duration::from_secs(2));
                remove_temp_files(&temp_files);

                let message = match status {
                    Ok(status) => {
                        info!(
                            "TTY session {} exited with code {}",
                            waiter_session_id,
                            status.exit_code()
                        );
                        exit_message(Some(status.exit_code()), None)
                    }
                    Err(e) => {
                        warn!(
                            "Failed to wait for TTY session {}: {}",
                            waiter_session_id, e
                        );
                        exit_message(None, Some(e.to_string()))
                    }
                };
                // On whatever terminal is attached by now.
                report_exit(&waiter_session_id, &output, message);
            });

        if let Err(e) = spawned_waiter {
            // Without a waiter nobody reaps the child or cleans up: bail out.
            let _ = stop_tty_session(session_id.clone());
            return Err(format!(
                "Failed to start the terminal process watcher: {}",
                e
            ));
        }

        Ok(session_id)
    }

    /// Run `init_command` (argv, e.g. `kubectl exec -it ... -- /bin/sh`) in a
    /// new pty. Output and the exit are streamed to `on_event`: raw bytes for
    /// output, a JSON `{ type: "exit", exitCode, error }` message on exit.
    #[tauri::command]
    pub async fn create_tty_session(
        webview: tauri::Webview,
        init_command: Vec<String>,
        env: Option<HashMap<String, String>>,
        rows: Option<u16>,
        cols: Option<u16>,
        on_event: Channel<InvokeResponseBody>,
    ) -> Result<String, String> {
        info!("Creating TTY session");
        let (init_command, route) = routed_command(init_command).await?;
        let cmd = build_command(init_command, env.unwrap_or_default())?;
        let owner = webview.label().to_string();

        tauri::async_runtime::spawn_blocking(move || {
            spawn_session(cmd, pty_size(rows, cols), &owner, on_event, Vec::new(), route)
        })
        .await
        .map_err(|e| e.to_string())?
    }

    /// Open the user's local shell with `KUBECONFIG` pointing to a temporary
    /// copy of `context` (and `namespace`, when set) from `kube_config`. The
    /// user's own kubeconfig is never modified. `shell` (a program path or
    /// name, from the terminal settings) replaces the default shell.
    #[tauri::command]
    #[allow(clippy::too_many_arguments)] // the frontend's argument list
    pub async fn create_local_terminal_session(
        webview: tauri::Webview,
        kube_config: String,
        context: String,
        namespace: Option<String>,
        shell: Option<String>,
        rows: Option<u16>,
        cols: Option<u16>,
        on_event: Channel<InvokeResponseBody>,
    ) -> Result<String, String> {
        info!("Creating local terminal session for context {}", context);
        let owner = webview.label().to_string();
        let route = crate::connection::route(
            &crate::kubernetes::client::resolve_kubeconfig_path(Some(&kube_config)),
            &context,
        )
        .await?;

        let argv = terminal_shell_argv(
            shell.as_deref(),
            std::env::var_os("SHELL").as_deref(),
            std::env::var_os("PATH").as_deref(),
        );
        // HTTP(S) proxies also reach the shell's other tools.
        let env: HashMap<String, String> = route
            .as_ref()
            .map(|route| crate::connection::terminal_env(&route.url).into_iter().collect())
            .unwrap_or_default();

        tauri::async_runtime::spawn_blocking(move || {
            spawn_pinned_session(
                &kube_config,
                &context,
                namespace,
                argv,
                env,
                None,
                pty_size(rows, cols),
                &owner,
                on_event,
                route,
            )
        })
        .await
        .map_err(|e| e.to_string())?
    }

    /// Start an AI agent CLI (`argv`, e.g. `claude "…"`) for Ask AI, with
    /// `KUBECONFIG` pinned to a temporary copy of `context` like the local
    /// terminal. `env` is the agent's own settings (a read-only mode); it
    /// can't replace the pinned kubeconfig. The agent runs in a workspace
    /// directory of its own (`ask-ai/` in the app data directory), so it
    /// doesn't start in, and look through, the user's home directory, and
    /// agents that ask to trust their folder only ask once.
    #[tauri::command]
    #[allow(clippy::too_many_arguments)]
    pub async fn create_agent_terminal_session(
        webview: tauri::Webview,
        kube_config: String,
        context: String,
        namespace: Option<String>,
        argv: Vec<String>,
        env: Option<HashMap<String, String>>,
        rows: Option<u16>,
        cols: Option<u16>,
        on_event: Channel<InvokeResponseBody>,
    ) -> Result<String, String> {
        info!("Creating agent terminal session for context {}", context);
        let owner = webview.label().to_string();
        let workspace = crate::ai::agent_workspace(tauri::Manager::app_handle(&webview));
        // kubectl goes through the cluster's proxy via the kubeconfig; the
        // agent's own traffic doesn't.
        let route = crate::connection::route(
            &crate::kubernetes::client::resolve_kubeconfig_path(Some(&kube_config)),
            &context,
        )
        .await?;

        tauri::async_runtime::spawn_blocking(move || {
            spawn_pinned_session(
                &kube_config,
                &context,
                namespace,
                argv,
                env.unwrap_or_default(),
                workspace,
                pty_size(rows, cols),
                &owner,
                on_event,
                route,
            )
        })
        .await
        .map_err(|e| e.to_string())?
    }

    /// The pty command of a session with `KUBECONFIG` pinned to
    /// `kubeconfig`: set after `env`, so it always wins.
    pub(crate) fn pinned_command(
        argv: Vec<String>,
        mut env: HashMap<String, String>,
        kubeconfig: &Path,
        cwd: Option<&Path>,
    ) -> Result<CommandBuilder, String> {
        env.insert(
            "KUBECONFIG".to_string(),
            kubeconfig.to_string_lossy().into_owned(),
        );
        let mut cmd = build_command(argv, env)?;
        if let Some(cwd) = cwd {
            cmd.cwd(cwd);
        }
        Ok(cmd)
    }

    /// Write the temporary single-context kubeconfig and run `argv` with
    /// `KUBECONFIG` pointing to it, owned by webview `owner`; the file is
    /// removed when the session ends. `route` (a proxy or SSH jump host)
    /// goes into the kubeconfig; its tunnel is held until the session ends.
    #[allow(clippy::too_many_arguments)]
    fn spawn_pinned_session(
        kube_config: &str,
        context: &str,
        namespace: Option<String>,
        argv: Vec<String>,
        env: HashMap<String, String>,
        cwd: Option<PathBuf>,
        size: PtySize,
        owner: &str,
        on_event: Channel<InvokeResponseBody>,
        route: Option<crate::connection::Route>,
    ) -> Result<String, String> {
        let temp_kubeconfig = write_temp_kubeconfig(
            &std::env::temp_dir(),
            kube_config,
            context,
            normalize_namespace(namespace).as_deref(),
            route.as_ref().map(|r| r.url.as_str()),
        )?;

        let cmd = match pinned_command(argv, env, &temp_kubeconfig, cwd.as_deref()) {
            Ok(cmd) => cmd,
            Err(e) => {
                remove_temp_files(&[temp_kubeconfig]);
                return Err(e);
            }
        };

        spawn_session(cmd, size, owner, on_event, vec![temp_kubeconfig], route.and_then(|r| r.lease))
    }

    /// Stops a session. Its attached terminal still gets the exit; it can't
    /// be attached anymore.
    #[tauri::command]
    pub fn stop_tty_session(session_id: String) -> Result<(), String> {
        info!("Stopping TTY session: {}", session_id);
        // Also forgets a session that ended while detached.
        lock(&OUTPUTS).remove(&session_id);

        // Already gone when the process exited by itself.
        let Some(session) = remove_session(&session_id) else {
            return Ok(());
        };

        terminate(&session).map_err(|e| format!("Failed to stop the terminal process: {}", e))
    }

    // Deliberately synchronous so keystrokes stay in order; it only queues
    // the data for the writer thread and never blocks. Never log the data, it
    // may contain passwords.
    #[tauri::command]
    pub fn write_to_pty(session_id: String, data: String) -> Result<(), String> {
        get_session(&session_id)?
            .input
            .send(data.into_bytes())
            .map_err(|_| "The terminal is no longer accepting input".to_string())
    }

    #[tauri::command]
    pub fn resize_pty(session_id: String, rows: u16, cols: u16) -> Result<(), String> {
        if rows == 0 || cols == 0 {
            return Ok(());
        }

        let session = get_session(&session_id)?;
        let master = lock(&session.master);

        master
            .resize(pty_size(Some(rows), Some(cols)))
            .map_err(|e| format!("Failed to resize the terminal: {}", e))
    }

    /// Detaches the terminal of a session (it is moving to another window):
    /// the process keeps running, its output only goes to the scrollback
    /// until `tty_attach`, and closing the window no longer stops it.
    #[tauri::command]
    pub fn tty_release(session_id: String) -> Result<(), String> {
        let output = get_output(&session_id)?;
        let mut output = lock(&output);
        output.channel = None;
        output.owner = None;
        info!("Released TTY session {}", session_id);
        Ok(())
    }

    /// Attaches the calling webview's terminal to a session: the scrollback
    /// is replayed to `on_event` as one raw message (when there is any),
    /// then output streams there and the caller owns the session. A session
    /// that ended while detached replays its scrollback followed by the exit
    /// message. Fails when the session is gone (ended while attached
    /// elsewhere, stopped, or unknown).
    #[tauri::command]
    pub fn tty_attach(
        webview: tauri::Webview,
        session_id: String,
        on_event: Channel<InvokeResponseBody>,
    ) -> Result<(), String> {
        attach(&session_id, webview.label(), on_event)
    }

    fn attach(
        session_id: &str,
        owner: &str,
        channel: Channel<InvokeResponseBody>,
    ) -> Result<(), String> {
        let output = get_output(session_id)?;
        // Replay and swap under the output lock: the reader can't slip output
        // in between (lost or sent twice).
        let mut output = lock(&output);
        if !output.scrollback.is_empty() {
            let _ = channel.send(InvokeResponseBody::Raw(output.scrollback.to_vec()));
        }
        if let Some((message, _)) = &output.ended {
            let _ = channel.send(InvokeResponseBody::Json(message.clone()));
            lock(&OUTPUTS).remove(session_id);
            info!("Attached ended TTY session {} to {}", session_id, owner);
            return Ok(());
        }
        output.channel = Some(channel);
        output.owner = Some(owner.to_string());
        info!("Attached TTY session {} to {}", session_id, owner);
        Ok(())
    }

    /// Stops the sessions whose terminal is attached to webview `owner` (its
    /// window was closed). Returns how many.
    pub fn stop_sessions_of(owner: &str) -> usize {
        let owned: Vec<String> = outputs()
            .into_iter()
            .filter(|(_, output)| lock(output).owner.as_deref() == Some(owner))
            .map(|(id, _)| id)
            .collect();
        for session_id in &owned {
            if let Err(e) = stop_tty_session(session_id.clone()) {
                warn!("{}", e);
            }
        }
        owned.len()
    }

    /// Kill every running session and remove their temporary kubeconfigs.
    /// Called on app exit so no `kubectl exec` / shell processes are orphaned.
    pub fn kill_all_tty_sessions() {
        lock(&OUTPUTS).clear();
        let sessions: Vec<_> = lock_sessions().drain().map(|(_, s)| s).collect();

        for session in &sessions {
            let _ = lock(&session.killer).kill();
            remove_temp_files(&session.temp_files);
        }

        // The app is about to exit, so the grace period threads of
        // `terminate` would never run: wait briefly here instead.
        #[cfg(unix)]
        {
            let deadline = std::time::Instant::now() + Duration::from_millis(500);
            while std::time::Instant::now() < deadline
                && sessions.iter().any(|s| !s.exited.load(Ordering::SeqCst))
            {
                thread::sleep(Duration::from_millis(20));
            }
            for session in &sessions {
                if !session.exited.load(Ordering::SeqCst) {
                    if let Some(pid) = session.pid {
                        force_kill(pid);
                    }
                }
            }
        }
    }

    /// Remove temporary kubeconfigs left behind by a previous run that did
    /// not exit cleanly (they contain flattened credentials). Returns the
    /// number of removed files.
    pub(crate) fn sweep_temp_kubeconfigs(dir: &Path) -> usize {
        let Ok(entries) = std::fs::read_dir(dir) else {
            return 0;
        };

        let stale: Vec<PathBuf> = entries
            .filter_map(Result::ok)
            .filter(|entry| entry.file_type().map_or(false, |t| t.is_file()))
            .filter(|entry| {
                let name = entry.file_name();
                let name = name.to_string_lossy();
                (name.starts_with(TEMP_KUBECONFIG_PREFIX) && name.ends_with(TEMP_KUBECONFIG_SUFFIX))
                    || (name.starts_with(crate::connection::cli::TEMP_PREFIX)
                        && name.ends_with(crate::connection::cli::TEMP_SUFFIX))
            })
            .map(|entry| entry.path())
            .collect();

        remove_temp_files(&stale);
        stale.iter().filter(|path| !path.exists()).count()
    }

    /// Startup cleanup, see `sweep_temp_kubeconfigs`.
    pub fn sweep_stale_temp_kubeconfigs() {
        let removed = sweep_temp_kubeconfigs(&std::env::temp_dir());
        if removed > 0 {
            info!("Removed {} stale temporary terminal kubeconfig(s)", removed);
        }
    }

    /// An empty namespace or "all" means no specific namespace.
    pub(crate) fn normalize_namespace(namespace: Option<String>) -> Option<String> {
        namespace
            .map(|ns| ns.trim().to_string())
            .filter(|ns| !ns.is_empty() && ns != "all")
    }

    pub(crate) fn minify_kubeconfig_args(kube_config: &str, context: &str) -> Vec<String> {
        let mut args: Vec<String> = vec![
            "config".into(),
            "view".into(),
            "--minify".into(),
            "--flatten".into(),
            "--raw".into(),
            "--context".into(),
            context.into(),
        ];
        if !kube_config.is_empty() {
            args.push("--kubeconfig".into());
            args.push(kube_config.into());
        }
        args
    }

    pub(crate) fn set_context_args(
        temp_kubeconfig: &Path,
        context: &str,
        namespace: &str,
    ) -> Vec<String> {
        vec![
            "config".into(),
            "set-context".into(),
            context.into(),
            "--namespace".into(),
            namespace.into(),
            "--kubeconfig".into(),
            temp_kubeconfig.to_string_lossy().into_owned(),
        ]
    }

    /// `kubectl` / `helm` command lines (`kubectl exec`, `kubectl debug`) of
    /// a cluster with a proxy or SSH jump host get its proxied kubeconfig.
    async fn routed_command(
        argv: Vec<String>,
    ) -> Result<(Vec<String>, Option<crate::connection::Lease>), String> {
        let routed = argv.first().is_some_and(|program| {
            let name = Path::new(program).file_stem().map(|s| s.to_string_lossy().to_lowercase());
            matches!(name.as_deref(), Some("kubectl" | "helm"))
        });
        if !routed {
            return Ok((argv, None));
        }
        let mut argv = argv;
        let args = argv.split_off(1);
        let (args, lease) = crate::connection::cli_args(args).await?;
        argv.extend(args);
        Ok((argv, lease))
    }

    fn run_kubectl(args: &[String]) -> Result<Vec<u8>, String> {
        let mut cmd = Command::new("kubectl");
        cmd.args(args);
        // Don't flash a console window from the GUI app (see run_kubectl in
        // kubernetes.rs, issue #70).
        #[cfg(windows)]
        cmd.creation_flags(0x08000000);

        let output = cmd
            .output()
            .map_err(|e| format!("Failed to run kubectl: {}", e))?;

        if output.status.success() {
            Ok(output.stdout)
        } else {
            Err(format!(
                "kubectl {} failed: {}",
                args.first().map(String::as_str).unwrap_or_default(),
                String::from_utf8_lossy(&output.stderr).trim()
            ))
        }
    }

    /// Create `path` with owner-only permissions; fails if it already exists.
    pub(crate) fn write_private_file(path: &Path, contents: &[u8]) -> std::io::Result<()> {
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }

        let mut file = options.open(path)?;
        file.write_all(contents)?;
        file.flush()
    }

    pub(crate) fn temp_kubeconfig_path(dir: &Path) -> PathBuf {
        dir.join(format!(
            "{}{}{}",
            TEMP_KUBECONFIG_PREFIX,
            Uuid::new_v4(),
            TEMP_KUBECONFIG_SUFFIX
        ))
    }

    /// `kubectl config view --minify --flatten` of a single context, written to
    /// a private temp file, optionally with the namespace set on the context
    /// and the cluster's proxy as `proxy-url`.
    fn write_temp_kubeconfig(
        dir: &Path,
        kube_config: &str,
        context: &str,
        namespace: Option<&str>,
        proxy: Option<&str>,
    ) -> Result<PathBuf, String> {
        if context.is_empty() {
            return Err("No context selected".to_string());
        }

        let contents = match proxy {
            None => run_kubectl(&minify_kubeconfig_args(kube_config, context))?,
            Some(proxy) => crate::connection::cli::with_proxy_url(
                &run_kubectl(&crate::connection::cli::minify_args(kube_config, context))?,
                proxy,
            )?,
        };
        let path = temp_kubeconfig_path(dir);

        write_private_file(&path, &contents).map_err(|e| {
            format!(
                "Failed to write temporary kubeconfig {}: {}",
                path.display(),
                e
            )
        })?;

        if let Some(namespace) = namespace {
            if let Err(e) = run_kubectl(&set_context_args(&path, context, namespace)) {
                remove_temp_files(&[path]);
                return Err(e);
            }
        }

        Ok(path)
    }

    /// Find `exe` in the directories of a PATH-style list.
    #[cfg_attr(not(windows), allow(dead_code))]
    pub(crate) fn find_in_path(exe: &str, path: &OsStr) -> Option<PathBuf> {
        std::env::split_paths(path)
            .map(|dir| dir.join(exe))
            .find(|candidate| candidate.is_file())
    }

    /// The local terminal's shell: `shell` (the user's setting) when set,
    /// otherwise the default from [`local_shell_argv`].
    pub(crate) fn terminal_shell_argv(
        shell: Option<&str>,
        env_shell: Option<&OsStr>,
        path: Option<&OsStr>,
    ) -> Vec<String> {
        match shell.map(str::trim).filter(|s| !s.is_empty()) {
            Some(program) => shell_argv(program),
            None => local_shell_argv(env_shell, path),
        }
    }

    /// The user's shell: `$SHELL` (fallback `/bin/sh`) on unix, PowerShell 7
    /// (`pwsh.exe`) when installed or Windows PowerShell on Windows.
    #[cfg(not(windows))]
    pub(crate) fn local_shell_argv(shell: Option<&OsStr>, _path: Option<&OsStr>) -> Vec<String> {
        let shell = shell
            .map(|s| s.to_string_lossy().trim().to_string())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "/bin/sh".to_string());

        shell_argv(&shell)
    }

    #[cfg(windows)]
    pub(crate) fn local_shell_argv(_shell: Option<&OsStr>, path: Option<&OsStr>) -> Vec<String> {
        let shell = path
            .and_then(|path| find_in_path("pwsh.exe", path))
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_else(|| "powershell.exe".to_string());

        shell_argv(&shell)
    }

    /// The argv that starts `program` as the terminal's interactive shell:
    /// the program alone (the pty makes it interactive), plus `-NoLogo` for
    /// PowerShell on Windows.
    #[cfg(not(windows))]
    fn shell_argv(program: &str) -> Vec<String> {
        vec![program.to_string()]
    }

    #[cfg(windows)]
    fn shell_argv(program: &str) -> Vec<String> {
        let stem = Path::new(program)
            .file_stem()
            .map(|s| s.to_string_lossy().to_ascii_lowercase())
            .unwrap_or_default();
        let mut argv = vec![program.to_string()];
        if stem == "pwsh" || stem == "powershell" {
            argv.push("-NoLogo".to_string());
        }
        argv
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use crate::windows::MAIN;

        #[test]
        fn pty_size_falls_back_and_clamps() {
            let size = pty_size(None, Some(0));
            assert_eq!((size.rows, size.cols), (DEFAULT_ROWS, DEFAULT_COLS));

            let size = pty_size(Some(50), Some(u16::MAX));
            assert_eq!((size.rows, size.cols), (50, MAX_DIMENSION));
        }

        #[test]
        fn build_command_uses_argv_and_env() {
            let mut env = HashMap::new();
            env.insert("KUBECONFIG".to_string(), "/tmp/x".to_string());

            let cmd = build_command(
                vec![
                    "kubectl".into(),
                    "exec".into(),
                    "--".into(),
                    "/bin/sh".into(),
                ],
                env,
            )
            .unwrap();

            assert_eq!(
                cmd.get_argv(),
                &vec![
                    OsString::from("kubectl"),
                    OsString::from("exec"),
                    OsString::from("--"),
                    OsString::from("/bin/sh")
                ]
            );
            assert_eq!(cmd.get_env("KUBECONFIG"), Some(OsStr::new("/tmp/x")));
            assert_eq!(cmd.get_env("TERM"), Some(OsStr::new("xterm-256color")));
        }

        #[test]
        fn pinned_command_keeps_the_pinned_kubeconfig() {
            let mut env = HashMap::new();
            env.insert("KUBECONFIG".to_string(), "/home/me/.kube/config".to_string());
            env.insert("OPENCODE_PERMISSION".to_string(), "{}".to_string());

            let cmd = pinned_command(
                vec!["claude".into(), "Why?".into()],
                env,
                Path::new("/tmp/pinned.yaml"),
                Some(Path::new("/tmp/ask-ai")),
            )
            .unwrap();

            assert_eq!(cmd.get_env("KUBECONFIG"), Some(OsStr::new("/tmp/pinned.yaml")));
            assert_eq!(cmd.get_env("OPENCODE_PERMISSION"), Some(OsStr::new("{}")));
            assert_eq!(cmd.get_cwd().map(OsString::as_os_str), Some(OsStr::new("/tmp/ask-ai")));

            let cmd = pinned_command(vec!["sh".into()], HashMap::new(), Path::new("k"), None).unwrap();
            assert_eq!(cmd.get_cwd(), None);
            assert!(pinned_command(vec![], HashMap::new(), Path::new("k"), None).is_err());
        }

        #[test]
        fn build_command_rejects_empty_argv() {
            assert!(build_command(vec![], HashMap::new()).is_err());
            assert!(build_command(vec![" ".into()], HashMap::new()).is_err());
        }

        #[test]
        fn normalize_namespace_drops_all_and_empty() {
            assert_eq!(normalize_namespace(None), None);
            assert_eq!(normalize_namespace(Some("".into())), None);
            assert_eq!(normalize_namespace(Some("all".into())), None);
            assert_eq!(
                normalize_namespace(Some(" default ".into())),
                Some("default".into())
            );
        }

        #[test]
        fn kubectl_args() {
            assert_eq!(
                minify_kubeconfig_args("/home/me/.kube/config", "prod"),
                vec![
                    "config",
                    "view",
                    "--minify",
                    "--flatten",
                    "--raw",
                    "--context",
                    "prod",
                    "--kubeconfig",
                    "/home/me/.kube/config"
                ]
            );
            assert!(!minify_kubeconfig_args("", "prod").contains(&"--kubeconfig".to_string()));

            let args = set_context_args(Path::new("tmp.yaml"), "prod", "web");
            assert_eq!(
                args,
                vec![
                    "config",
                    "set-context",
                    "prod",
                    "--namespace",
                    "web",
                    "--kubeconfig",
                    "tmp.yaml"
                ]
            );
        }

        #[test]
        fn temp_kubeconfig_is_private_and_unique() {
            let dir = std::env::temp_dir();
            let path = temp_kubeconfig_path(&dir);
            assert_ne!(path, temp_kubeconfig_path(&dir));
            assert!(path
                .file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with(TEMP_KUBECONFIG_PREFIX));

            write_private_file(&path, b"apiVersion: v1\n").unwrap();
            // create_new: never overwrite an existing file.
            assert!(write_private_file(&path, b"x").is_err());

            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let mode = std::fs::metadata(&path).unwrap().permissions().mode();
                assert_eq!(mode & 0o777, 0o600);
            }

            remove_temp_files(&[path.clone()]);
            assert!(!path.exists());
            // Removing twice (exit + session end) is fine.
            remove_temp_files(&[path]);
        }

        #[test]
        fn find_in_path_finds_files_only() {
            let dir = std::env::temp_dir().join(format!("jet-pilot-path-test-{}", Uuid::new_v4()));
            std::fs::create_dir_all(dir.join("subdir")).unwrap();
            std::fs::write(dir.join("tool"), b"").unwrap();

            let path = std::env::join_paths([dir.clone()]).unwrap();
            assert_eq!(find_in_path("tool", &path), Some(dir.join("tool")));
            assert_eq!(find_in_path("subdir", &path), None);
            assert_eq!(find_in_path("missing", &path), None);

            std::fs::remove_dir_all(dir).unwrap();
        }

        #[cfg(not(windows))]
        #[test]
        fn local_shell_uses_shell_env_with_fallback() {
            assert_eq!(
                local_shell_argv(Some(OsStr::new("/bin/zsh")), None),
                vec!["/bin/zsh"]
            );
            assert_eq!(
                local_shell_argv(Some(OsStr::new("")), None),
                vec!["/bin/sh"]
            );
            assert_eq!(local_shell_argv(None, None), vec!["/bin/sh"]);
        }

        #[cfg(not(windows))]
        #[test]
        fn configured_shell_overrides_the_default() {
            let zsh = Some(OsStr::new("/bin/zsh"));
            assert_eq!(
                terminal_shell_argv(Some("/usr/bin/fish"), zsh, None),
                vec!["/usr/bin/fish"]
            );
            assert_eq!(terminal_shell_argv(Some(" bash "), zsh, None), vec!["bash"]);
            // Unset or blank: the default ($SHELL).
            assert_eq!(terminal_shell_argv(Some("  "), zsh, None), vec!["/bin/zsh"]);
            assert_eq!(terminal_shell_argv(None, zsh, None), vec!["/bin/zsh"]);
            assert_eq!(terminal_shell_argv(None, None, None), vec!["/bin/sh"]);
        }

        #[cfg(windows)]
        #[test]
        fn configured_shell_overrides_the_default() {
            assert_eq!(
                terminal_shell_argv(Some(r"C:\Program Files\PowerShell\7\pwsh.exe"), None, None),
                vec![r"C:\Program Files\PowerShell\7\pwsh.exe", "-NoLogo"]
            );
            assert_eq!(
                terminal_shell_argv(Some("powershell.exe"), None, None),
                vec!["powershell.exe", "-NoLogo"]
            );
            assert_eq!(terminal_shell_argv(Some("cmd.exe"), None, None), vec!["cmd.exe"]);
            assert_eq!(
                terminal_shell_argv(Some(" "), None, None),
                vec!["powershell.exe", "-NoLogo"]
            );
        }

        /// A channel collecting raw output and the exit JSON message.
        #[cfg(unix)]
        fn collecting_channel() -> (
            Channel<InvokeResponseBody>,
            mpsc::Receiver<InvokeResponseBody>,
        ) {
            let (tx, rx) = mpsc::channel();
            let tx = Mutex::new(tx);
            let channel = Channel::new(move |body| {
                let _ = tx.lock().unwrap().send(body);
                Ok(())
            });
            (channel, rx)
        }

        /// Collect output until the exit message arrives.
        #[cfg(unix)]
        fn collect_until_exit(rx: &mpsc::Receiver<InvokeResponseBody>) -> (String, String) {
            let mut output = Vec::new();
            loop {
                match rx
                    .recv_timeout(Duration::from_secs(10))
                    .expect("no exit event")
                {
                    InvokeResponseBody::Raw(bytes) => output.extend(bytes),
                    InvokeResponseBody::Json(json) => {
                        return (String::from_utf8_lossy(&output).into_owned(), json)
                    }
                }
            }
        }

        #[cfg(unix)]
        #[test]
        fn session_streams_output_env_and_exit_code() {
            let temp_file = temp_kubeconfig_path(&std::env::temp_dir());
            write_private_file(&temp_file, b"").unwrap();

            let mut env = HashMap::new();
            env.insert("JET_PILOT_TEST".to_string(), "from-env".to_string());
            let cmd = build_command(
                vec![
                    "/bin/sh".into(),
                    "-c".into(),
                    "echo \"$JET_PILOT_TEST $TERM\"; stty size; exit 3".into(),
                ],
                env,
            )
            .unwrap();

            let (channel, rx) = collecting_channel();
            let session_id = spawn_session(
                cmd,
                pty_size(Some(33), Some(101)),
                MAIN,
                channel,
                vec![temp_file.clone()],
                None,
            )
            .unwrap();

            let (output, exit) = collect_until_exit(&rx);
            assert!(
                output.contains("from-env xterm-256color"),
                "output: {output:?}"
            );
            assert!(output.contains("33 101"), "output: {output:?}");
            assert_eq!(exit, r#"{"type":"exit","exitCode":3,"error":null}"#);

            // Session and temp files are gone once the process exited.
            assert!(get_session(&session_id).is_err());
            assert!(!temp_file.exists());
        }

        #[cfg(unix)]
        #[test]
        fn session_accepts_input_resize_and_stop() {
            let cmd = build_command(
                vec![
                    "/bin/sh".into(),
                    "-c".into(),
                    "read line; echo \"got:$line\"; sleep 30".into(),
                ],
                HashMap::new(),
            )
            .unwrap();

            let (channel, rx) = collecting_channel();
            let session_id = spawn_session(cmd, pty_size(None, None), MAIN, channel, Vec::new(), None).unwrap();

            resize_pty(session_id.clone(), 40, 120).unwrap();
            write_to_pty(session_id.clone(), "hello\n".into()).unwrap();

            let mut output = Vec::new();
            while !String::from_utf8_lossy(&output).contains("got:hello") {
                match rx.recv_timeout(Duration::from_secs(10)).expect("no output") {
                    InvokeResponseBody::Raw(bytes) => output.extend(bytes),
                    InvokeResponseBody::Json(json) => panic!("unexpected exit: {json}"),
                }
            }

            stop_tty_session(session_id.clone()).unwrap();
            let (_, exit) = collect_until_exit(&rx);
            assert!(exit.contains(r#""type":"exit""#), "exit: {exit}");

            // Stopping again or writing to a stopped session does not panic.
            assert!(stop_tty_session(session_id.clone()).is_ok());
            assert!(write_to_pty(session_id, "x".into()).is_err());
        }

        #[test]
        fn spawn_failure_is_an_error_and_cleans_up() {
            let temp_file = temp_kubeconfig_path(&std::env::temp_dir());
            write_private_file(&temp_file, b"").unwrap();

            let cmd = build_command(
                vec!["/definitely/not/a/real/program-jet-pilot".into()],
                HashMap::new(),
            )
            .unwrap();
            let channel = Channel::new(|_| Ok(()));

            let result = spawn_session(cmd, pty_size(None, None), MAIN, channel, vec![temp_file.clone()], None);
            assert!(result.is_err());
            assert!(!temp_file.exists());
        }

        #[cfg(unix)]
        #[test]
        fn writes_never_block_when_the_child_stops_reading() {
            let cmd = build_command(
                vec!["/bin/sh".into(), "-c".into(), "sleep 30".into()],
                HashMap::new(),
            )
            .unwrap();
            let (channel, rx) = collecting_channel();
            let session_id = spawn_session(cmd, pty_size(None, None), MAIN, channel, Vec::new(), None).unwrap();

            // Far more than the pty buffer holds; nobody reads it.
            let started = std::time::Instant::now();
            let chunk = "x".repeat(64 * 1024);
            for _ in 0..32 {
                write_to_pty(session_id.clone(), chunk.clone()).unwrap();
            }
            resize_pty(session_id.clone(), 30, 90).unwrap();
            assert!(started.elapsed() < Duration::from_secs(2));

            stop_tty_session(session_id).unwrap();
            let (_, exit) = collect_until_exit(&rx);
            assert!(exit.contains(r#""type":"exit""#), "exit: {exit}");
        }

        #[cfg(unix)]
        #[test]
        fn stop_kills_a_child_that_ignores_sighup() {
            let cmd = build_command(
                vec![
                    "/bin/sh".into(),
                    "-c".into(),
                    "trap '' HUP; echo ready; sleep 30; echo survived".into(),
                ],
                HashMap::new(),
            )
            .unwrap();
            let (channel, rx) = collecting_channel();
            let session_id = spawn_session(cmd, pty_size(None, None), MAIN, channel, Vec::new(), None).unwrap();

            let mut output = Vec::new();
            while !String::from_utf8_lossy(&output).contains("ready") {
                match rx.recv_timeout(Duration::from_secs(10)).expect("no output") {
                    InvokeResponseBody::Raw(bytes) => output.extend(bytes),
                    InvokeResponseBody::Json(json) => panic!("unexpected exit: {json}"),
                }
            }

            let started = std::time::Instant::now();
            stop_tty_session(session_id).unwrap();
            let (rest, exit) = collect_until_exit(&rx);
            assert!(exit.contains(r#""type":"exit""#), "exit: {exit}");
            assert!(!rest.contains("survived"));
            assert!(started.elapsed() >= KILL_GRACE_PERIOD);
            assert!(started.elapsed() < Duration::from_secs(10));
        }

        #[test]
        fn sweep_removes_only_terminal_kubeconfigs() {
            let dir = std::env::temp_dir().join(format!("jet-pilot-sweep-test-{}", Uuid::new_v4()));
            std::fs::create_dir_all(&dir).unwrap();

            let stale = [temp_kubeconfig_path(&dir), temp_kubeconfig_path(&dir)];
            for path in &stale {
                write_private_file(path, b"apiVersion: v1\n").unwrap();
            }
            let unrelated = dir.join("kubeconfig.yaml");
            std::fs::write(&unrelated, b"").unwrap();
            let other_suffix = dir.join(format!("{}notes.txt", TEMP_KUBECONFIG_PREFIX));
            std::fs::write(&other_suffix, b"").unwrap();
            let directory = dir.join(format!(
                "{}dir{}",
                TEMP_KUBECONFIG_PREFIX, TEMP_KUBECONFIG_SUFFIX
            ));
            std::fs::create_dir(&directory).unwrap();

            assert_eq!(sweep_temp_kubeconfigs(&dir), 2);
            assert!(stale.iter().all(|path| !path.exists()));
            assert!(unrelated.exists() && other_suffix.exists() && directory.exists());
            assert_eq!(sweep_temp_kubeconfigs(&dir.join("missing")), 0);

            std::fs::remove_dir_all(dir).unwrap();
        }

        #[test]
        fn exit_event_json() {
            let json = serde_json::to_string(&TtyEvent::Exit {
                exit_code: Some(1),
                error: None,
            })
            .unwrap();
            assert_eq!(json, r#"{"type":"exit","exitCode":1,"error":null}"#);
        }

        fn trimmed(data: &str, limit: usize, line_search: usize) -> String {
            let mut bytes: VecDeque<u8> = data.bytes().collect();
            trim_scrollback(&mut bytes, limit, line_search);
            String::from_utf8(bytes.into_iter().collect()).unwrap()
        }

        #[test]
        fn scrollback_is_trimmed_at_a_line_boundary() {
            // Within the limit: untouched.
            assert_eq!(trimmed("aaaa\nbbbb", 16, 4), "aaaa\nbbbb");
            // Cut at 6 ("bb\ncccc" kept), the next line starts at 10.
            assert_eq!(trimmed("aaaa\nbbbb\ncccc", 8, 4), "cccc");
            // A newline right at the cut is dropped with it.
            assert_eq!(trimmed("aaaa\nbbbb", 5, 4), "bbbb");
            // No newline close enough to the cut: just the excess.
            assert_eq!(trimmed("abcdefghij", 4, 2), "ghij");
            assert_eq!(trimmed("abcdefgh\nij", 5, 2), "gh\nij");
        }

        #[test]
        fn scrollback_keeps_the_last_256_kib() {
            let mut scrollback = Scrollback::default();
            for i in 0..40_000 {
                scrollback.push(format!("line {i}\n").as_bytes());
            }
            let text = String::from_utf8(scrollback.to_vec()).unwrap();
            assert!(text.len() <= SCROLLBACK_LIMIT && text.len() > SCROLLBACK_LIMIT - 64);
            assert!(text.starts_with("line "), "replay starts at a line: {:?}", &text[..20]);
            assert!(text.ends_with("line 39999\n"));

            let mut scrollback = Scrollback::default();
            for _ in 0..20 {
                scrollback.push(&[b'x'; 16 * 1024]);
            }
            assert_eq!(scrollback.to_vec().len(), SCROLLBACK_LIMIT);
        }

        #[test]
        fn unknown_sessions_cannot_be_moved() {
            let channel = Channel::new(|_| Ok(()));
            assert_eq!(
                attach("no-such-session", "pop-a", channel).unwrap_err(),
                "The terminal session has ended"
            );
            assert!(tty_release("no-such-session".into()).is_err());
        }

        #[cfg(unix)]
        fn scrollback_of(session_id: &str) -> String {
            let output = lock(&OUTPUTS).get(session_id).cloned().unwrap();
            let bytes = lock(&output).scrollback.to_vec();
            String::from_utf8_lossy(&bytes).into_owned()
        }

        #[cfg(unix)]
        fn wait_for(what: &str, mut done: impl FnMut() -> bool) {
            let started = std::time::Instant::now();
            while !done() {
                assert!(started.elapsed() < Duration::from_secs(10), "timed out waiting for {what}");
                thread::sleep(Duration::from_millis(10));
            }
        }

        /// Raw output received until `text` shows up.
        #[cfg(unix)]
        fn read_until(rx: &mpsc::Receiver<InvokeResponseBody>, text: &str) -> String {
            let mut output = Vec::new();
            while !String::from_utf8_lossy(&output).contains(text) {
                match rx.recv_timeout(Duration::from_secs(10)).expect("no output") {
                    InvokeResponseBody::Raw(bytes) => output.extend(bytes),
                    InvokeResponseBody::Json(json) => panic!("unexpected exit: {json}"),
                }
            }
            String::from_utf8_lossy(&output).into_owned()
        }

        #[cfg(unix)]
        #[test]
        fn a_released_session_keeps_running_and_reattaches_with_its_scrollback() {
            let cmd = build_command(
                vec![
                    "/bin/sh".into(),
                    "-c".into(),
                    "echo first; read x; echo \"second:$x\"; read y; echo \"third:$y\"; sleep 30".into(),
                ],
                HashMap::new(),
            )
            .unwrap();
            let (old_channel, old_rx) = collecting_channel();
            let session_id =
                spawn_session(cmd, pty_size(None, None), "pop-tty-old", old_channel, Vec::new(), None).unwrap();
            read_until(&old_rx, "first");

            tty_release(session_id.clone()).unwrap();
            // Closing the old window doesn't stop a released session.
            assert_eq!(stop_sessions_of("pop-tty-old"), 0);
            write_to_pty(session_id.clone(), "x\n".into()).unwrap();
            wait_for("detached output", || scrollback_of(&session_id).contains("second:x"));

            let (new_channel, new_rx) = collecting_channel();
            attach(&session_id, "pop-tty-test", new_channel).unwrap();
            match new_rx.recv_timeout(Duration::from_secs(10)).unwrap() {
                InvokeResponseBody::Raw(bytes) => {
                    let replay = String::from_utf8_lossy(&bytes);
                    assert!(replay.contains("first") && replay.contains("second:x"), "replay: {replay:?}");
                }
                InvokeResponseBody::Json(json) => panic!("unexpected message: {json}"),
            }

            write_to_pty(session_id.clone(), "y\n".into()).unwrap();
            read_until(&new_rx, "third:y");
            let old: Vec<InvokeResponseBody> = old_rx.try_iter().collect();
            assert!(
                old.iter().all(|body| match body {
                    InvokeResponseBody::Raw(bytes) => !String::from_utf8_lossy(bytes).contains("second:x"),
                    InvokeResponseBody::Json(_) => false,
                }),
                "the old terminal got output after the release"
            );

            // The new window owns it now: closing it stops the session, and
            // the exit arrives on the new channel.
            assert_eq!(stop_sessions_of("pop-tty-test"), 1);
            let (_, exit) = collect_until_exit(&new_rx);
            assert!(exit.contains(r#""type":"exit""#), "exit: {exit}");
            assert!(attach(&session_id, MAIN, Channel::new(|_| Ok(()))).is_err());
        }

        #[cfg(unix)]
        #[test]
        fn a_session_that_ends_while_detached_reports_on_attach() {
            let cmd = build_command(
                vec![
                    "/bin/sh".into(),
                    "-c".into(),
                    "read x; echo \"bye:$x\"; exit 4".into(),
                ],
                HashMap::new(),
            )
            .unwrap();
            let (channel, rx) = collecting_channel();
            let session_id = spawn_session(cmd, pty_size(None, None), MAIN, channel, Vec::new(), None).unwrap();
            tty_release(session_id.clone()).unwrap();
            write_to_pty(session_id.clone(), "z\n".into()).unwrap();

            wait_for("the detached exit", || {
                let output = lock(&OUTPUTS).get(&session_id).cloned().unwrap();
                let ended = lock(&output).ended.is_some();
                ended
            });
            assert!(rx.try_iter().next().is_none(), "nothing goes to a released terminal");

            let (channel, rx) = collecting_channel();
            attach(&session_id, "pop-tty-ended", channel).unwrap();
            let (output, exit) = collect_until_exit(&rx);
            assert!(output.contains("bye:z"), "output: {output:?}");
            assert_eq!(exit, r#"{"type":"exit","exitCode":4,"error":null}"#);
            // Delivered once.
            assert!(attach(&session_id, MAIN, Channel::new(|_| Ok(()))).is_err());
        }
    }
}

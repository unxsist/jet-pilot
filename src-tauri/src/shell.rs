//! Pseudo terminal sessions for the Shell (`kubectl exec`) and local Terminal tabs.
//!
//! - every session runs the requested command line inside a pty on all
//!   platforms (the old Windows code ignored it and spawned a bare
//!   `powershell.exe`, issue #52)
//! - output is read by a blocking reader thread and streamed to the frontend
//!   over a Tauri channel (raw bytes, no busy polling); the process exit is
//!   reported on the same channel as a JSON message
//! - the pty master is kept alive for the lifetime of the session: dropping it
//!   on Windows closes the pseudo console while the child is still starting
//!   (STATUS_DLL_INIT_FAILED / 0xc0000142)
//! - errors are returned to the frontend instead of panicking
//! - sessions are killed when their tab closes and when the app exits
//! - local terminals get a temporary single-context kubeconfig (0600) via
//!   `KUBECONFIG`, removed again when the session ends

pub mod tty {
    use once_cell::sync::Lazy;
    use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
    use serde::Serialize;
    use std::collections::HashMap;
    use std::ffi::{OsStr, OsString};
    use std::io::{Read, Write};
    use std::path::{Path, PathBuf};
    use std::process::Command;
    use std::sync::{mpsc, Arc, Mutex};
    use std::thread;
    use std::time::Duration;
    use tauri::ipc::{Channel, InvokeResponseBody};
    use tracing::{info, warn};
    use uuid::Uuid;

    #[cfg(windows)]
    use std::os::windows::process::CommandExt;

    const DEFAULT_ROWS: u16 = 24;
    const DEFAULT_COLS: u16 = 80;
    const MAX_DIMENSION: u16 = 1000;
    const TEMP_KUBECONFIG_PREFIX: &str = "jet-pilot-terminal-";

    struct TtySession {
        /// Kept alive on purpose: dropping the master closes the pty (and on
        /// Windows the pseudo console, which kills the child).
        master: Box<dyn MasterPty + Send>,
        writer: Box<dyn Write + Send>,
        killer: Box<dyn ChildKiller + Send + Sync>,
        temp_files: Vec<PathBuf>,
    }

    static TTY_SESSIONS: Lazy<Mutex<HashMap<String, Arc<Mutex<TtySession>>>>> =
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

    fn lock_sessions() -> std::sync::MutexGuard<'static, HashMap<String, Arc<Mutex<TtySession>>>> {
        // A panic while holding the lock must not take every terminal down.
        TTY_SESSIONS.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn get_session(session_id: &str) -> Result<Arc<Mutex<TtySession>>, String> {
        lock_sessions()
            .get(session_id)
            .cloned()
            .ok_or_else(|| format!("Terminal session {} not found", session_id))
    }

    fn remove_session(session_id: &str) -> Option<Arc<Mutex<TtySession>>> {
        lock_sessions().remove(session_id)
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

    fn send_exit(
        channel: &Channel<InvokeResponseBody>,
        exit_code: Option<u32>,
        error: Option<String>,
    ) {
        let event = TtyEvent::Exit { exit_code, error };
        match serde_json::to_string(&event) {
            Ok(json) => {
                let _ = channel.send(InvokeResponseBody::Json(json));
            }
            Err(e) => warn!("Failed to serialize terminal exit event: {}", e),
        }
    }

    /// Spawn `cmd` in a new pty and start streaming its output to `on_event`.
    /// `temp_files` are removed once the session ends (also on failure).
    fn spawn_session(
        cmd: CommandBuilder,
        size: PtySize,
        on_event: Channel<InvokeResponseBody>,
        temp_files: Vec<PathBuf>,
    ) -> Result<String, String> {
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

        let (master, mut child, killer, mut reader, writer) = match result {
            Ok(parts) => parts,
            Err(e) => {
                remove_temp_files(&temp_files);
                return Err(e);
            }
        };

        let session_id = Uuid::new_v4().to_string();
        info!("Started TTY session {} running {}", session_id, program);

        lock_sessions().insert(
            session_id.clone(),
            Arc::new(Mutex::new(TtySession {
                master,
                writer,
                killer,
                temp_files: temp_files.clone(),
            })),
        );

        let (reader_done_tx, reader_done_rx) = mpsc::channel::<()>();
        let data_channel = on_event.clone();
        let spawned_reader = thread::Builder::new()
            .name(format!("tty-reader-{}", session_id))
            .spawn(move || {
                let mut buf = [0u8; 16 * 1024];
                loop {
                    match reader.read(&mut buf) {
                        // EOF, or EIO on Linux once the child has exited.
                        Ok(0) => break,
                        Ok(n) => {
                            let _ = data_channel.send(InvokeResponseBody::Raw(buf[..n].to_vec()));
                        }
                        Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                        Err(_) => break,
                    }
                }
                let _ = reader_done_tx.send(());
            });

        if let Err(e) = spawned_reader {
            if let Some(session) = remove_session(&session_id) {
                let _ = session
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .killer
                    .kill();
            }
            remove_temp_files(&temp_files);
            return Err(format!("Failed to start the terminal reader: {}", e));
        }

        let waiter_session_id = session_id.clone();
        let spawned_waiter = thread::Builder::new()
            .name(format!("tty-waiter-{}", session_id))
            .spawn(move || {
                let status = child.wait();

                // Closing the master is what makes the reader see EOF on
                // Windows (ClosePseudoConsole); on unix it is a no-op for the
                // reader, which already got EOF/EIO.
                drop(remove_session(&waiter_session_id));
                // Give the reader a moment to flush the last output before
                // reporting the exit.
                let _ = reader_done_rx.recv_timeout(Duration::from_secs(2));
                remove_temp_files(&temp_files);

                match status {
                    Ok(status) => {
                        info!(
                            "TTY session {} exited with code {}",
                            waiter_session_id,
                            status.exit_code()
                        );
                        send_exit(&on_event, Some(status.exit_code()), None);
                    }
                    Err(e) => {
                        warn!(
                            "Failed to wait for TTY session {}: {}",
                            waiter_session_id, e
                        );
                        send_exit(&on_event, None, Some(e.to_string()));
                    }
                }
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
        init_command: Vec<String>,
        env: Option<HashMap<String, String>>,
        rows: Option<u16>,
        cols: Option<u16>,
        on_event: Channel<InvokeResponseBody>,
    ) -> Result<String, String> {
        info!("Creating TTY session");
        let cmd = build_command(init_command, env.unwrap_or_default())?;

        tauri::async_runtime::spawn_blocking(move || {
            spawn_session(cmd, pty_size(rows, cols), on_event, Vec::new())
        })
        .await
        .map_err(|e| e.to_string())?
    }

    /// Open the user's local shell with `KUBECONFIG` pointing to a temporary
    /// copy of `context` (and `namespace`, when set) from `kube_config`. The
    /// user's own kubeconfig is never modified.
    #[tauri::command]
    pub async fn create_local_terminal_session(
        kube_config: String,
        context: String,
        namespace: Option<String>,
        rows: Option<u16>,
        cols: Option<u16>,
        on_event: Channel<InvokeResponseBody>,
    ) -> Result<String, String> {
        info!("Creating local terminal session for context {}", context);

        tauri::async_runtime::spawn_blocking(move || {
            let temp_kubeconfig = write_temp_kubeconfig(
                &std::env::temp_dir(),
                &kube_config,
                &context,
                normalize_namespace(namespace).as_deref(),
            )?;

            let mut env = HashMap::new();
            env.insert(
                "KUBECONFIG".to_string(),
                temp_kubeconfig.to_string_lossy().into_owned(),
            );

            let argv = local_shell_argv(
                std::env::var_os("SHELL").as_deref(),
                std::env::var_os("PATH").as_deref(),
            );

            let cmd = match build_command(argv, env) {
                Ok(cmd) => cmd,
                Err(e) => {
                    remove_temp_files(&[temp_kubeconfig]);
                    return Err(e);
                }
            };

            spawn_session(cmd, pty_size(rows, cols), on_event, vec![temp_kubeconfig])
        })
        .await
        .map_err(|e| e.to_string())?
    }

    #[tauri::command]
    pub fn stop_tty_session(session_id: String) -> Result<(), String> {
        info!("Stopping TTY session: {}", session_id);

        // Already gone when the process exited by itself.
        let Some(session) = remove_session(&session_id) else {
            return Ok(());
        };

        let mut session = session.lock().unwrap_or_else(|e| e.into_inner());
        session
            .killer
            .kill()
            .map_err(|e| format!("Failed to stop the terminal process: {}", e))
    }

    // Deliberately synchronous: sync commands run in order, so keystrokes
    // cannot be reordered. Never log the data, it may contain passwords.
    #[tauri::command]
    pub fn write_to_pty(session_id: String, data: String) -> Result<(), String> {
        let session = get_session(&session_id)?;
        let mut session = session.lock().unwrap_or_else(|e| e.into_inner());

        session
            .writer
            .write_all(data.as_bytes())
            .and_then(|_| session.writer.flush())
            .map_err(|e| format!("Failed to write to the terminal: {}", e))
    }

    #[tauri::command]
    pub fn resize_pty(session_id: String, rows: u16, cols: u16) -> Result<(), String> {
        if rows == 0 || cols == 0 {
            return Ok(());
        }

        let session = get_session(&session_id)?;
        let session = session.lock().unwrap_or_else(|e| e.into_inner());

        session
            .master
            .resize(pty_size(Some(rows), Some(cols)))
            .map_err(|e| format!("Failed to resize the terminal: {}", e))
    }

    /// Kill every running session and remove their temporary kubeconfigs.
    /// Called on app exit so no `kubectl exec` / shell processes are orphaned.
    pub fn kill_all_tty_sessions() {
        let sessions: Vec<_> = lock_sessions().drain().collect();

        for (session_id, session) in sessions {
            info!("Killing TTY session {} on exit", session_id);
            let mut session = session.lock().unwrap_or_else(|e| e.into_inner());
            let _ = session.killer.kill();
            remove_temp_files(&session.temp_files);
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
        dir.join(format!("{}{}.yaml", TEMP_KUBECONFIG_PREFIX, Uuid::new_v4()))
    }

    /// `kubectl config view --minify --flatten` of a single context, written to
    /// a private temp file, optionally with the namespace set on the context.
    fn write_temp_kubeconfig(
        dir: &Path,
        kube_config: &str,
        context: &str,
        namespace: Option<&str>,
    ) -> Result<PathBuf, String> {
        if context.is_empty() {
            return Err("No context selected".to_string());
        }

        let contents = run_kubectl(&minify_kubeconfig_args(kube_config, context))?;
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

    /// The user's shell: `$SHELL` (fallback `/bin/sh`) on unix, PowerShell 7
    /// (`pwsh.exe`) when installed or Windows PowerShell on Windows.
    #[cfg(not(windows))]
    pub(crate) fn local_shell_argv(shell: Option<&OsStr>, _path: Option<&OsStr>) -> Vec<String> {
        let shell = shell
            .map(|s| s.to_string_lossy().trim().to_string())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "/bin/sh".to_string());

        vec![shell]
    }

    #[cfg(windows)]
    pub(crate) fn local_shell_argv(_shell: Option<&OsStr>, path: Option<&OsStr>) -> Vec<String> {
        let shell = path
            .and_then(|path| find_in_path("pwsh.exe", path))
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_else(|| "powershell.exe".to_string());

        vec![shell, "-NoLogo".to_string()]
    }

    #[cfg(test)]
    mod tests {
        use super::*;

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
                channel,
                vec![temp_file.clone()],
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
            let session_id = spawn_session(cmd, pty_size(None, None), channel, Vec::new()).unwrap();

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

            let result = spawn_session(cmd, pty_size(None, None), channel, vec![temp_file.clone()]);
            assert!(result.is_err());
            assert!(!temp_file.exists());
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
    }
}

pub mod tty {
    use tauri::Manager;
    use portable_pty::{native_pty_system, CommandBuilder, PtySize};
    use std::collections::HashMap;
    use std::ffi::OsString;
    use std::{
        io::{BufRead, BufReader, Write},
        sync::{Arc, Mutex},
        thread::{self, sleep},
        time::Duration,
    };
    use uuid::Uuid;

    struct TerminalSession {
        writer: Arc<Mutex<Box<dyn Write + Send>>>,
    }

    static TTY_SESSIONS: Mutex<Option<HashMap<String, TerminalSession>>> = Mutex::new(None);

    #[tauri::command]
    pub fn create_tty_session(app_handle: tauri::AppHandle, init_command: Vec<String>) -> String {
        if TTY_SESSIONS.lock().unwrap().is_none() {
            *TTY_SESSIONS.lock().unwrap() = Some(HashMap::new());
        }

        let pty_system = native_pty_system();
        let pty_pair = pty_system
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .unwrap();

        // generate a random session id
        let session_id = Uuid::new_v4().to_string();
        let thread_session_id = session_id.clone();

        #[cfg(target_os = "windows")]
        let cmd = CommandBuilder::new("powershell.exe");
        #[cfg(not(target_os = "windows"))]
        let cmd = CommandBuilder::from_argv(
            init_command
                .into_iter()
                .map(|s| OsString::from(s))
                .collect(),
        );

        let mut child = pty_pair.slave.spawn_command(cmd).unwrap();
        thread::spawn(move || {
            child.wait().unwrap();
        });

        let reader = pty_pair.master.try_clone_reader().unwrap();
        let reader = Arc::new(Mutex::new(Some(BufReader::new(reader))));

        thread::spawn(move || {
            let reader = reader.lock().unwrap().take();
            let app = app_handle.clone();
            let session_id = thread_session_id.clone();
            if let Some(mut reader) = reader {
                loop {
                    sleep(Duration::from_millis(1));
                    let data = reader.fill_buf().unwrap().to_vec();
                    reader.consume(data.len());
                    if data.len() > 0 {
                        app.emit_all(format!("tty_data_{}", session_id).as_ref(), data)
                            .unwrap();
                    }
                }
            }
        });

        let writer = pty_pair.master.take_writer().unwrap();
        TTY_SESSIONS.lock().unwrap().as_mut().unwrap().insert(
            session_id.clone(),
            TerminalSession {
                writer: Arc::new(Mutex::new(writer)),
            },
        );

        return session_id;
    }

    #[tauri::command]
    pub fn stop_tty_session(session_id: &str) {
        // write to pty to kill the process, this can be a bash or powershell command
        write_to_pty(session_id, "exit\n");
    }

    #[tauri::command]
    pub fn write_to_pty(session_id: &str, data: &str) {
        // First, lock the sessions map
        let sessions_lock = TTY_SESSIONS.lock().unwrap();

        // Then, try to get the session from the map
        if let Some(sessions) = sessions_lock.as_ref() {
            if let Some(session) = sessions.get(session_id) {
                // Lock the writer
                let mut writer_guard = session.writer.lock().unwrap();
                // Attempt to write and handle any error
                if let Err(_) = write!(&mut *writer_guard, "{}", data) {
                    // Handle the error from the write! macro here
                }
            } else {
                // Handle the case when the session is not found
            }
        } else {
            // Handle the case when the TTY_SESSIONS map is not initialized
        }
    }
}
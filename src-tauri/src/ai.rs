//! Ask AI: the user's own AI agent CLIs (Claude Code, Codex, ...), started
//! in a terminal tab by `shell::tty::create_agent_terminal_session`. JET
//! Pilot only finds and starts them: it makes no network calls of its own
//! and stores no keys; each agent signs in to its own provider.

use std::path::{Path, PathBuf};

use tauri::Manager;
use tracing::warn;

const WORKSPACE_DIR: &str = "ask-ai";

/// Where each program resolves on `PATH` (imported from the login shell at
/// startup), in the order asked; `None` when it isn't installed. Programs
/// are names (`claude`) or paths (a custom command).
#[tauri::command]
pub async fn ai_find_agents(programs: Vec<String>) -> Vec<Option<String>> {
    tauri::async_runtime::spawn_blocking(move || {
        programs
            .iter()
            .map(|program| find_program(program))
            .collect()
    })
    .await
    .unwrap_or_default()
}

fn find_program(program: &str) -> Option<String> {
    let program = program.trim();
    if program.is_empty() {
        return None;
    }
    which::which(program)
        .ok()
        .map(|path| path.to_string_lossy().into_owned())
}

/// The agents' working directory, created when missing. None (the home
/// directory) when it can't be made.
pub fn agent_workspace(app: &tauri::AppHandle) -> Option<PathBuf> {
    let dir = app.path().app_data_dir().ok()?;
    ensure_workspace(&dir)
}

fn ensure_workspace(data_dir: &Path) -> Option<PathBuf> {
    let dir = data_dir.join(WORKSPACE_DIR);
    match std::fs::create_dir_all(&dir) {
        Ok(()) => Some(dir),
        Err(e) => {
            warn!("Failed to create the Ask AI workspace {}: {}", dir.display(), e);
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_programs_on_path_and_by_path() {
        #[cfg(unix)]
        {
            assert!(find_program("sh").is_some());
            assert_eq!(find_program("/bin/sh").as_deref(), Some("/bin/sh"));
        }
        assert_eq!(find_program("  "), None);
        assert_eq!(find_program("jet-pilot-no-such-agent-cli"), None);
    }

    #[test]
    fn workspace_is_created_once() {
        let dir = tempfile::tempdir().unwrap();
        let workspace = ensure_workspace(dir.path()).unwrap();
        assert_eq!(workspace, dir.path().join(WORKSPACE_DIR));
        assert!(workspace.is_dir());
        assert_eq!(ensure_workspace(dir.path()), Some(workspace));

        // A file in the way: no workspace (the agent starts in the home directory).
        let blocked = dir.path().join("file");
        std::fs::write(&blocked, b"").unwrap();
        assert_eq!(ensure_workspace(&blocked), None);
    }
}

//! Helpers for the user folders below $APPCONFIG (themes, custom actions).
//! Reading, writing and watching their files goes through the fs plugin
//! from the frontend; only revealing a folder needs Rust, because the shell
//! plugin's `open` scope only admits http(s)/mailto/tel URLs.

use tauri::Manager;

/// Creates `$APPCONFIG/<name>` when missing, opens it in the system file
/// manager and returns its absolute path.
fn open_config_folder(app: &tauri::AppHandle, name: &str) -> Result<String, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("Failed to resolve the config folder: {e}"))?
        .join(name);
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("Failed to create {}: {e}", dir.display()))?;
    open::that_detached(&dir).map_err(|e| format!("Failed to open {}: {e}", dir.display()))?;
    Ok(dir.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn open_themes_folder(app: tauri::AppHandle) -> Result<String, String> {
    open_config_folder(&app, "themes")
}

/// The custom actions folder (Settings › Actions).
#[tauri::command]
pub fn open_actions_folder(app: tauri::AppHandle) -> Result<String, String> {
    open_config_folder(&app, "actions")
}

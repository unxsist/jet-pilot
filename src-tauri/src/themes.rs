//! Helpers for the user themes folder ($APPCONFIG/themes). Reading, writing
//! and watching the theme files goes through the fs plugin from the
//! frontend; only revealing the folder needs Rust, because the shell
//! plugin's `open` scope only admits http(s)/mailto/tel URLs.

use tauri::Manager;

/// Creates `$APPCONFIG/themes` when missing, opens it in the system file
/// manager and returns its absolute path.
#[tauri::command]
pub fn open_themes_folder(app: tauri::AppHandle) -> Result<String, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("Failed to resolve the config folder: {e}"))?
        .join("themes");
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("Failed to create {}: {e}", dir.display()))?;
    open::that_detached(&dir).map_err(|e| format!("Failed to open {}: {e}", dir.display()))?;
    Ok(dir.to_string_lossy().into_owned())
}

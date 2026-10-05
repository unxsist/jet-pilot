fn main() {
    tauri_build::build();
    app_version_env();
}

/// `JET_PILOT_VERSION` = the app version from ../package.json (Cargo's own
/// package version is a placeholder). The jetpilot-auth helper reports it
/// and the installer never replaces a newer helper with an older one.
fn app_version_env() {
    println!("cargo:rerun-if-changed=../package.json");
    let version = std::fs::read_to_string("../package.json")
        .ok()
        .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
        .and_then(|json| json.get("version")?.as_str().map(str::to_string))
        .unwrap_or_else(|| std::env::var("CARGO_PKG_VERSION").unwrap_or_default());
    println!("cargo:rustc-env=JET_PILOT_VERSION={version}");
}

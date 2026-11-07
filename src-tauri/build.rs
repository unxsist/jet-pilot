fn main() {
    tauri_build::build();
    app_version_env();
    windows_stack_reserve();
}

/// An 8 MB main-thread stack on Windows, like macOS and Linux (the MSVC
/// default is 1 MB). Tauri builds async command futures on the main thread,
/// so a large one overflowed it at launch (issue #132).
fn windows_stack_reserve() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("windows") {
        return;
    }
    let arg = if std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc") {
        "/STACK:8388608"
    } else {
        "-Wl,--stack,8388608"
    };
    println!("cargo:rustc-link-arg-bin=jet_pilot={arg}");
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

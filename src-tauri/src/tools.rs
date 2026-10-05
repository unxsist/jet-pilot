//! External CLI tools JET Pilot relies on (kubectl, helm, cloud CLIs and
//! credential plugins): detection on `PATH`, and managed installs of
//! kubectl, helm and Azure kubelogin for users who don't have them.
//!
//! Detection resolves each tool on the process `PATH` (imported from the
//! login shell, managed `bin/` last, see env_import.rs) and runs its version
//! command with a timeout, all tools in parallel. Results are cached for five
//! minutes.
//!
//! Managed installs download a pinned (or requested) version from the
//! official origin only (dl.k8s.io / get.helm.sh / the Azure/kubelogin
//! GitHub releases, redirects pinned to those hosts), verify it against a
//! SHA-256 embedded here for pinned kubelogin releases, else the
//! `.sha256` / `.sha256sum` file published next to the artifact, unpack it
//! into `tools/<tool>/<version>/` and activate it by hard-linking (or
//! copying) into `bin/` through a temp name and a rename. Progress is
//! streamed as [`DownloadEvent`]s.

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use once_cell::sync::Lazy;
use serde::Serialize;
use serde_json::Value;
use tauri::ipc::Channel;
use tokio::sync::Mutex as AsyncMutex;
use tracing::{info, warn};

use crate::net;
use crate::paths;
use crate::process::{self, ProcessError};

/// Versions installed when the frontend doesn't ask for one. Release prep
/// bumps these. The checksum is fetched from the official origin at install
/// time; per-platform digests embedded at release prep can replace that.
const PINNED_VERSIONS: &[(&str, &str)] = &[
    ("kubectl", "v1.34.1"),
    ("helm", "v3.19.0"),
    ("kubelogin", KUBELOGIN_VERSION),
];

/// Azure kubelogin (AKS clusters in `azurecli` mode).
pub const KUBELOGIN_VERSION: &str = "v0.2.20";

/// SHA-256 of the pinned kubelogin release archives per (os, arch), as
/// published next to them (`kubelogin-<os>-<arch>.zip.sha256`). Bump with
/// `KUBELOGIN_VERSION`.
const KUBELOGIN_SHA256: &[(&str, &str, &str)] = &[
    (
        "darwin",
        "amd64",
        "533f2f159d40b81d890efbddb902ab49a04431669c89b1027dc0b0f0eaaf6729",
    ),
    (
        "darwin",
        "arm64",
        "1583a65ed6833145a9427f7920ae8cfb7b86244b1b3e8c6b4a0f016101d1634d",
    ),
    (
        "linux",
        "amd64",
        "2e92450a929dd2aec4da818b40dd4fda97aaeae2d6cd9c1074cc1371210f4ab9",
    ),
    (
        "linux",
        "arm64",
        "d02712fcf3ed290cc3921205e535673b12fef0936da1c0b762afaa4d685a33c4",
    ),
    (
        "windows",
        "amd64",
        "e26d5ce8a48e9b6ac53fd93cf45a1eec050f859ccca3654beb4887decd8dee33",
    ),
    (
        "windows",
        "arm64",
        "8155504e917636635d431f553cbb108bd3d7399e1ad255eacf0f4590ce222201",
    ),
];

/// gcloud and az are Python programs and can be slow to start.
const VERSION_TIMEOUT: Duration = Duration::from_secs(8);
/// The first run of a fresh binary can be slow (macOS scans it).
const INSTALL_CHECK_TIMEOUT: Duration = Duration::from_secs(30);
const CACHE_TTL: Duration = Duration::from_secs(5 * 60);

const DOWNLOAD_HOSTS: &[&str] = &[
    "dl.k8s.io",
    "cdn.dl.k8s.io",
    "get.helm.sh",
    // GitHub release downloads redirect to its asset storage.
    "github.com",
    "objects.githubusercontent.com",
    "release-assets.githubusercontent.com",
];
const MAX_DOWNLOAD_BYTES: u64 = 200 * 1024 * 1024;
const MAX_CHECKSUM_BYTES: usize = 4 * 1024;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(30);
/// Stalls only; a slow but moving download is fine.
const READ_TIMEOUT: Duration = Duration::from_secs(60);
const PROGRESS_INTERVAL: Duration = Duration::from_millis(100);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ToolSource {
    /// Found on the user's `PATH`.
    Path,
    /// Found in JET Pilot's managed `bin/`.
    Managed,
    Missing,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolStatus {
    pub id: String,
    pub name: String,
    pub found: bool,
    pub path: Option<String>,
    pub version: Option<String>,
    pub source: ToolSource,
    /// JET Pilot can install this tool on this platform.
    pub installable: bool,
    /// The version `tools_install` installs by default.
    pub install_version: Option<String>,
    /// Why the tool was found but doesn't work (version check failed).
    pub problem: Option<String>,
}

/// Streamed on the `tools_install` channel.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum DownloadEvent {
    Started {
        url: String,
        version: String,
    },
    Progress {
        received: u64,
        total: Option<u64>,
    },
    /// Downloaded and checksum-verified; unpacking and checking it runs.
    Verifying,
    Done {
        path: String,
    },
    Failed {
        message: String,
    },
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum Installer {
    Kubectl,
    Helm,
    Kubelogin,
}

struct Tool {
    id: &'static str,
    name: &'static str,
    /// Executable looked up on `PATH` (`which` adds PATHEXT on Windows).
    binary: &'static str,
    version_args: &'static [&'static str],
    parse_version: fn(&str) -> Option<String>,
    installer: Option<Installer>,
}

const TOOLS: &[Tool] = &[
    Tool {
        id: "kubectl",
        name: "kubectl",
        binary: "kubectl",
        version_args: &["version", "--client", "-o", "json"],
        parse_version: parse_kubectl_version,
        installer: Some(Installer::Kubectl),
    },
    Tool {
        id: "helm",
        name: "Helm",
        binary: "helm",
        version_args: &["version", "--template", "{{.Version}}"],
        parse_version: first_version,
        installer: Some(Installer::Helm),
    },
    Tool {
        id: "aws",
        name: "AWS CLI",
        binary: "aws",
        version_args: &["--version"],
        parse_version: first_version,
        installer: None,
    },
    Tool {
        id: "gcloud",
        name: "Google Cloud CLI",
        binary: "gcloud",
        version_args: &["version", "--format=json"],
        parse_version: parse_gcloud_version,
        installer: None,
    },
    Tool {
        id: "az",
        name: "Azure CLI",
        binary: "az",
        version_args: &["version", "-o", "json"],
        parse_version: parse_az_version,
        installer: None,
    },
    Tool {
        id: "kubelogin",
        name: "kubelogin",
        binary: "kubelogin",
        version_args: &["--version"],
        parse_version: first_version,
        installer: Some(Installer::Kubelogin),
    },
    Tool {
        id: "gke-gcloud-auth-plugin",
        name: "GKE auth plugin",
        binary: "gke-gcloud-auth-plugin",
        version_args: &["--version"],
        parse_version: first_version,
        installer: None,
    },
    Tool {
        id: "doctl",
        name: "doctl",
        binary: "doctl",
        version_args: &["version"],
        parse_version: parse_doctl_version,
        installer: None,
    },
];

fn find_tool(id: &str) -> Result<&'static Tool, String> {
    TOOLS
        .iter()
        .find(|tool| tool.id == id)
        .ok_or_else(|| format!("Unknown tool \"{id}\"."))
}

fn pinned_version(tool: &Tool) -> Option<&'static str> {
    PINNED_VERSIONS
        .iter()
        .find(|(id, _)| *id == tool.id)
        .map(|(_, version)| *version)
}

/// The executable's file name (`kubectl.exe` on Windows).
fn binary_file_name(tool: &Tool) -> String {
    format!("{}{}", tool.binary, std::env::consts::EXE_SUFFIX)
}

/* --------------------------------------------------------------- detection */

struct Cache {
    at: Instant,
    tools: Vec<ToolStatus>,
}

/// Held while detecting, so concurrent callers share one run.
static CACHE: Lazy<AsyncMutex<Option<Cache>>> = Lazy::new(|| AsyncMutex::new(None));
/// Installs and uninstalls run one at a time.
static INSTALL_LOCK: Lazy<AsyncMutex<()>> = Lazy::new(|| AsyncMutex::new(()));

/// Detects every known tool (cached for five minutes unless `force`).
#[tauri::command]
pub async fn tools_detect(force: Option<bool>) -> Result<Vec<ToolStatus>, String> {
    let mut cache = CACHE.lock().await;
    if !force.unwrap_or(false) {
        if let Some(cached) = cache.as_ref().filter(|c| c.at.elapsed() < CACHE_TTL) {
            return Ok(cached.tools.clone());
        }
    }
    let started = Instant::now();
    let bin_dir = paths::managed_bin_dir();
    let tools =
        futures::future::join_all(TOOLS.iter().map(|tool| detect_tool(tool, &bin_dir))).await;
    info!(
        "Detected tools in {} ms: {}",
        started.elapsed().as_millis(),
        tools
            .iter()
            .map(|t| format!(
                "{}={}",
                t.id,
                t.version
                    .as_deref()
                    .unwrap_or(if t.found { "?" } else { "-" })
            ))
            .collect::<Vec<_>>()
            .join(" ")
    );
    *cache = Some(Cache {
        at: Instant::now(),
        tools: tools.clone(),
    });
    Ok(tools)
}

async fn invalidate_cache() {
    *CACHE.lock().await = None;
}

async fn detect_tool(tool: &Tool, bin_dir: &Path) -> ToolStatus {
    let resolved = which::which(tool.binary).ok();
    status_for(tool, resolved, bin_dir, VERSION_TIMEOUT).await
}

async fn status_for(
    tool: &Tool,
    resolved: Option<PathBuf>,
    bin_dir: &Path,
    timeout: Duration,
) -> ToolStatus {
    let installable = tool.installer.is_some() && Platform::current().is_some();
    let mut status = ToolStatus {
        id: tool.id.to_string(),
        name: tool.name.to_string(),
        found: false,
        path: None,
        version: None,
        source: ToolSource::Missing,
        installable,
        install_version: pinned_version(tool)
            .filter(|_| installable)
            .map(str::to_string),
        problem: None,
    };
    let Some(path) = resolved else {
        return status;
    };
    status.found = true;
    status.source = if is_managed_path(&path, bin_dir) {
        ToolSource::Managed
    } else {
        ToolSource::Path
    };
    match run_version(tool, &path, timeout).await {
        Ok(version) => status.version = version,
        Err(problem) => status.problem = Some(problem),
    }
    status.path = Some(path.to_string_lossy().into_owned());
    status
}

/// Runs the tool's version command. Ok(None): it ran but printed no version
/// we recognise.
async fn run_version(
    tool: &Tool,
    path: &Path,
    timeout: Duration,
) -> Result<Option<String>, String> {
    let mut cmd = process::command(path);
    cmd.args(tool.version_args);
    let shown = format!("{} {}", tool.binary, tool.version_args.join(" "));
    let output = process::run_with_timeout(cmd, timeout)
        .await
        .map_err(|e| match e {
            ProcessError::Timeout => format!(
                "`{shown}` did not answer within {} seconds.",
                timeout.as_secs()
            ),
            ProcessError::NotFound => format!("{} could not be started.", tool.binary),
            ProcessError::Io(e) => format!("{} could not be started: {e}", tool.binary),
        })?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    let version = (tool.parse_version)(&stdout).or_else(|| (tool.parse_version)(&stderr));
    if !output.status.success() && version.is_none() {
        let detail = stderr
            .lines()
            .chain(stdout.lines())
            .map(str::trim)
            .find(|l| !l.is_empty())
            .map(|l| format!(": {}", l.chars().take(200).collect::<String>()))
            .unwrap_or_default();
        return Err(format!("`{shown}` failed ({}){detail}", output.status));
    }
    Ok(version)
}

/// Whether `path` lives directly in the managed `bin/` (also through a
/// symlinked / differently spelled directory).
fn is_managed_path(path: &Path, bin_dir: &Path) -> bool {
    if path.parent() == Some(bin_dir) {
        return true;
    }
    match (
        path.parent().and_then(|p| p.canonicalize().ok()),
        bin_dir.canonicalize().ok(),
    ) {
        (Some(parent), Some(bin)) => parent == bin,
        _ => false,
    }
}

/* --------------------------------------------------------- version parsers */

/// A clean version from one token: `v1.31.2`, `2.17.0`, `v1.30.2-eks-1552ad0`.
/// Needs at least major.minor; build metadata (`+abc`) is dropped.
fn version_token(raw: &str) -> Option<String> {
    let token = raw.trim_matches(|c: char| matches!(c, '"' | '\'' | ',' | ';' | ':' | '(' | ')'));
    let (prefix, rest) = match token.strip_prefix('v') {
        Some(rest) => ("v", rest),
        None => ("", token),
    };
    let core_len = rest
        .find(|c: char| !(c.is_ascii_digit() || c == '.'))
        .unwrap_or(rest.len());
    let core = rest[..core_len].trim_end_matches('.');
    let parts: Vec<&str> = core.split('.').collect();
    if parts.len() < 2 || parts.iter().any(|p| p.is_empty()) {
        return None;
    }
    let mut version = format!("{prefix}{core}");
    if let Some(pre) = rest[core.len()..].strip_prefix('-') {
        let pre: String = pre
            .chars()
            .take_while(|c| c.is_ascii_alphanumeric() || *c == '.' || *c == '-')
            .collect();
        let pre = pre.trim_end_matches(['.', '-']);
        if !pre.is_empty() {
            version.push('-');
            version.push_str(pre);
        }
    }
    Some(version)
}

/// The first version-looking token (`aws-cli/2.17.0 Python/3.11.9 ...`,
/// `kubelogin version v1.28.1`, `git hash: v0.1.4/d7f1c16`, `Kubernetes
/// v1.30.0+3f4b1d9`, helm's `v3.19.0`).
fn first_version(text: &str) -> Option<String> {
    text.split(|c: char| c.is_whitespace() || c == '/' || c == '=')
        .find_map(version_token)
}

/// The first JSON object in `text` (tools may print warnings around it).
fn first_json(text: &str) -> Option<Value> {
    let start = text.find('{')?;
    serde_json::Deserializer::from_str(&text[start..])
        .into_iter::<Value>()
        .next()?
        .ok()
}

fn json_version(text: &str, pointer: &str) -> Option<String> {
    first_json(text)?
        .pointer(pointer)?
        .as_str()
        .and_then(version_token)
}

/// `kubectl version --client -o json`, or the text form.
fn parse_kubectl_version(text: &str) -> Option<String> {
    json_version(text, "/clientVersion/gitVersion").or_else(|| {
        text.lines()
            .find_map(|l| l.trim().strip_prefix("Client Version:"))
            .and_then(first_version)
    })
}

/// `gcloud version --format=json`: `{"Google Cloud SDK": "490.0.0", ...}`.
fn parse_gcloud_version(text: &str) -> Option<String> {
    json_version(text, "/Google Cloud SDK").or_else(|| {
        text.lines()
            .find_map(|l| l.trim().strip_prefix("Google Cloud SDK"))
            .and_then(first_version)
    })
}

/// `az version -o json`: `{"azure-cli": "2.64.0", ...}`.
fn parse_az_version(text: &str) -> Option<String> {
    json_version(text, "/azure-cli").or_else(|| {
        text.lines()
            .find_map(|l| l.trim().strip_prefix("azure-cli"))
            .and_then(first_version)
    })
}

/// `doctl version`: `doctl version 1.110.0-release`.
fn parse_doctl_version(text: &str) -> Option<String> {
    first_version(text).map(|v| v.trim_end_matches("-release").to_string())
}

/* ----------------------------------------------------------------- install */

#[derive(Debug, Clone, Copy, PartialEq)]
struct Platform {
    /// `darwin` | `linux` | `windows` (Go naming, as in the download URLs).
    os: &'static str,
    /// `amd64` | `arm64`.
    arch: &'static str,
}

impl Platform {
    fn current() -> Option<Platform> {
        Platform::from_rust(std::env::consts::OS, std::env::consts::ARCH)
    }

    fn from_rust(os: &str, arch: &str) -> Option<Platform> {
        let os = match os {
            "macos" => "darwin",
            "linux" => "linux",
            "windows" => "windows",
            _ => return None,
        };
        let arch = match arch {
            "x86_64" => "amd64",
            "aarch64" => "arm64",
            _ => return None,
        };
        Some(Platform { os, arch })
    }

    fn exe_suffix(&self) -> &'static str {
        if self.os == "windows" {
            ".exe"
        } else {
            ""
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum ArchiveKind {
    TarGz,
    Zip,
}

#[derive(Debug, Clone, PartialEq)]
struct InstallPlan {
    url: String,
    checksum_url: String,
    /// The downloaded file's name (also its name in the checksum file).
    artifact: String,
    /// The executable's file name.
    binary: String,
    /// Archive and the member holding the binary, for archived releases.
    archive: Option<(ArchiveKind, String)>,
    /// The artifact's SHA-256 when it is pinned here (else fetched from
    /// `checksum_url`).
    sha256: Option<&'static str>,
}

fn install_plan(installer: Installer, version: &str, platform: Platform) -> InstallPlan {
    let Platform { os, arch } = platform;
    match installer {
        Installer::Kubectl => {
            let binary = format!("kubectl{}", platform.exe_suffix());
            let url = format!("https://dl.k8s.io/release/{version}/bin/{os}/{arch}/{binary}");
            InstallPlan {
                checksum_url: format!("{url}.sha256"),
                url,
                artifact: binary.clone(),
                binary,
                archive: None,
                sha256: None,
            }
        }
        Installer::Helm => {
            let binary = format!("helm{}", platform.exe_suffix());
            let (kind, ext) = if os == "windows" {
                (ArchiveKind::Zip, "zip")
            } else {
                (ArchiveKind::TarGz, "tar.gz")
            };
            let artifact = format!("helm-{version}-{os}-{arch}.{ext}");
            let url = format!("https://get.helm.sh/{artifact}");
            InstallPlan {
                checksum_url: format!("{url}.sha256sum"),
                url,
                archive: Some((kind, format!("{os}-{arch}/{binary}"))),
                artifact,
                binary,
                sha256: None,
            }
        }
        Installer::Kubelogin => {
            let binary = format!("kubelogin{}", platform.exe_suffix());
            // Release assets say `win`, the paths inside say `windows`.
            let asset_os = if os == "windows" { "win" } else { os };
            let artifact = format!("kubelogin-{asset_os}-{arch}.zip");
            let url = format!(
                "https://github.com/Azure/kubelogin/releases/download/{version}/{artifact}"
            );
            let sha256 = (version == KUBELOGIN_VERSION)
                .then(|| {
                    KUBELOGIN_SHA256
                        .iter()
                        .find(|(o, a, _)| *o == os && *a == arch)
                        .map(|(_, _, sha)| *sha)
                })
                .flatten();
            InstallPlan {
                checksum_url: format!("{url}.sha256"),
                url,
                archive: Some((ArchiveKind::Zip, format!("bin/{os}_{arch}/{binary}"))),
                artifact,
                binary,
                sha256,
            }
        }
    }
}

/// `v1.34.1` / `1.34.1` / `v4.0.0-rc.1` → `v…`; anything that isn't a
/// plain release version (and so a safe URL and path segment) is refused.
fn normalize_version(version: &str) -> Option<String> {
    let version = version.trim();
    let version = if version.starts_with(|c: char| c.is_ascii_digit()) {
        format!("v{version}")
    } else {
        version.to_string()
    };
    let valid = version.len() <= 64
        && version.starts_with('v')
        && version[1..].starts_with(|c: char| c.is_ascii_digit())
        && version
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-')
        && version_token(&version).is_some();
    valid.then_some(version)
}

/// Rate limit for progress events.
struct Throttle {
    last: Option<Instant>,
}

impl Throttle {
    fn ready(&mut self, now: Instant, finished: bool) -> bool {
        let due = self
            .last
            .is_none_or(|last| now.duration_since(last) >= PROGRESS_INTERVAL);
        if due || finished {
            self.last = Some(now);
        }
        due || finished
    }
}

/// Installs `tool` (kubectl, helm or kubelogin) into the managed
/// directories and returns its fresh status. `version` defaults to the
/// pinned one.
#[tauri::command]
pub async fn tools_install(
    app: tauri::AppHandle,
    tool: String,
    version: Option<String>,
    on_event: Channel<DownloadEvent>,
) -> Result<ToolStatus, String> {
    let emit = |event: DownloadEvent| {
        let _ = on_event.send(event);
    };
    match install(&net::user_agent(&app), &tool, version.as_deref(), &emit).await {
        Ok(status) => Ok(status),
        Err(message) => {
            warn!("Installing {} failed: {}", tool, message);
            emit(DownloadEvent::Failed {
                message: message.clone(),
            });
            Err(message)
        }
    }
}

async fn install(
    user_agent: &str,
    id: &str,
    version: Option<&str>,
    emit: &(dyn Fn(DownloadEvent) + Send + Sync),
) -> Result<ToolStatus, String> {
    let tool = find_tool(id)?;
    let installer = tool
        .installer
        .ok_or_else(|| format!("JET Pilot can't install {}.", tool.name))?;
    let platform = Platform::current()
        .ok_or_else(|| format!("JET Pilot can't install {} on this platform.", tool.name))?;
    let version = match version.filter(|v| !v.trim().is_empty()) {
        Some(v) => normalize_version(v).ok_or_else(|| format!("Invalid version \"{v}\"."))?,
        None => pinned_version(tool)
            .ok_or_else(|| format!("No default version for {}.", tool.name))?
            .to_string(),
    };
    let plan = install_plan(installer, &version, platform);

    let _guard = INSTALL_LOCK.lock().await;
    let client = net::https_client_builder(user_agent, DOWNLOAD_HOSTS)
        .connect_timeout(CONNECT_TIMEOUT)
        .read_timeout(READ_TIMEOUT)
        .build()
        .map_err(|e| format!("Failed to create the HTTP client: {e}"))?;

    let expected = match plan.sha256 {
        Some(pinned) => pinned.to_string(),
        None => {
            let checksums = net::get_capped(&client, &plan.checksum_url, MAX_CHECKSUM_BYTES)
                .await
                .map_err(|e| match e {
                    net::NetError::Status(404) => {
                        format!(
                            "{} {version} is not available for {}/{}.",
                            tool.name, platform.os, platform.arch
                        )
                    }
                    e => format!("Fetching the {} checksum failed: {e}", tool.name),
                })?;
            net::parse_sha256_file(&String::from_utf8_lossy(&checksums), &plan.artifact)
                .ok_or_else(|| format!("The published {} checksum could not be read.", tool.name))?
        }
    };

    let tool_dir = paths::managed_tools_dir().join(tool.id);
    let version_dir = tool_dir.join(&version);
    paths::ensure_private_dir(&version_dir)
        .map_err(|e| format!("Unable to create {}: {e}", version_dir.display()))?;

    info!("Installing {} {} from {}", tool.id, version, plan.url);
    emit(DownloadEvent::Started {
        url: plan.url.clone(),
        version: version.clone(),
    });
    let result = download_and_unpack(&client, &plan, &version_dir, &expected, tool, emit).await;
    let binary = match result {
        Ok(binary) => binary,
        Err(e) => {
            // Leave no half-installed version behind.
            let _ = std::fs::remove_dir_all(&version_dir);
            return Err(e);
        }
    };

    let bin_dir = paths::managed_bin_dir();
    let activated = {
        let (binary, bin_dir, name) = (binary.clone(), bin_dir.clone(), plan.binary.clone());
        tauri::async_runtime::spawn_blocking(move || activate(&binary, &bin_dir, &name))
            .await
            .map_err(|e| e.to_string())?
            .map_err(|e| format!("Unable to activate {}: {e}", tool.name))?
    };
    prune_versions(&tool_dir, &version);

    emit(DownloadEvent::Done {
        path: activated.to_string_lossy().into_owned(),
    });
    info!(
        "Installed {} {} into {}",
        tool.id,
        version,
        activated.display()
    );

    invalidate_cache().await;
    Ok(detect_tool(tool, &bin_dir).await)
}

/// Downloads and verifies the artifact, unpacks the binary and checks that
/// it runs. Returns the binary's path in `version_dir`.
async fn download_and_unpack(
    client: &tauri_plugin_http::reqwest::Client,
    plan: &InstallPlan,
    version_dir: &Path,
    expected_sha256: &str,
    tool: &Tool,
    emit: &(dyn Fn(DownloadEvent) + Send + Sync),
) -> Result<PathBuf, String> {
    let artifact = version_dir.join(&plan.artifact);
    let mut throttle = Throttle { last: None };
    net::download_verified(
        client,
        &plan.url,
        &artifact,
        MAX_DOWNLOAD_BYTES,
        Some(expected_sha256),
        |received, total| {
            if throttle.ready(Instant::now(), total == Some(received)) {
                emit(DownloadEvent::Progress { received, total });
            }
        },
    )
    .await
    .map_err(|e| format!("Downloading {} failed: {e}", tool.name))?;
    emit(DownloadEvent::Verifying);

    let binary = version_dir.join(&plan.binary);
    if let Some((kind, member)) = plan.archive.clone() {
        let (archive, dest) = (artifact.clone(), binary.clone());
        tauri::async_runtime::spawn_blocking(move || {
            extract_member(&archive, kind, &member, &dest, MAX_DOWNLOAD_BYTES)
        })
        .await
        .map_err(|e| e.to_string())??;
        let _ = std::fs::remove_file(&artifact);
    }
    make_executable(&binary)
        .map_err(|e| format!("Unable to make {} executable: {e}", tool.name))?;

    run_version(tool, &binary, INSTALL_CHECK_TIMEOUT)
        .await
        .map_err(|e| format!("The downloaded {} does not run: {e}", tool.name))?;
    Ok(binary)
}

/// Removes a temp file unless disarmed.
struct TempPath(Option<PathBuf>);

impl Drop for TempPath {
    fn drop(&mut self) {
        if let Some(path) = self.0.take() {
            let _ = std::fs::remove_file(path);
        }
    }
}

fn temp_sibling(dest: &Path) -> PathBuf {
    let name = dest
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    dest.with_file_name(format!(".{name}.{}.part", uuid::Uuid::new_v4().simple()))
}

/// Writes archive member `member` to `dest` (at most `max_bytes`).
fn extract_member(
    archive: &Path,
    kind: ArchiveKind,
    member: &str,
    dest: &Path,
    max_bytes: u64,
) -> Result<(), String> {
    let file =
        std::fs::File::open(archive).map_err(|e| format!("Unable to open the archive: {e}"))?;
    let unreadable =
        |e: &dyn std::fmt::Display| format!("The downloaded archive is unreadable: {e}");
    match kind {
        ArchiveKind::TarGz => {
            let mut tar = tar::Archive::new(flate2::read::GzDecoder::new(file));
            for entry in tar.entries().map_err(|e| unreadable(&e))? {
                let mut entry = entry.map_err(|e| unreadable(&e))?;
                let path = entry.path().map_err(|e| unreadable(&e))?.into_owned();
                let path = path.strip_prefix(".").unwrap_or(&path);
                if entry.header().entry_type().is_file() && path == Path::new(member) {
                    return write_capped(&mut entry, dest, max_bytes);
                }
            }
        }
        ArchiveKind::Zip => {
            let mut zip = zip::ZipArchive::new(file).map_err(|e| unreadable(&e))?;
            let result = match zip.by_name(member) {
                Ok(entry) if entry.is_file() => Some(write_capped(entry, dest, max_bytes)),
                _ => None,
            };
            if let Some(result) = result {
                return result;
            }
        }
    }
    Err(format!("The downloaded archive does not contain {member}."))
}

/// Copies `reader` to `dest` through a temp file, failing past `max_bytes`.
fn write_capped(reader: impl std::io::Read, dest: &Path, max_bytes: u64) -> Result<(), String> {
    let mut temp = TempPath(Some(temp_sibling(dest)));
    let temp_path = temp.0.clone().unwrap_or_default();
    let mut out = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temp_path)
        .map_err(|e| format!("Unable to write {}: {e}", dest.display()))?;
    let copied = std::io::copy(&mut reader.take(max_bytes + 1), &mut out)
        .map_err(|e| format!("Unable to unpack {}: {e}", dest.display()))?;
    if copied > max_bytes {
        return Err(format!(
            "The unpacked binary is larger than {} MB.",
            max_bytes / (1024 * 1024)
        ));
    }
    out.sync_all().map_err(|e| e.to_string())?;
    drop(out);
    std::fs::rename(&temp_path, dest)
        .map_err(|e| format!("Unable to write {}: {e}", dest.display()))?;
    temp.0 = None;
    Ok(())
}

#[cfg(unix)]
fn make_executable(path: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755))
}

#[cfg(not(unix))]
fn make_executable(_path: &Path) -> std::io::Result<()> {
    Ok(())
}

/// Puts `binary` into `bin_dir` as `name`: hard-linked when on the same
/// file system, copied otherwise, always via a temp name and a rename so
/// `bin/` never holds a partial file. Returns the activated path.
fn activate(binary: &Path, bin_dir: &Path, name: &str) -> std::io::Result<PathBuf> {
    paths::ensure_private_dir(bin_dir)?;
    remove_leftovers(bin_dir, name);
    let dest = bin_dir.join(name);
    let mut temp = TempPath(Some(temp_sibling(&dest)));
    let temp_path = temp.0.clone().unwrap_or_default();
    if std::fs::hard_link(binary, &temp_path).is_err() {
        std::fs::copy(binary, &temp_path)?;
        make_executable(&temp_path)?;
    }
    replace_file(&temp_path, &dest)?;
    temp.0 = None;
    Ok(dest)
}

/// Renames `from` over `to`. On Windows a running executable can't be
/// replaced but can be renamed, so an existing `to` is moved aside first.
fn replace_file(from: &Path, to: &Path) -> std::io::Result<()> {
    match std::fs::rename(from, to) {
        Ok(()) => Ok(()),
        #[cfg(windows)]
        Err(e) if to.exists() => {
            let old = temp_sibling(to).with_extension("old");
            std::fs::rename(to, &old).map_err(|_| e)?;
            std::fs::rename(from, to)?;
            // Still running: removed by a later install / uninstall.
            let _ = std::fs::remove_file(&old);
            Ok(())
        }
        Err(e) => Err(e),
    }
}

/// Removes `.<name>.*.part` / `.<name>.*.old` files of an interrupted
/// activation or a replaced, then still running, executable (best effort).
fn remove_leftovers(dir: &Path, name: &str) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let prefix = format!(".{name}.");
    for entry in entries.flatten() {
        let file_name = entry.file_name().to_string_lossy().into_owned();
        if file_name.starts_with(&prefix)
            && (file_name.ends_with(".part") || file_name.ends_with(".old"))
        {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

/// Removes the other installed versions of a tool (best effort).
fn prune_versions(tool_dir: &Path, keep: &str) {
    let Ok(entries) = std::fs::read_dir(tool_dir) else {
        return;
    };
    for entry in entries.flatten() {
        if entry.file_name() != keep && entry.path().is_dir() {
            if let Err(e) = std::fs::remove_dir_all(entry.path()) {
                warn!("Unable to remove {}: {}", entry.path().display(), e);
            }
        }
    }
}

/// Removes a managed kubectl/helm/kubelogin: the activated binary in `bin/`
/// and every downloaded version. Nothing outside the managed directories
/// is touched.
#[tauri::command]
pub async fn tools_uninstall(tool: String) -> Result<(), String> {
    let tool = find_tool(&tool)?;
    if tool.installer.is_none() {
        return Err(format!("{} is not managed by JET Pilot.", tool.name));
    }
    let _guard = INSTALL_LOCK.lock().await;
    let (bin_dir, tools_dir) = (paths::managed_bin_dir(), paths::managed_tools_dir());
    tauri::async_runtime::spawn_blocking(move || uninstall_from(tool, &bin_dir, &tools_dir))
        .await
        .map_err(|e| e.to_string())??;
    info!("Uninstalled the managed {}", tool.id);
    invalidate_cache().await;
    Ok(())
}

fn uninstall_from(tool: &Tool, bin_dir: &Path, tools_dir: &Path) -> Result<(), String> {
    let name = binary_file_name(tool);
    remove_leftovers(bin_dir, &name);
    let binary = bin_dir.join(&name);
    match std::fs::remove_file(&binary) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(format!("Unable to remove {}: {e}", binary.display())),
    }
    let dir = tools_dir.join(tool.id);
    match std::fs::remove_dir_all(&dir) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("Unable to remove {}: {e}", dir.display())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn tool(id: &str) -> &'static Tool {
        find_tool(id).unwrap()
    }

    #[test]
    fn tool_table_order_and_names() {
        let ids: Vec<_> = TOOLS.iter().map(|t| t.id).collect();
        assert_eq!(
            ids,
            [
                "kubectl",
                "helm",
                "aws",
                "gcloud",
                "az",
                "kubelogin",
                "gke-gcloud-auth-plugin",
                "doctl"
            ]
        );
        assert_eq!(tool("gcloud").name, "Google Cloud CLI");
        assert!(find_tool("rm").is_err());
        assert_eq!(pinned_version(tool("kubectl")), Some("v1.34.1"));
        assert_eq!(pinned_version(tool("helm")), Some("v3.19.0"));
        assert_eq!(pinned_version(tool("kubelogin")), Some(KUBELOGIN_VERSION));
        assert_eq!(pinned_version(tool("aws")), None);
    }

    #[test]
    fn platform_mapping() {
        assert_eq!(
            Platform::from_rust("macos", "aarch64"),
            Some(Platform {
                os: "darwin",
                arch: "arm64"
            })
        );
        assert_eq!(
            Platform::from_rust("windows", "x86_64"),
            Some(Platform {
                os: "windows",
                arch: "amd64"
            })
        );
        assert_eq!(Platform::from_rust("linux", "arm"), None);
        assert_eq!(Platform::from_rust("freebsd", "x86_64"), None);
    }

    #[test]
    fn download_urls_per_platform() {
        let linux = Platform {
            os: "linux",
            arch: "amd64",
        };
        let mac = Platform {
            os: "darwin",
            arch: "arm64",
        };
        let windows = Platform {
            os: "windows",
            arch: "arm64",
        };

        let plan = install_plan(Installer::Kubectl, "v1.34.1", linux);
        assert_eq!(
            plan.url,
            "https://dl.k8s.io/release/v1.34.1/bin/linux/amd64/kubectl"
        );
        assert_eq!(
            plan.checksum_url,
            "https://dl.k8s.io/release/v1.34.1/bin/linux/amd64/kubectl.sha256"
        );
        assert_eq!(
            (plan.artifact.as_str(), plan.binary.as_str()),
            ("kubectl", "kubectl")
        );
        assert_eq!(plan.archive, None);

        let plan = install_plan(Installer::Kubectl, "v1.34.1", windows);
        assert_eq!(
            plan.url,
            "https://dl.k8s.io/release/v1.34.1/bin/windows/arm64/kubectl.exe"
        );
        assert_eq!(plan.binary, "kubectl.exe");

        let plan = install_plan(Installer::Helm, "v3.19.0", mac);
        assert_eq!(
            plan.url,
            "https://get.helm.sh/helm-v3.19.0-darwin-arm64.tar.gz"
        );
        assert_eq!(
            plan.checksum_url,
            "https://get.helm.sh/helm-v3.19.0-darwin-arm64.tar.gz.sha256sum"
        );
        assert_eq!(plan.artifact, "helm-v3.19.0-darwin-arm64.tar.gz");
        assert_eq!(
            plan.archive,
            Some((ArchiveKind::TarGz, "darwin-arm64/helm".to_string()))
        );

        let plan = install_plan(Installer::Helm, "v3.19.0", windows);
        assert_eq!(
            plan.url,
            "https://get.helm.sh/helm-v3.19.0-windows-arm64.zip"
        );
        assert_eq!(plan.binary, "helm.exe");
        assert_eq!(
            plan.archive,
            Some((ArchiveKind::Zip, "windows-arm64/helm.exe".to_string()))
        );

        let plan = install_plan(Installer::Kubelogin, KUBELOGIN_VERSION, windows);
        assert_eq!(
            plan.url,
            "https://github.com/Azure/kubelogin/releases/download/v0.2.20/kubelogin-win-arm64.zip"
        );
        assert_eq!(
            plan.checksum_url,
            "https://github.com/Azure/kubelogin/releases/download/v0.2.20/kubelogin-win-arm64.zip.sha256"
        );
        assert_eq!(plan.binary, "kubelogin.exe");
        assert_eq!(
            plan.archive,
            Some((
                ArchiveKind::Zip,
                "bin/windows_arm64/kubelogin.exe".to_string()
            ))
        );
        assert_eq!(
            plan.sha256,
            Some("8155504e917636635d431f553cbb108bd3d7399e1ad255eacf0f4590ce222201")
        );
        let plan = install_plan(Installer::Kubelogin, KUBELOGIN_VERSION, mac);
        assert_eq!(plan.artifact, "kubelogin-darwin-arm64.zip");
        assert_eq!(
            plan.archive,
            Some((ArchiveKind::Zip, "bin/darwin_arm64/kubelogin".to_string()))
        );
        // Every supported platform has a pinned digest; other versions
        // fetch the published one.
        for os in ["darwin", "linux", "windows"] {
            for arch in ["amd64", "arm64"] {
                let plan = install_plan(
                    Installer::Kubelogin,
                    KUBELOGIN_VERSION,
                    Platform { os, arch },
                );
                let sha = plan.sha256.unwrap();
                assert_eq!(
                    net::normalize_sha256(sha).as_deref(),
                    Some(sha),
                    "{os}/{arch}"
                );
            }
        }
        assert_eq!(
            install_plan(Installer::Kubelogin, "v0.2.19", linux).sha256,
            None
        );

        for plan in [
            install_plan(Installer::Kubectl, "v1", linux),
            install_plan(Installer::Helm, "v1", mac),
            install_plan(Installer::Kubelogin, "v1", windows),
        ] {
            let host = tauri_plugin_http::reqwest::Url::parse(&plan.url).unwrap();
            assert!(DOWNLOAD_HOSTS.contains(&host.host_str().unwrap()));
        }
    }

    #[test]
    fn requested_versions_are_validated() {
        assert_eq!(normalize_version("v1.34.1").as_deref(), Some("v1.34.1"));
        assert_eq!(normalize_version(" 3.19.0 ").as_deref(), Some("v3.19.0"));
        assert_eq!(
            normalize_version("v4.0.0-rc.1").as_deref(),
            Some("v4.0.0-rc.1")
        );
        for bad in [
            "",
            "v",
            "latest",
            "v1",
            "v1.2/../../x",
            "v1.2.3?x=1",
            "../v1.2.3",
            "v1.2 3",
            "é1.2",
        ] {
            assert_eq!(normalize_version(bad), None, "{bad}");
        }
    }

    #[test]
    fn version_parsers() {
        let kubectl = r#"{
  "clientVersion": {"major": "1", "minor": "31", "gitVersion": "v1.31.2", "platform": "linux/amd64"},
  "kustomizeVersion": "v5.4.2"
}"#;
        assert_eq!(parse_kubectl_version(kubectl).as_deref(), Some("v1.31.2"));
        assert_eq!(
            parse_kubectl_version(r#"{"clientVersion":{"gitVersion":"v1.30.2-eks-1552ad0"}}"#)
                .as_deref(),
            Some("v1.30.2-eks-1552ad0")
        );
        assert_eq!(
            parse_kubectl_version("Client Version: v1.29.0\nKustomize Version: v5.0.4").as_deref(),
            Some("v1.29.0")
        );

        assert_eq!(first_version("v3.19.0").as_deref(), Some("v3.19.0"));
        assert_eq!(
            first_version("v3.16.2+g13654a5\n").as_deref(),
            Some("v3.16.2")
        );

        assert_eq!(
            first_version("aws-cli/2.17.0 Python/3.11.9 Linux/6.5.0-1025-azure exe/x86_64.ubuntu.22 prompt/off").as_deref(),
            Some("2.17.0")
        );

        let gcloud = r#"Updates are available for some Google Cloud CLI components.
{
  "Google Cloud SDK": "490.0.0",
  "bq": "2.1.8",
  "core": "2024.08.30"
}"#;
        assert_eq!(parse_gcloud_version(gcloud).as_deref(), Some("490.0.0"));
        assert_eq!(
            parse_gcloud_version("Google Cloud SDK 471.0.0\nbq 2.1.3\n").as_deref(),
            Some("471.0.0")
        );

        let az = r#"{
  "azure-cli": "2.64.0",
  "azure-cli-core": "2.64.0",
  "azure-cli-telemetry": "1.1.0",
  "extensions": {}
}"#;
        assert_eq!(parse_az_version(az).as_deref(), Some("2.64.0"));

        // Azure kubelogin and int128/kubelogin (oidc-login).
        let azure_kubelogin = "kubelogin version\ngit hash: v0.1.4/d7f1c16c95cc0a1a3beb056374def7b744a38b3a\nGo version: go1.22.5\nBuild time: 2024-07-16T22:02:53Z\nPlatform: linux/amd64\n";
        assert_eq!(first_version(azure_kubelogin).as_deref(), Some("v0.1.4"));
        assert_eq!(
            first_version("kubelogin version v1.28.1\n").as_deref(),
            Some("v1.28.1")
        );

        assert_eq!(
            first_version("Kubernetes v1.30.0+3f4b1d9b33a8d9fa9a7e8e1ce5b3a2ad6c5d3b8f\n")
                .as_deref(),
            Some("v1.30.0")
        );

        assert_eq!(
            parse_doctl_version("doctl version 1.110.0-release\nRelease details: https://github.com/digitalocean/doctl/releases/tag/v1.110.0\n").as_deref(),
            Some("1.110.0")
        );

        assert_eq!(first_version("command not found"), None);
        assert_eq!(first_version("go1.22.5 1 v2"), None);
        assert_eq!(parse_kubectl_version("error: unknown flag"), None);
    }

    #[test]
    fn managed_paths_are_recognised() {
        let home = tempfile::tempdir().unwrap();
        let bin = home.path().join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        std::fs::write(bin.join("kubectl"), b"").unwrap();

        assert!(is_managed_path(&bin.join("kubectl"), &bin));
        assert!(!is_managed_path(Path::new("/usr/local/bin/kubectl"), &bin));
        assert!(!is_managed_path(&home.path().join("kubectl"), &bin));

        #[cfg(unix)]
        {
            let link = home.path().join("link");
            std::os::unix::fs::symlink(&bin, &link).unwrap();
            assert!(is_managed_path(&link.join("kubectl"), &bin));
        }
    }

    #[test]
    fn status_json_shape() {
        let status = ToolStatus {
            id: "kubectl".into(),
            name: "kubectl".into(),
            found: true,
            path: Some("/x/kubectl".into()),
            version: Some("v1.34.1".into()),
            source: ToolSource::Managed,
            installable: true,
            install_version: Some("v1.34.1".into()),
            problem: None,
        };
        let json = serde_json::to_value(status).unwrap();
        assert_eq!(json["source"], "managed");
        assert_eq!(json["installVersion"], "v1.34.1");
        assert_eq!(
            serde_json::to_value(ToolSource::Missing).unwrap(),
            "missing"
        );

        let event = |e: DownloadEvent| serde_json::to_value(e).unwrap();
        assert_eq!(
            event(DownloadEvent::Started {
                url: "u".into(),
                version: "v".into()
            }),
            serde_json::json!({"type": "started", "url": "u", "version": "v"})
        );
        assert_eq!(
            event(DownloadEvent::Progress {
                received: 5,
                total: None
            }),
            serde_json::json!({"type": "progress", "received": 5, "total": null})
        );
        assert_eq!(
            event(DownloadEvent::Verifying),
            serde_json::json!({"type": "verifying"})
        );
        assert_eq!(
            event(DownloadEvent::Done { path: "p".into() }),
            serde_json::json!({"type": "done", "path": "p"})
        );
        assert_eq!(
            event(DownloadEvent::Failed {
                message: "m".into()
            }),
            serde_json::json!({"type": "failed", "message": "m"})
        );
    }

    #[test]
    fn progress_is_throttled_but_completion_always_sent() {
        let mut throttle = Throttle { last: None };
        let t0 = Instant::now();
        assert!(throttle.ready(t0, false));
        assert!(!throttle.ready(t0 + Duration::from_millis(10), false));
        assert!(throttle.ready(t0 + Duration::from_millis(20), true));
        assert!(!throttle.ready(t0 + Duration::from_millis(50), false));
        assert!(throttle.ready(t0 + Duration::from_millis(130), false));
    }

    fn tar_gz(files: &[(&str, &[u8])]) -> Vec<u8> {
        let mut builder = tar::Builder::new(flate2::write::GzEncoder::new(
            Vec::new(),
            flate2::Compression::fast(),
        ));
        for (name, data) in files {
            let mut header = tar::Header::new_gnu();
            header.set_size(data.len() as u64);
            header.set_mode(0o644);
            header.set_cksum();
            builder.append_data(&mut header, name, *data).unwrap();
        }
        builder.into_inner().unwrap().finish().unwrap()
    }

    fn zip(files: &[(&str, &[u8])]) -> Vec<u8> {
        let mut writer = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
        for (name, data) in files {
            writer
                .start_file(*name, zip::write::SimpleFileOptions::default())
                .unwrap();
            writer.write_all(data).unwrap();
        }
        writer.finish().unwrap().into_inner()
    }

    #[test]
    fn extracts_the_helm_binary_from_release_archives() {
        let dir = tempfile::tempdir().unwrap();
        let cases = [
            (
                ArchiveKind::TarGz,
                "linux-amd64/helm",
                tar_gz(&[
                    ("linux-amd64/README.md", b"readme"),
                    ("linux-amd64/helm", b"#!helm"),
                ]),
            ),
            (
                ArchiveKind::Zip,
                "windows-amd64/helm.exe",
                zip(&[
                    ("windows-amd64/LICENSE", b"license"),
                    ("windows-amd64/helm.exe", b"MZhelm"),
                ]),
            ),
        ];
        for (kind, member, bytes) in cases {
            let archive = dir.path().join("archive");
            std::fs::write(&archive, bytes).unwrap();
            let dest = dir.path().join("helm-out");
            extract_member(&archive, kind, member, &dest, 1024).unwrap();
            assert!(std::fs::read(&dest).unwrap().ends_with(b"helm"));

            // Wrong platform member / size cap.
            assert!(
                extract_member(&archive, kind, "darwin-arm64/helm", &dest, 1024)
                    .unwrap_err()
                    .contains("does not contain")
            );
            assert!(extract_member(&archive, kind, member, &dest, 2)
                .unwrap_err()
                .contains("larger than"));
            std::fs::remove_file(&dest).unwrap();
            std::fs::remove_file(&archive).unwrap();
        }
        // No temp files left behind.
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);

        let garbage = dir.path().join("garbage");
        std::fs::write(&garbage, b"not an archive").unwrap();
        assert!(extract_member(
            &garbage,
            ArchiveKind::TarGz,
            "x/helm",
            &dir.path().join("o"),
            10
        )
        .is_err());
        assert!(extract_member(
            &garbage,
            ArchiveKind::Zip,
            "x/helm",
            &dir.path().join("o"),
            10
        )
        .is_err());
    }

    #[test]
    fn activation_replaces_the_binary_in_bin_and_uninstall_cleans_up() {
        let home = tempfile::tempdir().unwrap();
        let (bin, tools) = (home.path().join("bin"), home.path().join("tools"));
        let name = binary_file_name(tool("kubectl"));
        let v1 = tools.join("kubectl").join("v1.33.0");
        let v2 = tools.join("kubectl").join("v1.34.1");
        for (dir, data) in [(&v1, b"one"), (&v2, b"two")] {
            std::fs::create_dir_all(dir).unwrap();
            std::fs::write(dir.join(&name), data).unwrap();
            make_executable(&dir.join(&name)).unwrap();
        }

        let activated = activate(&v1.join(&name), &bin, &name).unwrap();
        assert_eq!(activated, bin.join(&name));
        assert_eq!(std::fs::read(&activated).unwrap(), b"one");
        let activated = activate(&v2.join(&name), &bin, &name).unwrap();
        assert_eq!(std::fs::read(&activated).unwrap(), b"two");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&activated).unwrap().permissions().mode();
            assert_eq!(mode & 0o111, 0o111);
            let mode = std::fs::metadata(&bin).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o700);
        }
        // Only the activated binary, no temp files.
        assert_eq!(std::fs::read_dir(&bin).unwrap().count(), 1);

        prune_versions(&tools.join("kubectl"), "v1.34.1");
        assert!(!v1.exists());
        assert!(v2.exists());

        // Leftovers of an interrupted activation are swept.
        let stale = bin.join(format!(".{name}.0123.part"));
        std::fs::write(&stale, b"partial").unwrap();
        activate(&v2.join(&name), &bin, &name).unwrap();
        assert!(!stale.exists());

        // Uninstall leaves other tools and unrelated files alone.
        std::fs::write(bin.join("helm"), b"helm").unwrap();
        std::fs::write(bin.join(format!(".{name}.0123.old")), b"old").unwrap();
        std::fs::create_dir_all(tools.join("helm")).unwrap();
        uninstall_from(tool("kubectl"), &bin, &tools).unwrap();
        assert!(!bin.join(&name).exists());
        assert_eq!(std::fs::read_dir(&bin).unwrap().count(), 1);
        assert!(!tools.join("kubectl").exists());
        assert!(bin.join("helm").exists());
        assert!(tools.join("helm").exists());
        // Idempotent.
        uninstall_from(tool("kubectl"), &bin, &tools).unwrap();
    }

    #[test]
    fn uninstall_command_uses_jet_pilot_home() {
        let _guard = crate::util::lock(&paths::TEST_ENV_LOCK);
        let home = tempfile::tempdir().unwrap();
        std::env::set_var(paths::HOME_ENV, home.path());
        let bin = home.path().join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        std::fs::write(bin.join(binary_file_name(tool("helm"))), b"helm").unwrap();
        std::fs::write(bin.join("unrelated"), b"x").unwrap();

        let result = tauri::async_runtime::block_on(tools_uninstall("helm".into()));
        let refused = tauri::async_runtime::block_on(tools_uninstall("aws".into()));
        let unknown = tauri::async_runtime::block_on(tools_uninstall("../../etc".into()));
        std::env::remove_var(paths::HOME_ENV);

        result.unwrap();
        assert!(refused.unwrap_err().contains("not managed"));
        assert!(unknown.is_err());
        assert!(!bin.join(binary_file_name(tool("helm"))).exists());
        assert!(bin.join("unrelated").exists());
    }

    /// Installs the pinned kubectl, helm and kubelogin from the official
    /// origins into a temporary `JET_PILOT_HOME`. Needs network; run after
    /// bumping the pins:
    /// `cargo test -- --ignored installs_pinned_tools_from_official_origins`
    #[test]
    #[ignore]
    fn installs_pinned_tools_from_official_origins() {
        let _guard = crate::util::lock(&paths::TEST_ENV_LOCK);
        let home = tempfile::tempdir().unwrap();
        std::env::set_var(paths::HOME_ENV, home.path());
        let events = std::sync::Mutex::new(Vec::new());
        let emit = |event: DownloadEvent| crate::util::lock(&events).push(event);
        let results = tauri::async_runtime::block_on(async {
            let mut results = Vec::new();
            for id in ["kubectl", "helm", "kubelogin"] {
                results.push(install("JET-Pilot/test", id, None, &emit).await);
            }
            results
        });
        std::env::remove_var(paths::HOME_ENV);

        for result in results {
            result.unwrap();
        }
        let events = events.into_inner().unwrap();
        assert!(matches!(
            events.first(),
            Some(DownloadEvent::Started { .. })
        ));
        assert_eq!(
            events
                .iter()
                .filter(|e| **e == DownloadEvent::Verifying)
                .count(),
            3
        );
        assert!(!events
            .iter()
            .any(|e| matches!(e, DownloadEvent::Failed { .. })));
        let progress = events
            .iter()
            .filter(|e| matches!(e, DownloadEvent::Progress { .. }))
            .count();
        println!("{} events, {} progress", events.len(), progress);

        for id in ["kubectl", "helm", "kubelogin"] {
            let binary = home.path().join("bin").join(binary_file_name(tool(id)));
            let version = tauri::async_runtime::block_on(run_version(
                tool(id),
                &binary,
                INSTALL_CHECK_TIMEOUT,
            ));
            assert_eq!(version.unwrap().as_deref(), pinned_version(tool(id)));
            // Only the binary is kept, no archive or temp files.
            let version_dir = home
                .path()
                .join("tools")
                .join(id)
                .join(pinned_version(tool(id)).unwrap());
            assert_eq!(std::fs::read_dir(version_dir).unwrap().count(), 1);
        }
    }

    /// The kubelogin install path without network: a release-shaped zip
    /// served locally, verified against its SHA-256 (a wrong digest leaves
    /// nothing behind), unpacked from `bin/<os>_<arch>/` and version-checked.
    #[cfg(unix)]
    #[tokio::test]
    async fn kubelogin_archives_are_verified_and_unpacked() {
        use sha2::{Digest, Sha256};
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let platform = Platform {
            os: "linux",
            arch: "amd64",
        };
        let script = b"#!/bin/sh\necho 'kubelogin version'\necho 'git hash: v0.2.20/0123abc'\n";
        let archive = zip(&[
            ("bin/linux_amd64/kubelogin", script),
            ("bin/linux_amd64/LICENSE", b"MIT"),
        ]);
        let digest = format!("{:x}", Sha256::digest(&archive));

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let body = archive.clone();
        tokio::spawn(async move {
            while let Ok((mut socket, _)) = listener.accept().await {
                let body = body.clone();
                tokio::spawn(async move {
                    let mut head = Vec::new();
                    let mut buf = [0u8; 1024];
                    while !head.windows(4).any(|w| w == b"\r\n\r\n") {
                        match socket.read(&mut buf).await {
                            Ok(0) | Err(_) => return,
                            Ok(n) => head.extend_from_slice(&buf[..n]),
                        }
                    }
                    let response = format!(
                        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                        body.len()
                    );
                    let _ = socket.write_all(response.as_bytes()).await;
                    let _ = socket.write_all(&body).await;
                });
            }
        });

        let mut plan = install_plan(Installer::Kubelogin, KUBELOGIN_VERSION, platform);
        plan.url = format!("http://{addr}/{}", plan.artifact);
        let client = tauri_plugin_http::reqwest::Client::builder()
            .no_proxy()
            .build()
            .unwrap();
        let dir = tempfile::tempdir().unwrap();
        let emit = |_: DownloadEvent| {};

        // A tampered (or different) archive: nothing is left behind.
        let wrong = "0".repeat(64);
        let error =
            download_and_unpack(&client, &plan, dir.path(), &wrong, tool("kubelogin"), &emit)
                .await
                .unwrap_err();
        assert!(error.contains("checksum does not match"), "{error}");
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);

        let binary = download_and_unpack(
            &client,
            &plan,
            dir.path(),
            &digest,
            tool("kubelogin"),
            &emit,
        )
        .await
        .unwrap();
        assert_eq!(binary, dir.path().join("kubelogin"));
        assert_eq!(std::fs::read(&binary).unwrap(), script);
        // Only the binary is kept.
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
        let version = run_version(tool("kubelogin"), &binary, Duration::from_secs(10))
            .await
            .unwrap();
        assert_eq!(version.as_deref(), Some("v0.2.20"));
    }

    #[cfg(unix)]
    fn fake_tool(dir: &Path, name: &str, script: &str) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let path = dir.join(name);
        std::fs::write(&path, format!("#!/bin/sh\n{script}\n")).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        path
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn detection_runs_the_version_command() {
        let dir = tempfile::tempdir().unwrap();
        let bin = dir.path().join("bin");
        std::fs::create_dir_all(&bin).unwrap();

        // helm prints its version for exactly the expected arguments.
        let helm = fake_tool(
            &bin,
            "helm",
            r#"[ "$*" = "version --template {{.Version}}" ] && printf v3.19.0 || exit 1"#,
        );
        let status = status_for(
            tool("helm"),
            Some(helm.clone()),
            &bin,
            Duration::from_secs(10),
        )
        .await;
        assert!(status.found);
        assert_eq!(status.source, ToolSource::Managed);
        assert_eq!(status.version.as_deref(), Some("v3.19.0"));
        assert_eq!(status.path.as_deref(), helm.to_str());
        assert_eq!(status.problem, None);
        assert!(status.installable);
        assert_eq!(status.install_version.as_deref(), Some("v3.19.0"));

        // aws v1 printed its version on stderr.
        let aws = fake_tool(
            dir.path(),
            "aws",
            "echo 'aws-cli/1.33.1 Python/3.12.4 botocore/1.34.149' >&2",
        );
        let status = status_for(tool("aws"), Some(aws), &bin, Duration::from_secs(10)).await;
        assert_eq!(status.source, ToolSource::Path);
        assert_eq!(status.version.as_deref(), Some("1.33.1"));
        assert!(!status.installable);
        assert_eq!(status.install_version, None);

        let broken = fake_tool(
            dir.path(),
            "gcloud",
            "echo 'ERROR: gcloud failed to load' >&2; exit 2",
        );
        let status = status_for(tool("gcloud"), Some(broken), &bin, Duration::from_secs(10)).await;
        assert!(status.found);
        assert_eq!(status.version, None);
        assert!(status
            .problem
            .unwrap()
            .contains("ERROR: gcloud failed to load"));

        let slow = fake_tool(dir.path(), "az", "sleep 30");
        let status = status_for(tool("az"), Some(slow), &bin, Duration::from_millis(200)).await;
        assert!(status.problem.unwrap().contains("did not answer"));

        let status = status_for(tool("doctl"), None, &bin, Duration::from_secs(1)).await;
        assert!(!status.found);
        assert_eq!(status.source, ToolSource::Missing);
        assert_eq!(status.path, None);
    }
}

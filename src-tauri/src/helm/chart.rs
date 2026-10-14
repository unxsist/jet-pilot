//! What a chart offers before it is installed: Chart.yaml, the default
//! values (as written, comments included), values.schema.json and the
//! README. `helm pull` fetches the package (any reference helm resolves:
//! `repo/chart`, `oci://…`) into a private temporary directory that is
//! removed again; the archive is read in memory with hard size caps.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use flate2::read::GzDecoder;
use serde::Serialize;
use serde_json::Value;
use tokio::process::Command;
use tracing::{info, warn};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

use super::storage::ChartMetadata;

const PULL_TIMEOUT: Duration = Duration::from_secs(120);
const MAX_ARCHIVE_BYTES: u64 = 32 * 1024 * 1024;
const MAX_VALUES_BYTES: u64 = 2 * 1024 * 1024;
const MAX_SCHEMA_BYTES: u64 = 2 * 1024 * 1024;
const MAX_README_BYTES: u64 = 512 * 1024;
const MAX_ENTRIES: usize = 20_000;

#[derive(Debug, Default, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ChartPackage {
    pub metadata: ChartMetadata,
    /// values.yaml as written (comments included); empty when absent.
    pub values: String,
    pub values_schema: Option<Value>,
    pub readme: String,
}

/// Removes the pull directory on every return path.
struct TempDir(PathBuf);

impl Drop for TempDir {
    fn drop(&mut self) {
        if let Err(e) = std::fs::remove_dir_all(&self.0) {
            if e.kind() != std::io::ErrorKind::NotFound {
                warn!("Unable to remove the chart download directory: {}", e);
            }
        }
    }
}

fn private_temp_dir() -> Result<TempDir, String> {
    let path = std::env::temp_dir().join(format!("jet-pilot-chart-{}", uuid::Uuid::new_v4()));
    let mut builder = std::fs::DirBuilder::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(&path).map_err(|e| format!("Unable to create a download directory: {e}"))?;
    Ok(TempDir(path))
}

/// A chart reference helm may resolve: `repo/chart`, `oci://…`, an
/// https URL. Never an option, a local path or whitespace.
pub(crate) fn valid_reference(reference: &str) -> bool {
    let r = reference.trim();
    if r.is_empty() || r.starts_with('-') || r.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return false;
    }
    if let Some(rest) = r.strip_prefix("oci://").or_else(|| r.strip_prefix("https://")) {
        return !rest.is_empty();
    }
    let mut parts = r.split('/');
    matches!((parts.next(), parts.next(), parts.next()), (Some(repo), Some(chart), None) if !repo.is_empty() && !chart.is_empty() && repo != "." && repo != "..")
}

pub(crate) fn valid_version(version: &str) -> bool {
    !version.is_empty()
        && !version.starts_with('-')
        && version.len() <= 128
        && version.chars().all(|c| c.is_ascii_alphanumeric() || ".-+_~^<>=*, ".contains(c))
}

fn read_capped(entry: impl Read, cap: u64) -> Result<String, String> {
    let mut text = String::new();
    entry
        .take(cap + 1)
        .read_to_string(&mut text)
        .map_err(|e| format!("Unable to read the chart: {e}"))?;
    if text.len() as u64 > cap {
        return Err(format!("The chart has a file larger than {} KB", cap / 1024));
    }
    Ok(text)
}

/// Reads Chart.yaml, values.yaml, values.schema.json and README.md of the
/// chart (not its subcharts) from a packaged chart.
pub(crate) fn read_package(archive: impl Read) -> Result<ChartPackage, String> {
    let mut tar = tar::Archive::new(GzDecoder::new(archive.take(MAX_ARCHIVE_BYTES)));
    let mut package = ChartPackage::default();
    let mut chart_yaml = None;
    let entries = tar.entries().map_err(|e| format!("Unable to read the chart: {e}"))?;
    for (index, entry) in entries.enumerate() {
        if index >= MAX_ENTRIES {
            return Err("The chart has too many files".into());
        }
        let entry = entry.map_err(|e| format!("Unable to read the chart: {e}"))?;
        let path = entry.path().map_err(|e| e.to_string())?.into_owned();
        let parts: Vec<_> = path.components().collect();
        // <chart>/<file>: files of the chart itself, not of charts/<sub>/.
        if parts.len() != 2 {
            continue;
        }
        let file = parts[1].as_os_str().to_string_lossy().to_string();
        match file.as_str() {
            "Chart.yaml" => chart_yaml = Some(read_capped(entry, MAX_VALUES_BYTES)?),
            "values.yaml" => package.values = read_capped(entry, MAX_VALUES_BYTES)?,
            "values.schema.json" => {
                let text = read_capped(entry, MAX_SCHEMA_BYTES)?;
                package.values_schema = serde_json::from_str::<Value>(&text).ok().filter(Value::is_object);
            }
            name if name.eq_ignore_ascii_case("README.md") => {
                // A README larger than the cap is cut, not an error.
                let mut bytes = Vec::new();
                entry
                    .take(MAX_README_BYTES)
                    .read_to_end(&mut bytes)
                    .map_err(|e| format!("Unable to read the chart: {e}"))?;
                package.readme = String::from_utf8_lossy(&bytes).into_owned();
            }
            _ => {}
        }
    }
    let chart_yaml = chart_yaml.ok_or_else(|| "The package has no Chart.yaml".to_string())?;
    package.metadata =
        serde_saphyr::from_str(&chart_yaml).map_err(|e| format!("The chart's Chart.yaml is invalid: {e}"))?;
    Ok(package)
}

fn find_archive(dir: &Path) -> Result<PathBuf, String> {
    std::fs::read_dir(dir)
        .map_err(|e| e.to_string())?
        .filter_map(Result::ok)
        .map(|e| e.path())
        .find(|p| p.extension().is_some_and(|ext| ext == "tgz"))
        .ok_or_else(|| "helm pull did not download a chart".to_string())
}

/// Chart.yaml, default values, values schema and README of a chart
/// version (the latest when `version` is None).
#[tauri::command]
pub async fn helm_chart_inspect(reference: String, version: Option<String>) -> Result<ChartPackage, String> {
    if !valid_reference(&reference) {
        return Err(format!("'{reference}' is not a chart reference"));
    }
    let version = version.map(|v| v.trim().to_string()).filter(|v| !v.is_empty());
    if let Some(v) = &version {
        if !valid_version(v) {
            return Err(format!("'{v}' is not a chart version"));
        }
    }
    let dir = private_temp_dir()?;

    let mut cmd = Command::new("helm");
    cmd.arg("pull").arg(reference.trim()).arg("--destination").arg(&dir.0);
    if let Some(v) = &version {
        cmd.arg("--version").arg(v);
    }
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
    #[cfg(windows)]
    cmd.creation_flags(0x08000000);

    info!("Pulling chart {} {}", reference, version.as_deref().unwrap_or("(latest)"));
    let output = tokio::time::timeout(PULL_TIMEOUT, cmd.output())
        .await
        .map_err(|_| "Downloading the chart took longer than two minutes".to_string())?
        .map_err(|e| format!("Unable to run helm: {e}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() { format!("helm pull exited with {}", output.status) } else { stderr });
    }

    let archive = find_archive(&dir.0)?;
    tauri::async_runtime::spawn_blocking(move || {
        let file = std::fs::File::open(&archive).map_err(|e| format!("Unable to open the chart: {e}"))?;
        let package = read_package(file);
        drop(dir);
        package
    })
    .await
    .map_err(|e| format!("Unable to read the chart: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use flate2::write::GzEncoder;
    use flate2::Compression;

    fn package(files: &[(&str, &str)]) -> Vec<u8> {
        let mut builder = tar::Builder::new(GzEncoder::new(Vec::new(), Compression::default()));
        for (path, content) in files {
            let mut header = tar::Header::new_gnu();
            header.set_size(content.len() as u64);
            header.set_mode(0o644);
            header.set_cksum();
            builder.append_data(&mut header, path, content.as_bytes()).unwrap();
        }
        builder.into_inner().unwrap().finish().unwrap()
    }

    #[test]
    fn reads_the_chart_and_not_its_subcharts() {
        let archive = package(&[
            ("redis/Chart.yaml", "apiVersion: v2\nname: redis\nversion: 19.6.4\nappVersion: 7.2.5\ndescription: Redis\nhome: https://redis.io\nsources:\n  - https://github.com/redis/redis\n"),
            ("redis/values.yaml", "# Number of replicas\nreplicaCount: 3\n"),
            ("redis/values.schema.json", r#"{"type":"object","properties":{"replicaCount":{"type":"integer"}}}"#),
            ("redis/README.md", "# Redis\n\nInstall with `helm install`.\n"),
            ("redis/charts/common/values.yaml", "common: true\n"),
            ("redis/charts/common/Chart.yaml", "name: common\nversion: 1.0.0\n"),
        ]);
        let chart = read_package(archive.as_slice()).unwrap();
        assert_eq!(chart.metadata.name, "redis");
        assert_eq!(chart.metadata.version, "19.6.4");
        assert_eq!(chart.metadata.app_version.as_deref(), Some("7.2.5"));
        assert_eq!(chart.metadata.sources, vec!["https://github.com/redis/redis".to_string()]);
        assert_eq!(chart.values, "# Number of replicas\nreplicaCount: 3\n");
        assert_eq!(chart.values_schema.unwrap()["type"], "object");
        assert!(chart.readme.starts_with("# Redis"));
    }

    #[test]
    fn a_package_without_chart_yaml_is_an_error() {
        let archive = package(&[("x/values.yaml", "a: 1\n")]);
        assert!(read_package(archive.as_slice()).is_err());
    }

    #[test]
    fn references_and_versions_are_validated() {
        assert!(valid_reference("bitnami/redis"));
        assert!(valid_reference("oci://registry-1.docker.io/bitnamicharts/redis"));
        assert!(valid_reference("https://example.com/charts/redis-1.0.0.tgz"));
        assert!(!valid_reference("--set=x"));
        assert!(!valid_reference("redis"));
        assert!(!valid_reference("../etc/passwd"));
        assert!(!valid_reference("a/b/c"));
        assert!(!valid_reference("bitnami/redis extra"));
        assert!(valid_version("19.6.4"));
        assert!(valid_version("v1.15.1"));
        assert!(valid_version(">=1.0.0"));
        assert!(!valid_version("--devel"));
        assert!(!valid_version(""));
        assert!(!valid_version("1.0;rm"));
    }
}

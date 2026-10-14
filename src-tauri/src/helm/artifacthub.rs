//! Artifact Hub (artifacthub.io): chart search, a package's versions /
//! README / default values / values schema, and chart logos.
//!
//! Only called when the user searches for or opens a chart. Requests go
//! through Rust (the webview's CSP stays untouched); bodies are capped and
//! mapped to compact DTOs (src/lib/helm.ts). Logos are fetched here too and
//! cached on disk, so the webview never loads remote images.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use base64::Engine;
use once_cell::sync::Lazy;
use serde::Serialize;
use serde_json::Value;
use tauri::Manager;
use tauri_plugin_http::reqwest;

use super::chart::valid_version;
use crate::net::{https_client_builder, user_agent};
use crate::util::lock;

const API_BASE: &str = "https://artifacthub.io/api/v1";
const IMAGE_BASE: &str = "https://artifacthub.io/image";
const API_TIMEOUT: Duration = Duration::from_secs(15);
const MAX_API_BYTES: usize = 4 * 1024 * 1024;
const MAX_VALUES_BYTES: usize = 2 * 1024 * 1024;
const MAX_LOGO_BYTES: usize = 512 * 1024;
const MAX_SEARCH_LIMIT: u32 = 60;
/// Logos kept in memory (data URLs of small images).
const MAX_CACHED_LOGOS: usize = 400;
/// Helm charts (Artifact Hub repository kind 0).
const HELM_KIND: &str = "0";

#[derive(Debug, Clone, Serialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactHubChart {
    pub package_id: String,
    pub name: String,
    pub display_name: Option<String>,
    pub description: String,
    pub version: String,
    pub app_version: String,
    pub repo_name: String,
    pub repo_display_name: Option<String>,
    pub repo_url: String,
    pub logo_image_id: Option<String>,
    pub official: bool,
    pub verified_publisher: bool,
    pub cncf: bool,
    pub deprecated: bool,
    pub signed: bool,
    pub stars: u64,
    /// Unix seconds of the latest version.
    pub updated: Option<i64>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactHubSearch {
    pub total: u64,
    pub charts: Vec<ArtifactHubChart>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactHubVersion {
    pub version: String,
    pub app_version: String,
    pub prerelease: bool,
    pub updated: Option<i64>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactHubLink {
    pub name: String,
    pub url: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactHubPackage {
    #[serde(flatten)]
    pub chart: ArtifactHubChart,
    pub home_url: Option<String>,
    pub readme: String,
    pub keywords: Vec<String>,
    pub links: Vec<ArtifactHubLink>,
    pub license: Option<String>,
    pub has_values_schema: bool,
    /// Newest first.
    pub versions: Vec<ArtifactHubVersion>,
}

/* ----------------------------------------------------------- mapping -- */

fn text(value: &Value, key: &str) -> String {
    value.get(key).and_then(Value::as_str).unwrap_or_default().to_string()
}

fn opt_text(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()).map(String::from)
}

fn flag(value: &Value, key: &str) -> bool {
    value.get(key).and_then(Value::as_bool).unwrap_or(false)
}

pub(crate) fn chart_from_json(package: &Value) -> Option<ArtifactHubChart> {
    let repository = package.get("repository")?;
    let name = opt_text(package, "name")?;
    Some(ArtifactHubChart {
        package_id: opt_text(package, "package_id")?,
        name,
        display_name: opt_text(package, "display_name"),
        description: text(package, "description"),
        version: text(package, "version"),
        app_version: text(package, "app_version"),
        repo_name: opt_text(repository, "name")?,
        repo_display_name: opt_text(repository, "display_name"),
        repo_url: text(repository, "url"),
        logo_image_id: opt_text(package, "logo_image_id").filter(|id| valid_id(id)),
        official: flag(package, "official") || flag(repository, "official"),
        verified_publisher: flag(repository, "verified_publisher"),
        cncf: flag(package, "cncf") || flag(repository, "cncf"),
        deprecated: flag(package, "deprecated"),
        signed: flag(package, "signed"),
        stars: package.get("stars").and_then(Value::as_u64).unwrap_or(0),
        updated: package.get("ts").and_then(Value::as_i64),
    })
}

pub(crate) fn parse_search(body: &Value, total: Option<u64>) -> ArtifactHubSearch {
    let charts: Vec<ArtifactHubChart> = body
        .get("packages")
        .and_then(Value::as_array)
        .map(|list| list.iter().filter_map(chart_from_json).collect())
        .unwrap_or_default();
    ArtifactHubSearch { total: total.unwrap_or(charts.len() as u64), charts }
}

pub(crate) fn parse_package(body: &Value) -> Option<ArtifactHubPackage> {
    let chart = chart_from_json(body)?;
    let mut versions: Vec<ArtifactHubVersion> = body
        .get("available_versions")
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(|v| {
                    Some(ArtifactHubVersion {
                        version: opt_text(v, "version")?,
                        app_version: text(v, "app_version"),
                        prerelease: flag(v, "prerelease"),
                        updated: v.get("ts").and_then(Value::as_i64),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    versions.sort_by_key(|v| std::cmp::Reverse(v.updated));
    Some(ArtifactHubPackage {
        home_url: opt_text(body, "home_url"),
        readme: text(body, "readme"),
        keywords: body
            .get("keywords")
            .and_then(Value::as_array)
            .map(|k| k.iter().filter_map(Value::as_str).map(String::from).collect())
            .unwrap_or_default(),
        links: body
            .get("links")
            .and_then(Value::as_array)
            .map(|l| {
                l.iter()
                    .filter_map(|link| {
                        let url = opt_text(link, "url").filter(|u| u.starts_with("https://") || u.starts_with("http://"))?;
                        Some(ArtifactHubLink { name: text(link, "name"), url })
                    })
                    .collect()
            })
            .unwrap_or_default(),
        license: opt_text(body, "license"),
        has_values_schema: flag(body, "has_values_schema"),
        versions,
        chart,
    })
}

/* -------------------------------------------------------- validation -- */

/// Artifact Hub ids are UUIDs.
fn valid_id(id: &str) -> bool {
    id.len() == 36 && id.chars().all(|c| c.is_ascii_hexdigit() || c == '-')
}

/// A repository or package name segment.
fn valid_segment(segment: &str) -> bool {
    !segment.is_empty()
        && segment.len() <= 128
        && segment != "."
        && segment != ".."
        && segment.chars().all(|c| c.is_ascii_alphanumeric() || "._-".contains(c))
}

/* --------------------------------------------------------- transport -- */

fn client(app: &tauri::AppHandle) -> Result<reqwest::Client, String> {
    https_client_builder(&user_agent(app), &["artifacthub.io"])
        .connect_timeout(API_TIMEOUT)
        .read_timeout(API_TIMEOUT)
        .build()
        .map_err(|e| format!("Unable to create the HTTP client: {e}"))
}

struct Fetched {
    body: Vec<u8>,
    content_type: String,
    total: Option<u64>,
}

async fn fetch(request: reqwest::RequestBuilder, limit: usize, what: &str) -> Result<Fetched, String> {
    let unreachable = |e: reqwest::Error| {
        if e.is_timeout() {
            format!("Artifact Hub took too long to answer ({what})")
        } else {
            format!("Can't reach Artifact Hub ({what})")
        }
    };
    let mut response = request.timeout(API_TIMEOUT).send().await.map_err(unreachable)?;
    let status = response.status();
    if status == reqwest::StatusCode::NOT_FOUND {
        return Err(format!("Artifact Hub doesn't have {what}"));
    }
    if !status.is_success() {
        return Err(format!("Artifact Hub is unavailable right now (HTTP {})", status.as_u16()));
    }
    let header = |name: &str| response.headers().get(name).and_then(|v| v.to_str().ok()).map(str::to_string);
    let content_type = header("content-type").unwrap_or_default();
    let total = header("pagination-total-count").and_then(|v| v.parse().ok());
    if response.content_length().is_some_and(|len| len > limit as u64) {
        return Err(format!("Artifact Hub sent more than expected ({what})"));
    }
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(unreachable)? {
        if body.len() + chunk.len() > limit {
            return Err(format!("Artifact Hub sent more than expected ({what})"));
        }
        body.extend_from_slice(&chunk);
    }
    Ok(Fetched { body, content_type, total })
}

fn json(fetched: &Fetched, what: &str) -> Result<Value, String> {
    serde_json::from_slice(&fetched.body).map_err(|_| format!("Artifact Hub sent an unreadable answer ({what})"))
}

/* ---------------------------------------------------------- commands -- */

/// Searches Artifact Hub for Helm charts.
#[tauri::command]
pub async fn artifacthub_search(
    app: tauri::AppHandle,
    query: String,
    limit: Option<u32>,
    offset: Option<u32>,
) -> Result<ArtifactHubSearch, String> {
    let query = query.trim();
    if query.is_empty() {
        return Ok(ArtifactHubSearch { total: 0, charts: vec![] });
    }
    let limit = limit.unwrap_or(24).clamp(1, MAX_SEARCH_LIMIT).to_string();
    let offset = offset.unwrap_or(0).to_string();
    let request = client(&app)?.get(format!("{API_BASE}/packages/search")).query(&[
        ("kind", HELM_KIND),
        ("ts_query_web", query),
        ("sort", "relevance"),
        ("facets", "false"),
        ("limit", limit.as_str()),
        ("offset", offset.as_str()),
    ]);
    let fetched = fetch(request, MAX_API_BYTES, "search results").await?;
    Ok(parse_search(&json(&fetched, "search results")?, fetched.total))
}

/// A chart on Artifact Hub (a version, or the latest): versions, README,
/// links.
#[tauri::command]
pub async fn artifacthub_package(
    app: tauri::AppHandle,
    repo: String,
    name: String,
    version: Option<String>,
) -> Result<ArtifactHubPackage, String> {
    if !valid_segment(&repo) || !valid_segment(&name) {
        return Err("Invalid chart name".into());
    }
    let mut url = format!("{API_BASE}/packages/helm/{repo}/{name}");
    if let Some(version) = version.filter(|v| !v.is_empty()) {
        if !valid_version(&version) || version.contains(['/', ' ', '<', '>', '*', ',']) {
            return Err("Invalid chart version".into());
        }
        url.push('/');
        url.push_str(&version);
    }
    let fetched = fetch(client(&app)?.get(url), MAX_API_BYTES, "this chart").await?;
    parse_package(&json(&fetched, "this chart")?).ok_or_else(|| "Artifact Hub sent an incomplete chart".into())
}

fn package_version_url(package_id: &str, version: &str, what: &str) -> Result<String, String> {
    if !valid_id(package_id) || !valid_version(version) || version.contains(['/', ' ']) {
        return Err("Invalid chart version".into());
    }
    Ok(format!("{API_BASE}/packages/{package_id}/{version}/{what}"))
}

/// Default values (values.yaml, as written) of a chart version.
#[tauri::command]
pub async fn artifacthub_values(app: tauri::AppHandle, package_id: String, version: String) -> Result<String, String> {
    let url = package_version_url(&package_id, &version, "values")?;
    let fetched = fetch(client(&app)?.get(url), MAX_VALUES_BYTES, "the chart's values").await?;
    Ok(String::from_utf8_lossy(&fetched.body).into_owned())
}

/// values.schema.json of a chart version, when it has one.
#[tauri::command]
pub async fn artifacthub_values_schema(
    app: tauri::AppHandle,
    package_id: String,
    version: String,
) -> Result<Option<Value>, String> {
    let url = package_version_url(&package_id, &version, "values-schema")?;
    match fetch(client(&app)?.get(url), MAX_VALUES_BYTES, "a values schema").await {
        Ok(fetched) => Ok(serde_json::from_slice::<Value>(&fetched.body).ok().filter(Value::is_object)),
        Err(e) if e.contains("doesn't have") => Ok(None),
        Err(e) => Err(e),
    }
}

/* -------------------------------------------------------------- logos -- */

static LOGOS: Lazy<Mutex<HashMap<String, String>>> = Lazy::new(Default::default);

const IMAGE_TYPES: &[(&str, &str)] = &[
    ("image/png", "png"),
    ("image/jpeg", "jpg"),
    ("image/svg+xml", "svg"),
    ("image/webp", "webp"),
    ("image/gif", "gif"),
];

fn data_url(content_type: &str, bytes: &[u8]) -> String {
    format!("data:{content_type};base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes))
}

fn logo_dir(app: &tauri::AppHandle) -> Option<PathBuf> {
    app.path().app_cache_dir().ok().map(|dir| dir.join("artifacthub-logos"))
}

fn read_cached_logo(dir: &Path, id: &str) -> Option<String> {
    IMAGE_TYPES.iter().find_map(|(content_type, ext)| {
        let bytes = std::fs::read(dir.join(format!("{id}.{ext}"))).ok()?;
        Some(data_url(content_type, &bytes))
    })
}

fn remember(id: &str, url: &str) {
    let mut logos = lock(&LOGOS);
    if logos.len() >= MAX_CACHED_LOGOS {
        logos.clear();
    }
    logos.insert(id.to_string(), url.to_string());
}

/// A chart logo as a data URL, from memory, the disk cache or Artifact Hub.
#[tauri::command]
pub async fn artifacthub_logo(app: tauri::AppHandle, image_id: String) -> Result<String, String> {
    if !valid_id(&image_id) {
        return Err("Invalid image id".into());
    }
    if let Some(url) = lock(&LOGOS).get(&image_id).cloned() {
        return Ok(url);
    }
    let dir = logo_dir(&app);
    if let Some(url) = dir.as_ref().and_then(|d| read_cached_logo(d, &image_id)) {
        remember(&image_id, &url);
        return Ok(url);
    }

    let fetched = fetch(client(&app)?.get(format!("{IMAGE_BASE}/{image_id}")), MAX_LOGO_BYTES, "this logo").await?;
    let content_type = fetched.content_type.split(';').next().unwrap_or_default().trim().to_ascii_lowercase();
    let (content_type, ext) = IMAGE_TYPES
        .iter()
        .find(|(t, _)| *t == content_type)
        .copied()
        .ok_or_else(|| "Artifact Hub sent a logo in an unknown format".to_string())?;
    if let Some(dir) = dir {
        if crate::paths::ensure_private_dir(&dir).is_ok() {
            let _ = std::fs::write(dir.join(format!("{image_id}.{ext}")), &fetched.body);
        }
    }
    let url = data_url(content_type, &fetched.body);
    remember(&image_id, &url);
    Ok(url)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SEARCH: &str = r#"{"packages":[
      {"package_id":"c617753b-3376-40a1-81a1-3ab00e2868ac","name":"postgresql","normalized_name":"postgresql","logo_image_id":"371d5e57-34c4-46ef-909e-658c1502ced8","stars":430,"description":"PostgreSQL (Postgres) is an open source object-relational database.","version":"18.12.4","app_version":"18.6.0","deprecated":false,"signed":true,"ts":1790545046,
       "repository":{"url":"https://charts.bitnami.com/bitnami","kind":0,"name":"bitnami","official":false,"display_name":"Bitnami","verified_publisher":true}},
      {"package_id":"f475c82a-27a5-4f71-8413-fe70d31268a2","name":"cert-manager","logo_image_id":"../../etc","stars":997,"official":true,"cncf":true,"description":"A Helm chart for cert-manager","version":"1.21.2","app_version":"v1.21.2","ts":1789109672,
       "repository":{"url":"https://charts.jetstack.io","kind":0,"name":"cert-manager","official":false,"verified_publisher":true}},
      {"name":"broken"}
    ]}"#;

    #[test]
    fn search_results_are_mapped() {
        let body: Value = serde_json::from_str(SEARCH).unwrap();
        let search = parse_search(&body, Some(376));
        assert_eq!(search.total, 376);
        assert_eq!(search.charts.len(), 2);
        let pg = &search.charts[0];
        assert_eq!(pg.name, "postgresql");
        assert_eq!(pg.repo_name, "bitnami");
        assert_eq!(pg.repo_display_name.as_deref(), Some("Bitnami"));
        assert_eq!(pg.repo_url, "https://charts.bitnami.com/bitnami");
        assert!(pg.verified_publisher && !pg.official && pg.signed);
        assert_eq!(pg.logo_image_id.as_deref(), Some("371d5e57-34c4-46ef-909e-658c1502ced8"));
        let cm = &search.charts[1];
        assert!(cm.official && cm.cncf);
        // Not a UUID: never used in a URL.
        assert_eq!(cm.logo_image_id, None);
    }

    #[test]
    fn packages_carry_versions_newest_first() {
        let body = serde_json::json!({
            "package_id": "c617753b-3376-40a1-81a1-3ab00e2868ac", "name": "postgresql", "version": "18.12.4",
            "home_url": "https://bitnami.com", "readme": "# PostgreSQL", "has_values_schema": false,
            "links": [{ "name": "source", "url": "https://github.com/bitnami/charts" }, { "name": "bad", "url": "javascript:alert(1)" }],
            "available_versions": [
                { "version": "18.12.2", "app_version": "18.6.0", "ts": 100 },
                { "version": "18.12.4", "app_version": "18.6.0", "ts": 300 },
                { "version": "19.0.0-rc.1", "app_version": "19.0.0", "prerelease": true, "ts": 200 }
            ],
            "repository": { "name": "bitnami", "url": "https://charts.bitnami.com/bitnami" }
        });
        let package = parse_package(&body).unwrap();
        let versions: Vec<_> = package.versions.iter().map(|v| v.version.as_str()).collect();
        assert_eq!(versions, vec!["18.12.4", "19.0.0-rc.1", "18.12.2"]);
        assert!(package.versions[1].prerelease);
        assert_eq!(package.links.len(), 1);
        assert_eq!(package.home_url.as_deref(), Some("https://bitnami.com"));
    }

    #[test]
    fn ids_and_segments_are_validated() {
        assert!(valid_id("371d5e57-34c4-46ef-909e-658c1502ced8"));
        assert!(!valid_id("371d5e57-34c4-46ef-909e-658c1502ced"));
        assert!(!valid_id("../../../../../../../../../../etc/passwd"));
        assert!(valid_segment("prometheus-community"));
        assert!(!valid_segment(".."));
        assert!(!valid_segment("a/b"));
        assert!(package_version_url("371d5e57-34c4-46ef-909e-658c1502ced8", "1.0.0", "values").is_ok());
        assert!(package_version_url("371d5e57-34c4-46ef-909e-658c1502ced8", "1.0/../x", "values").is_err());
    }
}

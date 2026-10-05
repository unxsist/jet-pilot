//! Open VSX theme gallery: search the registry for colour-theme extensions
//! and pull the themes out of an extension package (.vsix).
//!
//! The network calls go through Rust so the webview's CSP `connect-src` and
//! the http plugin's URL scope stay untouched. The frontend gets compact DTOs
//! (src/lib/themes/types.ts: `OpenVsxSearchResult`, `OpenVsxInstallResult`)
//! and runs every theme text through its VS Code / TextMate importer.
//!
//! Install safety (modelled on T3 Code's importer):
//! - only MIT-licensed extensions, so JET Pilot stays MIT (the SPDX
//!   expression is evaluated: `MIT OR X` passes, `MIT AND X` and `WITH`
//!   exceptions don't);
//! - the .vsix is streamed with a hard 20 MB cap (Content-Length is not
//!   trusted) and opened in memory;
//! - every file read from the archive is capped (512 KB per theme file) and
//!   so is the total, theme paths may not escape `extension/`;
//! - JSON themes have their `include` chain resolved here (depth 8, cycles
//!   rejected) and are returned as plain JSON (comments and trailing commas
//!   removed); `.tmTheme` files are returned verbatim.

use std::io::{Cursor, Read};
use std::time::Duration;

use serde::Serialize;
use serde_json::{Map, Value};
use tauri_plugin_http::reqwest;

const API_BASE: &str = "https://open-vsx.org/api";
const API_TIMEOUT: Duration = Duration::from_secs(15);
/// The whole .vsix download; stalls are caught earlier by the read timeout.
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(120);

const DEFAULT_PAGE_SIZE: u32 = 24;
const MAX_PAGE_SIZE: u32 = 50;
const MAX_API_BYTES: usize = 2 * 1024 * 1024;
const MAX_VSIX_BYTES: usize = 20 * 1024 * 1024;
const MAX_ZIP_ENTRIES: usize = 5_000;
const MAX_MANIFEST_BYTES: usize = 512 * 1024;
const MAX_THEME_BYTES: usize = 512 * 1024;
/// Everything read from one archive (manifest, themes and their includes).
const MAX_TOTAL_READ_BYTES: usize = 16 * 1024 * 1024;
const MAX_THEMES: usize = 32;
const MAX_INCLUDE_DEPTH: usize = 8;
const MAX_PATH_LEN: usize = 1_024;

/// The only licence a theme may be installed under: JET Pilot stays MIT.
const ALLOWED_LICENSE: &str = "MIT";

const SORTS: &[&str] = &["relevance", "downloadCount", "averageRating", "timestamp"];

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OpenVsxExtension {
    pub namespace: String,
    pub name: String,
    pub display_name: String,
    pub description: String,
    pub version: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub icon_url: Option<String>,
    pub download_count: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub average_rating: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub license: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenVsxSearchResult {
    pub offset: u32,
    pub total_size: u64,
    pub extensions: Vec<OpenVsxExtension>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OpenVsxTheme {
    pub label: String,
    pub ui_theme: String,
    pub path: String,
    pub text: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenVsxInstallResult {
    pub extension: OpenVsxExtension,
    pub themes: Vec<OpenVsxTheme>,
    /// Themes of the extension that could not be read (one line each).
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub warnings: Vec<String>,
}

/* ---------------------------------------------------------------- commands */

/// Searches Open VSX for colour-theme extensions.
///
/// `sort`: "relevance" | "downloadCount" | "averageRating" | "timestamp"
/// (default: relevance, or downloadCount for an empty query). `size`
/// defaults to 24 and is capped at 50. Search results carry no licence.
#[tauri::command]
pub async fn openvsx_search(
    app: tauri::AppHandle,
    query: String,
    sort: Option<String>,
    offset: Option<u32>,
    size: Option<u32>,
) -> Result<OpenVsxSearchResult, String> {
    let query = query.trim().to_string();
    let sort = match sort.as_deref() {
        Some(s) if SORTS.contains(&s) => s.to_string(),
        Some(s) => return Err(format!("Unknown sort order \"{s}\".")),
        None if query.is_empty() => "downloadCount".to_string(),
        None => "relevance".to_string(),
    };
    let offset = offset.unwrap_or(0);
    let size = size.unwrap_or(DEFAULT_PAGE_SIZE).clamp(1, MAX_PAGE_SIZE);

    let client = http_client(&app)?;
    let bytes = get_capped(
        client
            .get(format!("{API_BASE}/-/search"))
            .query(&[
                ("query", query.as_str()),
                ("category", "Themes"),
                ("sortBy", sort.as_str()),
                ("sortOrder", "desc"),
                ("offset", &offset.to_string()),
                ("size", &size.to_string()),
                ("includeAllVersions", "false"),
            ])
            .timeout(API_TIMEOUT),
        MAX_API_BYTES,
        "Open VSX search",
    )
    .await?;
    let value: Value = serde_json::from_slice(&bytes)
        .map_err(|_| "Open VSX returned an unreadable search response.".to_string())?;
    parse_search(&value, offset)
}

/// Downloads an extension (latest version unless `version` is given) and
/// returns its colour themes.
#[tauri::command]
pub async fn openvsx_install(
    app: tauri::AppHandle,
    namespace: String,
    name: String,
    version: Option<String>,
) -> Result<OpenVsxInstallResult, String> {
    if !is_safe_segment(&namespace) || !is_safe_segment(&name) {
        return Err("Invalid extension name.".to_string());
    }
    if let Some(v) = &version {
        if !is_safe_segment(v) {
            return Err("Invalid extension version.".to_string());
        }
    }
    let client = http_client(&app)?;

    let mut url = format!("{API_BASE}/{namespace}/{name}");
    if let Some(v) = &version {
        url.push('/');
        url.push_str(v);
    }
    let bytes = get_capped(
        client.get(&url).timeout(API_TIMEOUT),
        MAX_API_BYTES,
        "Open VSX extension details",
    )
    .await?;
    let detail: Value = serde_json::from_slice(&bytes)
        .map_err(|_| "Open VSX returned unreadable extension details.".to_string())?;
    if let Some(err) = detail.get("error").and_then(Value::as_str) {
        return Err(format!("Open VSX: {err}"));
    }

    let mut extension = extension_from_json(&detail)
        .ok_or_else(|| "Open VSX returned malformed extension details.".to_string())?;
    let license = detail
        .get("license")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or("");
    check_license(license, &extension.display_name)?;
    extension.license = Some(license.to_string());

    let download = detail
        .pointer("/files/download")
        .and_then(Value::as_str)
        .filter(|u| u.starts_with("https://open-vsx.org/"))
        .ok_or_else(|| "Open VSX did not provide a download for this extension.".to_string())?
        .to_string();
    let vsix = get_capped(
        client.get(&download).timeout(DOWNLOAD_TIMEOUT),
        MAX_VSIX_BYTES,
        "The extension package",
    )
    .await?;

    let (themes, warnings) = tauri::async_runtime::spawn_blocking(move || extract_themes(vsix))
        .await
        .map_err(|e| format!("Failed to read the extension package: {e}"))??;

    Ok(OpenVsxInstallResult {
        extension,
        themes,
        warnings,
    })
}

/* --------------------------------------------------------------- transport */

fn http_client(app: &tauri::AppHandle) -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent(format!("JET-Pilot/{}", app.package_info().version))
        // Redirects (e.g. to the download CDN) must stay on https too.
        .https_only(true)
        .connect_timeout(API_TIMEOUT)
        .read_timeout(API_TIMEOUT)
        .build()
        .map_err(|e| format!("Failed to create the HTTP client: {e}"))
}

/// Sends the request and reads the body, failing once it exceeds `limit`
/// bytes (whatever Content-Length claims).
async fn get_capped(
    request: reqwest::RequestBuilder,
    limit: usize,
    what: &str,
) -> Result<Vec<u8>, String> {
    let mut response = request.send().await.map_err(|e| network_error(what, &e))?;
    let status = response.status();
    if status == reqwest::StatusCode::NOT_FOUND {
        return Err(format!("{what} could not be found on Open VSX."));
    }
    if !status.is_success() {
        return Err(format!("{what} is unavailable right now (HTTP {status})."));
    }
    if response
        .content_length()
        .is_some_and(|len| len > limit as u64)
    {
        return Err(too_large(what, limit));
    }
    let mut body = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|e| network_error(what, &e))?
    {
        if body.len() + chunk.len() > limit {
            return Err(too_large(what, limit));
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

fn network_error(what: &str, e: &reqwest::Error) -> String {
    if e.is_timeout() {
        format!("{what}: Open VSX took too long to respond.")
    } else if e.is_connect() {
        format!("{what}: could not connect to Open VSX ({e}).")
    } else {
        format!("{what}: {e}")
    }
}

fn too_large(what: &str, limit: usize) -> String {
    format!("{what} is larger than {} MB.", limit / (1024 * 1024))
}

/* ------------------------------------------------------------ registry DTOs */

fn parse_search(value: &Value, offset: u32) -> Result<OpenVsxSearchResult, String> {
    let list = value
        .get("extensions")
        .and_then(Value::as_array)
        .ok_or_else(|| "Open VSX returned an unreadable search response.".to_string())?;
    let extensions: Vec<_> = list.iter().filter_map(extension_from_json).collect();
    Ok(OpenVsxSearchResult {
        offset: value
            .get("offset")
            .and_then(Value::as_u64)
            .and_then(|o| u32::try_from(o).ok())
            .unwrap_or(offset),
        total_size: value
            .get("totalSize")
            .and_then(Value::as_u64)
            .unwrap_or(extensions.len() as u64),
        extensions,
    })
}

/// Maps a search hit or an extension detail document.
fn extension_from_json(value: &Value) -> Option<OpenVsxExtension> {
    let text = |key: &str| {
        value
            .get(key)
            .and_then(Value::as_str)
            .map(str::trim)
            .unwrap_or("")
            .to_string()
    };
    let namespace = text("namespace");
    let name = text("name");
    let version = text("version");
    if namespace.is_empty() || name.is_empty() || version.is_empty() {
        return None;
    }
    let display_name = Some(text("displayName"))
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| name.clone());
    let license = Some(text("license")).filter(|s| !s.is_empty());
    Some(OpenVsxExtension {
        namespace,
        name,
        display_name,
        description: text("description"),
        version,
        icon_url: value
            .pointer("/files/icon")
            .and_then(Value::as_str)
            .filter(|u| u.starts_with("https://"))
            .map(str::to_string),
        download_count: value
            .get("downloadCount")
            .and_then(Value::as_u64)
            .unwrap_or(0),
        average_rating: value.get("averageRating").and_then(Value::as_f64),
        license,
    })
}

/// Namespace / name / version: a single URL path segment.
fn is_safe_segment(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 128
        && s != "."
        && s != ".."
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '+'))
}

/* ----------------------------------------------------------------- licence */

/// Evaluates an SPDX licence expression: only `MIT` is acceptable
/// (case-insensitive; not MIT-0 or `MIT+`). `X OR Y` passes when either
/// side does (a dual licence: MIT is picked), `X AND Y` only when both do
/// (`AND` binds tighter) and parentheses group. A `WITH` exception is
/// rejected. Anything missing or unparsable is rejected.
pub fn is_allowed_license(spdx: &str) -> bool {
    let Some(tokens) = spdx_tokens(spdx) else {
        return false;
    };
    let mut parser = SpdxParser {
        tokens: &tokens,
        pos: 0,
        depth: 0,
    };
    matches!(parser.or_expr(), Some(true)) && parser.pos == tokens.len()
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum SpdxToken<'a> {
    Open,
    Close,
    Word(&'a str),
}

fn spdx_tokens(expr: &str) -> Option<Vec<SpdxToken<'_>>> {
    if expr.len() > 512 {
        return None;
    }
    let mut tokens = Vec::new();
    let mut rest = expr;
    loop {
        rest = rest.trim_start();
        let Some(c) = rest.chars().next() else {
            break;
        };
        match c {
            '(' => {
                tokens.push(SpdxToken::Open);
                rest = &rest[1..];
            }
            ')' => {
                tokens.push(SpdxToken::Close);
                rest = &rest[1..];
            }
            _ => {
                let end = rest
                    .find(|c: char| c.is_whitespace() || c == '(' || c == ')')
                    .unwrap_or(rest.len());
                tokens.push(SpdxToken::Word(&rest[..end]));
                rest = &rest[end..];
            }
        }
    }
    Some(tokens)
}

struct SpdxParser<'a, 'b> {
    tokens: &'b [SpdxToken<'a>],
    pos: usize,
    depth: usize,
}

impl SpdxParser<'_, '_> {
    fn is_operator(word: &str, operator: &str) -> bool {
        word.eq_ignore_ascii_case(operator)
    }

    fn peek_operator(&self, operator: &str) -> bool {
        matches!(self.tokens.get(self.pos), Some(SpdxToken::Word(w)) if Self::is_operator(w, operator))
    }

    fn or_expr(&mut self) -> Option<bool> {
        let mut allowed = self.and_expr()?;
        while self.peek_operator("OR") {
            self.pos += 1;
            allowed |= self.and_expr()?;
        }
        Some(allowed)
    }

    fn and_expr(&mut self) -> Option<bool> {
        let mut allowed = self.term()?;
        while self.peek_operator("AND") {
            self.pos += 1;
            allowed &= self.term()?;
        }
        Some(allowed)
    }

    fn term(&mut self) -> Option<bool> {
        match *self.tokens.get(self.pos)? {
            SpdxToken::Open => {
                self.depth += 1;
                if self.depth > 16 {
                    return None;
                }
                self.pos += 1;
                let allowed = self.or_expr()?;
                if self.tokens.get(self.pos) != Some(&SpdxToken::Close) {
                    return None;
                }
                self.pos += 1;
                self.depth -= 1;
                Some(allowed)
            }
            SpdxToken::Close => None,
            SpdxToken::Word(word) => {
                Self::license_id(word)?;
                self.pos += 1;
                let mut allowed = word.eq_ignore_ascii_case(ALLOWED_LICENSE);
                if self.peek_operator("WITH") {
                    self.pos += 1;
                    match self.tokens.get(self.pos) {
                        Some(SpdxToken::Word(exception)) if Self::license_id(exception).is_some() => {
                            self.pos += 1;
                            // An exception changes the licence: not plain MIT.
                            allowed = false;
                        }
                        _ => return None,
                    }
                }
                Some(allowed)
            }
        }
    }

    /// A licence (or exception) identifier without its `+`; None for an
    /// operator or something that isn't an identifier.
    fn license_id(word: &str) -> Option<&str> {
        if ["AND", "OR", "WITH"]
            .iter()
            .any(|operator| Self::is_operator(word, operator))
        {
            return None;
        }
        let id = word.strip_suffix('+').unwrap_or(word);
        (!id.is_empty()
            && id
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '.' | ':')))
        .then_some(id)
    }
}

fn check_license(license: &str, display_name: &str) -> Result<(), String> {
    if license.trim().is_empty() {
        return Err(format!(
            "\"{display_name}\" does not declare a licence, so it can't be installed. Only MIT-licensed themes can be installed, so JET Pilot stays MIT."
        ));
    }
    if !is_allowed_license(license) {
        return Err(format!(
            "\"{display_name}\" is licensed under {license}. Only MIT-licensed themes can be installed, so JET Pilot stays MIT."
        ));
    }
    Ok(())
}

/* ----------------------------------------------------------------- archive */

struct Package {
    archive: zip::ZipArchive<Cursor<Vec<u8>>>,
    read_budget: usize,
}

impl Package {
    fn open(bytes: Vec<u8>) -> Result<Self, String> {
        let archive = zip::ZipArchive::new(Cursor::new(bytes))
            .map_err(|e| format!("The extension package could not be opened: {e}"))?;
        if archive.len() > MAX_ZIP_ENTRIES {
            return Err("The extension package has too many files.".to_string());
        }
        Ok(Self {
            archive,
            read_budget: MAX_TOTAL_READ_BYTES,
        })
    }

    /// Reads a UTF-8 file of at most `limit` bytes (counted while
    /// decompressing; the declared size is not trusted).
    fn read_text(&mut self, path: &str, limit: usize) -> Result<String, String> {
        let file = self
            .archive
            .by_name(path)
            .map_err(|_| format!("{path} is missing from the extension package."))?;
        let cap = limit.min(self.read_budget);
        let mut bytes = Vec::new();
        file.take(cap as u64 + 1)
            .read_to_end(&mut bytes)
            .map_err(|e| format!("{path} could not be read: {e}"))?;
        if bytes.len() > cap {
            return Err(if cap < limit {
                "The extension package expands beyond the safe import limit.".to_string()
            } else {
                format!("{path} is larger than {} KB.", limit / 1024)
            });
        }
        self.read_budget -= bytes.len();
        let text = String::from_utf8(bytes).map_err(|_| format!("{path} is not UTF-8 text."))?;
        Ok(text.trim_start_matches('\u{feff}').to_string())
    }
}

/// Resolves `path` (a package-relative path from package.json or an
/// `include`) against `base_dir` (a directory inside the archive, e.g.
/// "extension" or "extension/themes"). The result never leaves `extension/`.
pub fn normalize_package_path(path: &str, base_dir: &str) -> Result<String, String> {
    let path = path.trim();
    if path.is_empty()
        || path.len() > MAX_PATH_LEN
        || path.contains('\0')
        || path.starts_with('/')
        || path.starts_with('\\')
        || path.as_bytes().get(1) == Some(&b':')
        || path.contains("://")
    {
        return Err(format!(
            "\"{path}\" is not a relative path inside the package."
        ));
    }
    let mut segments: Vec<&str> = base_dir.split('/').filter(|s| !s.is_empty()).collect();
    if segments.first() != Some(&"extension") {
        segments.insert(0, "extension");
    }
    for segment in path.split(['/', '\\']) {
        match segment {
            "" | "." => {}
            ".." => {
                if segments.len() <= 1 {
                    return Err(format!("\"{path}\" points outside the extension package."));
                }
                segments.pop();
            }
            s => segments.push(s),
        }
    }
    if segments.len() < 2 {
        return Err(format!("\"{path}\" is not a file inside the package."));
    }
    Ok(segments.join("/"))
}

fn parent_dir(path: &str) -> &str {
    path.rsplit_once('/').map(|(dir, _)| dir).unwrap_or("")
}

fn is_tmtheme(path: &str) -> bool {
    path.to_ascii_lowercase().ends_with(".tmtheme")
}

/// Reads `extension/package.json` and every `contributes.themes[]` entry.
/// Broken entries become warnings; it is an error when none are usable.
pub fn extract_themes(vsix: Vec<u8>) -> Result<(Vec<OpenVsxTheme>, Vec<String>), String> {
    let mut package = Package::open(vsix)?;
    let manifest_text = package.read_text("extension/package.json", MAX_MANIFEST_BYTES)?;
    let manifest = parse_jsonc(&manifest_text)
        .map_err(|e| format!("The extension manifest is not valid JSON: {e}"))?;
    let fallback_label = manifest
        .get("displayName")
        .or_else(|| manifest.get("name"))
        .and_then(Value::as_str)
        .unwrap_or("Theme")
        .to_string();

    let contributions: Vec<&Value> = manifest
        .pointer("/contributes/themes")
        .and_then(Value::as_array)
        .map(|list| list.iter().filter(|v| v.is_object()).collect())
        .unwrap_or_default();
    if contributions.is_empty() {
        let icon_theme = ["/contributes/iconThemes", "/contributes/productIconThemes"]
            .iter()
            .any(|pointer| manifest.pointer(pointer).is_some_and(|v| v.is_array()));
        return Err(if icon_theme {
            "This extension has no colour themes (it is an icon theme).".to_string()
        } else {
            "This extension has no colour themes (it may be an icon theme).".to_string()
        });
    }
    if contributions.len() > MAX_THEMES {
        return Err(format!(
            "This extension contains {} colour themes; at most {MAX_THEMES} can be imported at once.",
            contributions.len()
        ));
    }

    let mut themes = Vec::new();
    let mut warnings = Vec::new();
    for contribution in contributions {
        let label = contribution
            .get("label")
            .or_else(|| contribution.get("id"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or(&fallback_label)
            .to_string();
        let ui_theme = contribution
            .get("uiTheme")
            .and_then(Value::as_str)
            .unwrap_or("vs-dark")
            .to_string();
        let result = contribution
            .get("path")
            .and_then(Value::as_str)
            .ok_or_else(|| "no theme file path".to_string())
            .and_then(|p| normalize_package_path(p, "extension"))
            .and_then(|path| {
                let text = if is_tmtheme(&path) {
                    package.read_text(&path, MAX_THEME_BYTES)?
                } else {
                    let merged = load_theme(&mut package, &path, &mut Vec::new())?;
                    serde_json::to_string_pretty(&merged).map_err(|e| e.to_string())?
                };
                if text.len() > MAX_THEME_BYTES {
                    return Err(format!(
                        "{path} is larger than {} KB.",
                        MAX_THEME_BYTES / 1024
                    ));
                }
                Ok(OpenVsxTheme {
                    label: label.clone(),
                    ui_theme: ui_theme.clone(),
                    path: path.trim_start_matches("extension/").to_string(),
                    text,
                })
            });
        match result {
            Ok(theme) => themes.push(theme),
            Err(e) => warnings.push(format!("{label}: {e}")),
        }
    }

    if themes.is_empty() {
        return Err(format!(
            "None of the extension's themes could be read ({}).",
            warnings.join("; ")
        ));
    }
    Ok((themes, warnings))
}

/// Loads a JSON colour theme and merges its `include` chain into it:
/// the included theme first, then this file's `colors` /
/// `semanticTokenColors` override it and its `tokenColors` follow the
/// included ones (VS Code's order).
fn load_theme(package: &mut Package, path: &str, stack: &mut Vec<String>) -> Result<Value, String> {
    if stack.iter().any(|p| p == path) {
        return Err(format!("the include chain of {path} has a cycle"));
    }
    if stack.len() > MAX_INCLUDE_DEPTH {
        return Err(format!(
            "includes are nested more than {MAX_INCLUDE_DEPTH} deep"
        ));
    }
    if is_tmtheme(path) {
        return Err(format!("{path}: including .tmTheme files is not supported"));
    }
    let text = package.read_text(path, MAX_THEME_BYTES)?;
    let Value::Object(mut theme) = parse_jsonc(&text).map_err(|e| format!("{path}: {e}"))? else {
        return Err(format!("{path} is not a JSON object"));
    };
    let Some(include) = theme.remove("include") else {
        return Ok(Value::Object(theme));
    };
    let Some(include) = include.as_str() else {
        return Err(format!("{path}: \"include\" must be a path"));
    };
    let include_path = normalize_package_path(include, parent_dir(path))?;

    stack.push(path.to_string());
    let base = load_theme(package, &include_path, stack)?;
    stack.pop();

    Ok(merge_theme(base, theme))
}

fn merge_theme(base: Value, over: Map<String, Value>) -> Value {
    let Value::Object(mut merged) = base else {
        return Value::Object(over);
    };
    for (key, value) in over {
        let replacement = match (key.as_str(), value) {
            ("colors" | "semanticTokenColors", Value::Object(src)) => match merged.get_mut(&key) {
                Some(Value::Object(dst)) => {
                    dst.extend(src);
                    None
                }
                _ => Some(Value::Object(src)),
            },
            ("tokenColors", Value::Array(src)) => match merged.get_mut(&key) {
                Some(Value::Array(dst)) => {
                    dst.extend(src);
                    None
                }
                _ => Some(Value::Array(src)),
            },
            (_, value) => Some(value),
        };
        if let Some(value) = replacement {
            merged.insert(key, value);
        }
    }
    Value::Object(merged)
}

/* ------------------------------------------------------------------- JSONC */

/// Parses JSON with comments and trailing commas (VS Code's JSONC).
pub fn parse_jsonc(text: &str) -> Result<Value, String> {
    serde_json::from_str(&strip_jsonc(text)).map_err(|e| e.to_string())
}

/// Blanks out `//` and `/* */` comments (keeping newlines, so serde's
/// line numbers stay right) and drops commas directly before `}` / `]`.
fn strip_jsonc(text: &str) -> String {
    let text = text.trim_start_matches('\u{feff}');
    let chars: Vec<char> = text.chars().collect();
    let mut out = String::with_capacity(text.len());
    // Index in `out` of the last comma outside a string that has only
    // whitespace after it so far.
    let mut pending_comma: Option<usize> = None;
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        match c {
            '"' => {
                pending_comma = None;
                out.push(c);
                i += 1;
                while i < chars.len() {
                    let s = chars[i];
                    out.push(s);
                    i += 1;
                    if s == '\\' {
                        if let Some(&escaped) = chars.get(i) {
                            out.push(escaped);
                            i += 1;
                        }
                    } else if s == '"' {
                        break;
                    }
                }
            }
            '/' if chars.get(i + 1) == Some(&'/') => {
                while i < chars.len() && chars[i] != '\n' {
                    i += 1;
                }
            }
            '/' if chars.get(i + 1) == Some(&'*') => {
                i += 2;
                while i < chars.len() && !(chars[i] == '*' && chars.get(i + 1) == Some(&'/')) {
                    if chars[i] == '\n' {
                        out.push('\n');
                    }
                    i += 1;
                }
                i += 2;
                out.push(' ');
            }
            ',' => {
                pending_comma = Some(out.len());
                out.push(c);
                i += 1;
            }
            '}' | ']' => {
                if let Some(at) = pending_comma.take() {
                    out.replace_range(at..at + 1, " ");
                }
                out.push(c);
                i += 1;
            }
            c if c.is_whitespace() => {
                out.push(c);
                i += 1;
            }
            _ => {
                pending_comma = None;
                out.push(c);
                i += 1;
            }
        }
    }
    out
}

/* ------------------------------------------------------------------- tests */

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use zip::write::SimpleFileOptions;

    fn vsix(files: &[(&str, &str)]) -> Vec<u8> {
        let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
        let options =
            SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        for (name, contents) in files {
            writer.start_file(*name, options).unwrap();
            writer.write_all(contents.as_bytes()).unwrap();
        }
        writer.finish().unwrap().into_inner()
    }

    const MANIFEST: &str = r#"{
        "name": "nightfall",
        "displayName": "Nightfall",
        "license": "MIT",
        "contributes": {
            "themes": [
                { "label": "Nightfall Dark", "uiTheme": "vs-dark", "path": "./themes/dark.json" },
                { "label": "Nightfall Light", "uiTheme": "vs", "path": "themes/light.json" },
            ]
        }
    }"#;

    const BASE: &str = r##"{
        // shared palette
        "name": "Nightfall Base",
        "type": "dark",
        "colors": { "editor.background": "#000000", "editor.foreground": "#eeeeee" },
        "tokenColors": [{ "scope": "comment", "settings": { "foreground": "#777777" } }],
    }"##;

    const DARK: &str = r##"{
        /* overrides the base */
        "include": "./base/common.json",
        "name": "Nightfall Dark",
        "colors": {
            "editor.background": "#101010", // darker
            "terminal.ansiRed": "#ff5555",
        },
        "tokenColors": [{ "scope": "string", "settings": { "foreground": "#a5d6a7" } }],
    }"##;

    const LIGHT: &str = r##"{
        "name": "Nightfall Light",
        "type": "light",
        "colors": { "editor.background": "#ffffff", "url": "https://example.com/a//b" }
    }"##;

    fn nightfall() -> Vec<u8> {
        vsix(&[
            ("extension/package.json", MANIFEST),
            ("extension/themes/dark.json", DARK),
            ("extension/themes/light.json", LIGHT),
            ("extension/themes/base/common.json", BASE),
        ])
    }

    fn json(theme: &OpenVsxTheme) -> Value {
        serde_json::from_str(&theme.text).expect("theme text is plain JSON")
    }

    #[test]
    fn extracts_both_themes_with_labels_and_paths() {
        let (themes, warnings) = extract_themes(nightfall()).unwrap();
        assert!(warnings.is_empty(), "{warnings:?}");
        assert_eq!(themes.len(), 2);
        assert_eq!(themes[0].label, "Nightfall Dark");
        assert_eq!(themes[0].ui_theme, "vs-dark");
        assert_eq!(themes[0].path, "themes/dark.json");
        assert_eq!(themes[1].label, "Nightfall Light");
        assert_eq!(themes[1].ui_theme, "vs");
        let light = json(&themes[1]);
        assert_eq!(light["colors"]["url"], "https://example.com/a//b");
    }

    #[test]
    fn merges_include_chain() {
        let (themes, _) = extract_themes(nightfall()).unwrap();
        let dark = json(&themes[0]);
        assert!(dark.get("include").is_none());
        assert_eq!(dark["name"], "Nightfall Dark");
        assert_eq!(dark["type"], "dark", "keys of the included file are kept");
        assert_eq!(dark["colors"]["editor.background"], "#101010");
        assert_eq!(dark["colors"]["editor.foreground"], "#eeeeee");
        assert_eq!(dark["colors"]["terminal.ansiRed"], "#ff5555");
        let scopes: Vec<_> = dark["tokenColors"]
            .as_array()
            .unwrap()
            .iter()
            .map(|t| t["scope"].as_str().unwrap())
            .collect();
        assert_eq!(scopes, ["comment", "string"], "included rules come first");
    }

    #[test]
    fn rejects_include_cycles_and_deep_chains() {
        let cyclic = vsix(&[
            (
                "extension/package.json",
                r#"{"contributes":{"themes":[{"label":"A","path":"a.json"}]}}"#,
            ),
            ("extension/a.json", r#"{"include":"b.json"}"#),
            ("extension/b.json", r#"{"include":"./a.json"}"#),
        ]);
        let err = extract_themes(cyclic).unwrap_err();
        assert!(err.contains("cycle"), "{err}");

        let mut files = vec![(
            "extension/package.json".to_string(),
            r#"{"contributes":{"themes":[{"label":"Deep","path":"t0.json"}]}}"#.to_string(),
        )];
        for i in 0..12 {
            files.push((
                format!("extension/t{i}.json"),
                format!(r#"{{"include":"t{}.json"}}"#, i + 1),
            ));
        }
        files.push(("extension/t12.json".to_string(), "{}".to_string()));
        let refs: Vec<(&str, &str)> = files
            .iter()
            .map(|(a, b)| (a.as_str(), b.as_str()))
            .collect();
        let err = extract_themes(vsix(&refs)).unwrap_err();
        assert!(err.contains("nested"), "{err}");
    }

    #[test]
    fn rejects_path_traversal() {
        assert!(normalize_package_path("../package.json", "extension").is_err());
        assert!(normalize_package_path("themes/../../x.json", "extension").is_err());
        assert!(normalize_package_path("/etc/passwd", "extension").is_err());
        assert!(normalize_package_path("C:\\x.json", "extension").is_err());
        assert!(normalize_package_path("..\\..\\x.json", "extension/themes").is_err());
        assert_eq!(
            normalize_package_path("./themes/a.json", "extension").unwrap(),
            "extension/themes/a.json"
        );
        assert_eq!(
            normalize_package_path("../base.json", "extension/themes").unwrap(),
            "extension/base.json"
        );

        let escape = vsix(&[
            (
                "extension/package.json",
                r#"{"contributes":{"themes":[
                    {"label":"Bad","path":"../../secret.json"},
                    {"label":"Good","path":"good.json"}
                ]}}"#,
            ),
            ("extension/good.json", r#"{"include":"../outside.json"}"#),
            ("secret.json", "{}"),
        ]);
        let err = extract_themes(escape).unwrap_err();
        assert!(err.contains("Bad") && err.contains("outside"), "{err}");
        assert!(err.contains("Good"), "{err}");
    }

    #[test]
    fn broken_themes_become_warnings() {
        let pack = vsix(&[
            (
                "extension/package.json",
                r#"{"contributes":{"themes":[
                    {"label":"Ok","uiTheme":"vs","path":"ok.json"},
                    {"label":"Missing","path":"missing.json"},
                    {"label":"Broken","path":"broken.json"}
                ]}}"#,
            ),
            ("extension/ok.json", r#"{"colors":{}}"#),
            ("extension/broken.json", r#"{"colors": oops}"#),
        ]);
        let (themes, warnings) = extract_themes(pack).unwrap();
        assert_eq!(themes.len(), 1);
        assert_eq!(warnings.len(), 2, "{warnings:?}");
        assert!(warnings[0].starts_with("Missing:"));
        assert!(warnings[1].starts_with("Broken:"));
    }

    #[test]
    fn returns_tmtheme_verbatim() {
        let plist = "<?xml version=\"1.0\"?>\n<plist version=\"1.0\"><dict></dict></plist>\n";
        let pack = vsix(&[
            (
                "extension/package.json",
                r#"{"contributes":{"themes":[{"label":"Classic","uiTheme":"vs-dark","path":"./Classic.tmTheme"}]}}"#,
            ),
            ("extension/Classic.tmTheme", plist),
        ]);
        let (themes, _) = extract_themes(pack).unwrap();
        assert_eq!(themes[0].path, "Classic.tmTheme");
        assert_eq!(themes[0].text, plist);
    }

    #[test]
    fn enforces_size_caps() {
        let huge = format!(r#"{{"name":"{}"}}"#, "x".repeat(MAX_THEME_BYTES));
        let pack = vsix(&[
            (
                "extension/package.json",
                r#"{"contributes":{"themes":[{"label":"Huge","path":"huge.json"}]}}"#,
            ),
            ("extension/huge.json", &huge),
        ]);
        let err = extract_themes(pack).unwrap_err();
        assert!(err.contains("larger than 512 KB"), "{err}");

        let many: Vec<String> = (0..=MAX_THEMES)
            .map(|i| format!(r#"{{"label":"T{i}","path":"t.json"}}"#))
            .collect();
        let manifest = format!(r#"{{"contributes":{{"themes":[{}]}}}}"#, many.join(","));
        let pack = vsix(&[
            ("extension/package.json", &manifest),
            ("extension/t.json", "{}"),
        ]);
        let err = extract_themes(pack).unwrap_err();
        assert!(err.contains("at most 32"), "{err}");
    }

    #[test]
    fn rejects_non_theme_extensions_and_garbage() {
        let pack = vsix(&[("extension/package.json", r#"{"name":"x"}"#)]);
        assert_eq!(
            extract_themes(pack).unwrap_err(),
            "This extension has no colour themes (it may be an icon theme)."
        );
        let pack = vsix(&[(
            "extension/package.json",
            r#"{"name":"catppuccin-vsc-icons","contributes":{"iconThemes":[{"id":"x","path":"x.json"}]}}"#,
        )]);
        assert_eq!(
            extract_themes(pack).unwrap_err(),
            "This extension has no colour themes (it is an icon theme)."
        );
        assert!(extract_themes(b"not a zip".to_vec()).is_err());
        let pack = vsix(&[("extension/readme.md", "hi")]);
        assert!(extract_themes(pack).unwrap_err().contains("package.json"));
    }

    #[test]
    fn license_allowlist() {
        for ok in [
            "MIT",
            "mit",
            "MIT OR Apache-2.0",
            "(MIT OR GPL-3.0)",
            "(GPL-2.0 OR MIT)",
            "mit or gpl-3.0",
            "GPL-3.0 OR MIT AND MIT",
            "((MIT))",
            "MIT AND MIT",
        ] {
            assert!(is_allowed_license(ok), "{ok}");
        }
        for bad in [
            "",
            "   ",
            "Apache-2.0",
            "ISC",
            "BSD-3-Clause",
            "BSD-2-Clause",
            "MPL-2.0",
            "Unlicense",
            "CC0-1.0",
            "0BSD",
            "Zlib",
            "MIT-0",
            "MIT+",
            "GPL-3.0",
            "SEE LICENSE IN LICENSE.md",
            "Proprietary",
            "MIT AND Apache-2.0",
            "MIT AND GPL-3.0",
            "MITX",
            "GPL-3.0 AND (MIT OR Apache-2.0)",
            "(MIT OR Apache-2.0) AND ISC",
            "(MIT OR Apache-2.0) AND GPL-3.0",
            "MIT AND GPL-3.0 OR ISC AND GPL-2.0",
            "MIT WITH Some-exception",
            "GPL-3.0 WITH Classpath-exception-2.0",
            "MIT OR",
            "OR MIT",
            "(MIT",
            "MIT)",
            "()",
            "MIT ISC",
            "MIT WITH",
            "MIT AND (",
            "MIT/Apache-2.0",
            "SEE LICENSE IN MIT",
        ] {
            assert!(!is_allowed_license(bad), "{bad}");
        }
        let err = check_license("Apache-2.0", "Some Theme").unwrap_err();
        assert_eq!(
            err,
            "\"Some Theme\" is licensed under Apache-2.0. Only MIT-licensed themes can be installed, so JET Pilot stays MIT."
        );
        assert!(check_license("", "Some Theme")
            .unwrap_err()
            .contains("does not declare a licence"));
        assert!(check_license("MIT OR Apache-2.0", "Some Theme").is_ok());
    }

    #[test]
    fn jsonc_comments_and_trailing_commas() {
        let value = parse_jsonc(
            "\u{feff}{\n // c\n \"a\": \"// not a comment\", /* b */ \"b\": [1, 2,],\n \"c\": \"\\\"/*\",\n}",
        )
        .unwrap();
        assert_eq!(value["a"], "// not a comment");
        assert_eq!(value["b"], serde_json::json!([1, 2]));
        assert_eq!(value["c"], "\"/*");
        assert!(parse_jsonc("{\"a\": 1 /* unterminated").is_err());
    }

    #[test]
    fn maps_search_results() {
        let value = serde_json::json!({
            "offset": 0,
            "totalSize": 2,
            "extensions": [
                {
                    "namespace": "catppuccin",
                    "name": "catppuccin-vsc",
                    "displayName": "Catppuccin for VSCode",
                    "description": "Soothing pastel theme",
                    "version": "3.17.0",
                    "downloadCount": 123456,
                    "averageRating": 4.8,
                    "files": { "icon": "https://open-vsx.org/icon.png", "download": "https://open-vsx.org/x.vsix" }
                },
                { "namespace": "broken" }
            ]
        });
        let result = parse_search(&value, 0).unwrap();
        assert_eq!(result.total_size, 2);
        assert_eq!(result.extensions.len(), 1);
        let ext = serde_json::to_value(&result.extensions[0]).unwrap();
        assert_eq!(ext["displayName"], "Catppuccin for VSCode");
        assert_eq!(ext["iconUrl"], "https://open-vsx.org/icon.png");
        assert_eq!(ext["downloadCount"], 123456);
        assert!(ext.get("license").is_none(), "absent licence is omitted");
    }

    #[test]
    fn validates_url_segments() {
        assert!(is_safe_segment("catppuccin-vsc"));
        assert!(is_safe_segment("1.2.3+build"));
        assert!(!is_safe_segment(".."));
        assert!(!is_safe_segment("a/b"));
        assert!(!is_safe_segment("a?b"));
        assert!(!is_safe_segment(""));
    }
}

//! kubectl and helm through a cluster's proxy: the invocation gets a private
//! single-context kubeconfig (`kubectl config view --minify --flatten`, like
//! the terminal's) whose cluster has `proxy-url` set. Only the API server
//! connection goes through the proxy; `HTTPS_PROXY` would also send exec
//! credential plugins (aws, gcloud) through it, and they don't all speak
//! SOCKS. It also wins over a `proxy-url` in the user's kubeconfig, which
//! `HTTPS_PROXY` wouldn't.
//!
//! The files are cached per cluster, proxy and kubeconfig version, removed
//! when the route changes and when the app quits, and swept at startup
//! (`shell::tty::sweep_stale_temp_kubeconfigs`).

use once_cell::sync::Lazy;
use serde_json::Value;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::SystemTime;
use tracing::warn;
use uuid::Uuid;

use crate::util::lock;

pub const TEMP_PREFIX: &str = "jet-pilot-proxied-";
pub const TEMP_SUFFIX: &str = ".json";

/// The `--kubeconfig` and `--context` (`--kube-context` for helm) of an argv,
/// as `--flag=value` or `--flag value`. Arguments after `--` belong to the
/// command run in the container, not to kubectl.
pub fn target(args: &[String]) -> (Option<String>, Option<String>) {
    let mut kube_config = None;
    let mut context = None;
    let mut iter = args.iter();
    while let Some(arg) = iter.next() {
        if arg == "--" {
            break;
        }
        let (name, inline) = match arg.split_once('=') {
            Some((name, value)) => (name, Some(value.to_string())),
            None => (arg.as_str(), None),
        };
        let slot = match name {
            "--kubeconfig" => &mut kube_config,
            "--context" | "--kube-context" => &mut context,
            _ => continue,
        };
        *slot = inline.or_else(|| iter.next().cloned());
    }
    (kube_config, context)
}

/// `args` with `--kubeconfig` pointing at `kubeconfig`: replaced where it was
/// given, else added in front (global flags may come before the command).
pub fn with_kubeconfig(args: &[String], kubeconfig: &Path) -> Vec<String> {
    let flag = format!("--kubeconfig={}", kubeconfig.display());
    let mut out = Vec::with_capacity(args.len() + 1);
    let mut replaced = false;
    let mut iter = args.iter();
    while let Some(arg) = iter.next() {
        if arg == "--" {
            out.push(arg.clone());
            out.extend(iter.by_ref().cloned());
            break;
        }
        if arg == "--kubeconfig" {
            iter.next();
            out.push(flag.clone());
            replaced = true;
        } else if arg.starts_with("--kubeconfig=") {
            out.push(flag.clone());
            replaced = true;
        } else {
            out.push(arg.clone());
        }
    }
    if !replaced {
        out.insert(0, flag);
    }
    out
}

/// A minified kubeconfig (JSON) with `proxy-url` on its cluster(s).
pub fn with_proxy_url(minified: &[u8], proxy: &str) -> Result<Vec<u8>, String> {
    let mut config: Value =
        serde_json::from_slice(minified).map_err(|e| format!("kubectl printed an unreadable kubeconfig: {e}"))?;
    let clusters = config
        .get_mut("clusters")
        .and_then(Value::as_array_mut)
        .filter(|clusters| !clusters.is_empty())
        .ok_or("The context has no cluster")?;
    for cluster in clusters {
        if let Some(fields) = cluster.get_mut("cluster").and_then(Value::as_object_mut) {
            fields.insert("proxy-url".to_string(), Value::String(proxy.to_string()));
        }
    }
    serde_json::to_vec_pretty(&config).map_err(|e| e.to_string())
}

/// `kubectl config view` argv of the minified context, as JSON.
pub fn minify_args(kube_config: &str, context: &str) -> Vec<String> {
    let mut args = crate::shell::tty::minify_kubeconfig_args(kube_config, context);
    args.push("--output=json".to_string());
    args
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct Key {
    kube_config: String,
    context: String,
    proxy: String,
    stamp: Option<SystemTime>,
}

static FILES: Lazy<Mutex<HashMap<Key, PathBuf>>> = Lazy::new(|| Mutex::new(HashMap::new()));

/// The private kubeconfig of `context` in `kube_config` with `proxy-url` set
/// to `proxy`, written on first use.
pub async fn kubeconfig(kube_config: &str, context: &str, proxy: &str) -> Result<PathBuf, String> {
    let key = Key {
        kube_config: kube_config.to_string(),
        context: context.to_string(),
        proxy: proxy.to_string(),
        stamp: crate::kubernetes::client::kubeconfig_stamp(kube_config),
    };
    if let Some(path) = lock(&FILES).get(&key).filter(|path| path.exists()) {
        return Ok(path.clone());
    }

    let mut cmd = crate::process::command("kubectl");
    cmd.args(minify_args(kube_config, context));
    let output = crate::process::run_with_timeout(cmd, std::time::Duration::from_secs(30))
        .await
        .map_err(|e| format!("Couldn't run kubectl: {e}"))?;
    if !output.status.success() {
        return Err(format!(
            "kubectl couldn't read context {context}: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    let contents = with_proxy_url(&output.stdout, proxy)?;
    let path = std::env::temp_dir().join(format!("{TEMP_PREFIX}{}{TEMP_SUFFIX}", Uuid::new_v4()));
    crate::shell::tty::write_private_file(&path, &contents)
        .map_err(|e| format!("Couldn't write a kubeconfig for the proxy: {e}"))?;

    let previous = {
        let mut files = lock(&FILES);
        // Older versions of the same cluster's file are stale now.
        let stale: Vec<Key> = files
            .keys()
            .filter(|k| k.kube_config == key.kube_config && k.context == key.context)
            .cloned()
            .collect();
        let previous: Vec<PathBuf> = stale.iter().filter_map(|k| files.remove(k)).collect();
        files.insert(key, path.clone());
        previous
    };
    remove(&previous);
    Ok(path)
}

fn remove(paths: &[PathBuf]) {
    for path in paths {
        if let Err(e) = std::fs::remove_file(path) {
            if e.kind() != std::io::ErrorKind::NotFound {
                warn!("Failed to remove {}: {}", path.display(), e);
            }
        }
    }
}

/// Removes the files of the clusters `matches` selects (kubeconfig, context).
pub fn forget(matches: impl Fn(&str, &str) -> bool) {
    let paths: Vec<PathBuf> = {
        let mut files = lock(&FILES);
        let keys: Vec<Key> = files.keys().filter(|k| matches(&k.kube_config, &k.context)).cloned().collect();
        keys.iter().filter_map(|k| files.remove(k)).collect()
    };
    remove(&paths);
}

/// Removes every file (app exit).
pub fn forget_all() {
    forget(|_, _| true);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(args: &[&str]) -> Vec<String> {
        args.iter().map(|a| a.to_string()).collect()
    }

    #[test]
    fn target_reads_both_flag_forms_and_stops_at_double_dash() {
        assert_eq!(
            target(&s(&["get", "pods", "--context=prod", "--kubeconfig", "/k/config"])),
            (Some("/k/config".into()), Some("prod".into()))
        );
        assert_eq!(target(&s(&["list", "--kube-context", "prod"])), (None, Some("prod".into())));
        assert_eq!(
            target(&s(&["exec", "-it", "api", "--context=prod", "--", "env", "--context=evil"])),
            (None, Some("prod".into()))
        );
        assert_eq!(target(&s(&["version"])), (None, None));
    }

    #[test]
    fn kubeconfig_is_replaced_or_added_before_double_dash() {
        let path = Path::new("/tmp/p.json");
        assert_eq!(
            with_kubeconfig(&s(&["get", "pods", "--kubeconfig", "/k/config", "--context=prod"]), path),
            s(&["get", "pods", "--kubeconfig=/tmp/p.json", "--context=prod"])
        );
        assert_eq!(
            with_kubeconfig(&s(&["get", "--kubeconfig=/k/config"]), path),
            s(&["get", "--kubeconfig=/tmp/p.json"])
        );
        assert_eq!(
            with_kubeconfig(&s(&["exec", "api", "--context=prod", "--", "cat", "--kubeconfig=x"]), path),
            s(&["--kubeconfig=/tmp/p.json", "exec", "api", "--context=prod", "--", "cat", "--kubeconfig=x"])
        );
    }

    #[test]
    fn proxy_url_is_set_on_the_cluster() {
        let minified = br#"{
            "apiVersion": "v1",
            "kind": "Config",
            "clusters": [{ "name": "prod", "cluster": { "server": "https://10.0.0.1", "proxy-url": "http://old:3128" } }],
            "contexts": [{ "name": "prod", "context": { "cluster": "prod", "user": "me" } }],
            "current-context": "prod",
            "users": [{ "name": "me", "user": { "token": "secret" } }]
        }"#;
        let out: Value = serde_json::from_slice(&with_proxy_url(minified, "socks5://127.0.0.1:41000").unwrap()).unwrap();
        assert_eq!(out["clusters"][0]["cluster"]["proxy-url"], "socks5://127.0.0.1:41000");
        assert_eq!(out["clusters"][0]["cluster"]["server"], "https://10.0.0.1");
        assert_eq!(out["users"][0]["user"]["token"], "secret");
        assert_eq!(out["current-context"], "prod");

        assert!(with_proxy_url(br#"{"clusters": []}"#, "socks5://x:1").is_err());
        assert!(with_proxy_url(b"not json", "socks5://x:1").is_err());
    }

    #[test]
    fn minify_asks_for_json() {
        let args = minify_args("/k/config", "prod");
        assert_eq!(args.last().map(String::as_str), Some("--output=json"));
        assert!(args.contains(&"--flatten".to_string()));
    }
}

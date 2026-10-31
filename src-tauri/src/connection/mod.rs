//! How the app reaches each cluster: directly (the default, where a
//! `proxy-url` in the kubeconfig keeps working), through a SOCKS5 or
//! HTTP(S) proxy, or through an SSH jump host (`ssh.rs`).
//!
//! The settings live in the frontend (state.json `clusters[].connection`) and
//! are pushed here with `cluster_connections_set`; a setting replaces the
//! kubeconfig's `proxy-url`. Everything that talks to a cluster asks `route`:
//! - kube-rs clients set it as `Config::proxy_url` (`build_client`), which
//!   covers watches, API calls, logs, exec and native port forwards;
//! - kubectl and helm runs get a private kubeconfig with `proxy-url`
//!   (`cli_args`, `cli.rs`);
//! - local terminals get that `proxy-url` too, and `HTTPS_PROXY` for HTTP
//!   proxies (`terminal_env`).

pub mod cli;
pub mod ssh;

use once_cell::sync::{Lazy, OnceCell};
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, RwLock};
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tracing::info;

pub use ssh::{Lease, SshSpec, TunnelState};

use crate::kubernetes::client::{read_kubeconfig, resolve_kubeconfig_path};
use crate::util::{read, write};

const EVENT: &str = "cluster-connection://changed";
/// A tunnel nothing holds and no active context uses stops after this.
const IDLE: Duration = Duration::from_secs(90);
const REAP_EVERY: Duration = Duration::from_secs(15);

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(tag = "mode", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum Connection {
    /// `socks5://`, `http://` or `https://`.
    Proxy { url: String },
    Ssh(SshSpec),
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionEntry {
    /// "" = this context name in any kubeconfig.
    pub kube_config: String,
    pub context: String,
    pub connection: Connection,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Target {
    pub kube_config: String,
    pub context: String,
}

#[derive(Default)]
struct Registry {
    entries: Vec<ConnectionEntry>,
    active: Vec<Target>,
}

static REGISTRY: Lazy<RwLock<Registry>> = Lazy::new(|| RwLock::new(Registry::default()));
/// Any entries at all: the common case (none) skips every lookup.
static CONFIGURED: AtomicBool = AtomicBool::new(false);
static APP: OnceCell<AppHandle> = OnceCell::new();

/// Whether an entry applies to (resolved kubeconfig path, context). A
/// wildcard entry applies to the context in every kubeconfig; a client of
/// the default kubeconfig resolution ("") to every entry of that context.
fn applies(entry_kube_config: &str, entry_context: &str, kube_config: &str, context: &str) -> bool {
    entry_context == context && (entry_kube_config.is_empty() || kube_config.is_empty() || entry_kube_config == kube_config)
}

/// The entry for a cluster: an exact kubeconfig match before a wildcard.
pub fn find<'a>(entries: &'a [ConnectionEntry], kube_config: &str, context: &str) -> Option<&'a ConnectionEntry> {
    entries
        .iter()
        .find(|e| e.context == context && e.kube_config == kube_config)
        .or_else(|| entries.iter().find(|e| applies(&e.kube_config, &e.context, kube_config, context)))
}

fn setting(kube_config: &str, context: &str) -> Option<Connection> {
    if !CONFIGURED.load(Ordering::Relaxed) {
        return None;
    }
    find(&read(&REGISTRY).entries, kube_config, context).map(|e| e.connection.clone())
}

pub fn validate_proxy_url(url: &str) -> Result<http::Uri, String> {
    let url = url.trim();
    let uri: http::Uri = url.parse().map_err(|_| format!("'{url}' isn't a proxy URL"))?;
    if !matches!(uri.scheme_str(), Some("socks5" | "http" | "https")) {
        return Err("Use a socks5://, http:// or https:// proxy URL".to_string());
    }
    if uri.host().is_none_or(str::is_empty) {
        return Err(format!("'{url}' has no host"));
    }
    Ok(uri)
}

/// `host:port` of a proxy URL, without credentials.
pub fn proxy_host(url: &str) -> String {
    match url.trim().parse::<http::Uri>() {
        Ok(uri) => match (uri.host(), uri.port_u16()) {
            (Some(host), Some(port)) => format!("{host}:{port}"),
            (Some(host), None) => host.to_string(),
            _ => url.to_string(),
        },
        Err(_) => url.to_string(),
    }
}

/// The proxy a cluster is reached through right now. `lease` keeps an SSH
/// tunnel up; long-running users (port forwards, terminals) hold on to it.
pub struct Route {
    pub url: String,
    pub lease: Option<Lease>,
}

/// The route of (resolved kubeconfig path, context): None when it connects
/// directly (or through the kubeconfig's own `proxy-url`). Starts the SSH
/// tunnel on first use.
pub async fn route(kube_config: &str, context: &str) -> Result<Option<Route>, String> {
    match setting(kube_config, context) {
        None => Ok(None),
        Some(Connection::Proxy { url }) => {
            validate_proxy_url(&url)?;
            Ok(Some(Route { url: url.trim().to_string(), lease: None }))
        }
        Some(Connection::Ssh(spec)) => {
            let (port, lease) =
                ssh::ensure(&spec).await.map_err(|e| format!("Couldn't connect through {}: {e}", spec.host_name()))?;
            Ok(Some(Route { url: format!("socks5://127.0.0.1:{port}"), lease: Some(lease) }))
        }
    }
}

/// A proxied kubeconfig for kubectl, with the SSH tunnel held while it lives.
#[derive(Debug)]
pub struct Routed {
    pub kubeconfig: String,
    pub lease: Option<Lease>,
}

/// The proxied kubeconfig of (resolved kubeconfig path, context), or None
/// when it connects directly.
pub async fn routed_kubeconfig(kube_config: &str, context: &str) -> Result<Option<Routed>, String> {
    let Some(route) = route(kube_config, context).await? else {
        return Ok(None);
    };
    let path = cli::kubeconfig(kube_config, context, &route.url).await?;
    Ok(Some(Routed { kubeconfig: path.to_string_lossy().into_owned(), lease: route.lease }))
}

/// A kubectl / helm argv (without the program) routed like the app's own
/// clients; unchanged for clusters without a connection setting.
pub async fn cli_args(args: Vec<String>) -> Result<(Vec<String>, Option<Lease>), String> {
    if !CONFIGURED.load(Ordering::Relaxed) {
        return Ok((args, None));
    }
    let (kube_config, context) = cli::target(&args);
    let Some(context) = context else {
        return Ok((args, None));
    };
    let kube_config = resolve_kubeconfig_path(kube_config.as_deref());
    match routed_kubeconfig(&kube_config, &context).await? {
        None => Ok((args, None)),
        Some(routed) => Ok((cli::with_kubeconfig(&args, std::path::Path::new(&routed.kubeconfig)), routed.lease)),
    }
}

/// Extra environment for a local terminal: HTTP proxies as `HTTPS_PROXY`
/// too, for tools that don't read the kubeconfig. SOCKS isn't exported:
/// cloud CLIs started as credential plugins don't all speak it.
pub fn terminal_env(proxy_url: &str) -> Vec<(String, String)> {
    let url = proxy_url.trim();
    if url.starts_with("http://") || url.starts_with("https://") {
        ["HTTPS_PROXY", "https_proxy"].iter().map(|key| (key.to_string(), url.to_string())).collect()
    } else {
        Vec::new()
    }
}

/// Clients, kubeconfigs and watches of the clusters `matches` selects are
/// rebuilt with their (new) route.
fn reroute(matches: impl Fn(&str, &str) -> bool + Clone + Send + 'static) {
    crate::kubernetes::client::invalidate_clients_matching(matches.clone());
    cli::forget(matches.clone());
    tauri::async_runtime::spawn(async move {
        let restarted = crate::watch::restart_matching(matches).await;
        if restarted > 0 {
            info!("Restarted {} watch(es) with a new connection route", restarted);
        }
    });
}

/// Matches the clusters of `entries` (kubeconfig, context pairs).
fn matcher(entries: Vec<(String, String)>) -> impl Fn(&str, &str) -> bool + Clone + Send + 'static {
    move |kube_config: &str, context: &str| entries.iter().any(|(k, c)| applies(k, c, kube_config, context))
}

/// The clusters routed through the tunnel of `spec`.
fn users_of(spec: &SshSpec) -> Vec<(String, String)> {
    read(&REGISTRY)
        .entries
        .iter()
        .filter(|e| matches!(&e.connection, Connection::Ssh(s) if s == spec))
        .map(|e| (e.kube_config.clone(), e.context.clone()))
        .collect()
}

struct Events;

impl ssh::Observer for Events {
    fn state_changed(&self, _spec: &SshSpec) {
        if let Some(app) = APP.get() {
            let _ = app.emit(EVENT, ());
        }
    }

    /// Clients built for the old port would keep failing.
    fn port_changed(&self, spec: &SshSpec) {
        reroute(matcher(users_of(spec)));
    }
}

pub fn init(app: &AppHandle) {
    let _ = APP.set(app.clone());
    ssh::set_observer(Arc::new(Events));
    tauri::async_runtime::spawn(async {
        loop {
            tokio::time::sleep(REAP_EVERY).await;
            let stopped = ssh::reap(IDLE, |spec| {
                let registry = read(&REGISTRY);
                registry.active.iter().any(|t| {
                    matches!(find(&registry.entries, &t.kube_config, &t.context),
                        Some(ConnectionEntry { connection: Connection::Ssh(s), .. }) if s == spec)
                })
            });
            for spec in stopped {
                let users = matcher(users_of(&spec));
                crate::kubernetes::client::invalidate_clients_matching(users.clone());
                cli::forget(users);
            }
        }
    });
}

/// App exit: no ssh processes or proxied kubeconfigs are left behind.
pub fn shutdown() {
    ssh::stop_all();
    cli::forget_all();
}

/// The connection settings of every cluster that has one (the others
/// connect directly).
#[tauri::command]
pub fn cluster_connections_set(entries: Vec<ConnectionEntry>) {
    let (changed, orphaned) = {
        let mut registry = write(&REGISTRY);
        let changed: Vec<(String, String)> = registry
            .entries
            .iter()
            .filter(|old| !entries.contains(old))
            .chain(entries.iter().filter(|new| !registry.entries.contains(new)))
            .map(|e| (e.kube_config.clone(), e.context.clone()))
            .collect();
        let orphaned: Vec<SshSpec> = registry
            .entries
            .iter()
            .filter_map(|old| match &old.connection {
                Connection::Ssh(spec) if !entries.iter().any(|e| e.connection == old.connection) => Some(spec.clone()),
                _ => None,
            })
            .collect();
        CONFIGURED.store(!entries.is_empty(), Ordering::Relaxed);
        registry.entries = entries;
        (changed, orphaned)
    };
    for spec in &orphaned {
        ssh::stop(spec);
    }
    if !changed.is_empty() {
        info!("Connection settings changed for {} cluster(s)", changed.len());
        reroute(matcher(changed));
    }
}

/// The active contexts: their SSH tunnels stay up while they're active.
#[tauri::command]
pub fn cluster_connections_active(targets: Vec<Target>) {
    write(&REGISTRY).active = targets;
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionStatus {
    /// "direct", "proxy" or "ssh".
    pub mode: &'static str,
    /// What it goes through, for "Through bastion.example.com".
    pub via: Option<String>,
    /// The SSH tunnel; None until it's first used.
    pub tunnel: Option<TunnelState>,
    /// The kubeconfig's own `proxy-url` (host only), used when direct.
    pub kubeconfig_proxy: Option<String>,
}

fn kubeconfig_proxy(kube_config: &str, context: &str) -> Option<String> {
    let config = read_kubeconfig(Some(kube_config)).ok()?;
    let cluster = config.contexts.iter().find(|c| c.name == context)?.context.as_ref()?.cluster.clone();
    let url = config.clusters.iter().find(|c| c.name == cluster)?.cluster.as_ref()?.proxy_url.clone()?;
    Some(proxy_host(&url))
}

#[tauri::command]
pub fn cluster_connection_status(context: String, kube_config: Option<String>) -> ConnectionStatus {
    let kube_config = resolve_kubeconfig_path(kube_config.as_deref());
    match setting(&kube_config, &context) {
        None => ConnectionStatus {
            mode: "direct",
            via: None,
            tunnel: None,
            kubeconfig_proxy: kubeconfig_proxy(&kube_config, &context),
        },
        Some(Connection::Proxy { url }) => {
            ConnectionStatus { mode: "proxy", via: Some(proxy_host(&url)), tunnel: None, kubeconfig_proxy: None }
        }
        Some(Connection::Ssh(spec)) => ConnectionStatus {
            mode: "ssh",
            via: Some(spec.host_name().to_string()),
            tunnel: ssh::state_of(&spec),
            kubeconfig_proxy: None,
        },
    }
}

/// Connects (or reconnects right away, after a failure) a cluster's SSH
/// tunnel ("Connect" / "Try again" in the hub).
#[tauri::command]
pub async fn cluster_connection_connect(context: String, kube_config: Option<String>) -> Result<(), String> {
    let kube_config = resolve_kubeconfig_path(kube_config.as_deref());
    if let Some(Connection::Ssh(spec)) = setting(&kube_config, &context) {
        ssh::retry(&spec);
    }
    route(&kube_config, &context).await.map(|_| ())
}

/// kubectl / helm arguments for the frontend's own runs (`runCli`):
/// `--kubeconfig` points at a proxied copy when the cluster has a route.
#[tauri::command]
pub async fn cluster_cli_args(args: Vec<String>) -> Result<Vec<String>, String> {
    cli_args(args).await.map(|(args, _)| args)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(kube_config: &str, context: &str, connection: Connection) -> ConnectionEntry {
        ConnectionEntry { kube_config: kube_config.into(), context: context.into(), connection }
    }

    fn proxy(url: &str) -> Connection {
        Connection::Proxy { url: url.into() }
    }

    #[test]
    fn exact_entries_win_over_wildcards() {
        let entries = vec![
            entry("", "prod", proxy("http://any:3128")),
            entry("/k/a", "prod", proxy("http://a:3128")),
        ];
        assert_eq!(find(&entries, "/k/a", "prod").unwrap().connection, proxy("http://a:3128"));
        assert_eq!(find(&entries, "/k/b", "prod").unwrap().connection, proxy("http://any:3128"));
        assert!(find(&entries, "/k/a", "staging").is_none());

        let exact_only = vec![entry("/k/a", "prod", proxy("http://a:3128"))];
        assert!(find(&exact_only, "/k/b", "prod").is_none());
        // A client of the default kubeconfig resolution.
        assert!(find(&exact_only, "", "prod").is_some());
    }

    #[test]
    fn settings_deserialize_from_the_frontend_shape() {
        let entries: Vec<ConnectionEntry> = serde_json::from_value(serde_json::json!([
            { "kubeConfig": "/k/a", "context": "prod", "connection": { "mode": "proxy", "url": "socks5://p:1080" } },
            { "kubeConfig": "", "context": "edge", "connection": {
                "mode": "ssh", "host": "ops@bastion", "port": 2222, "identityFile": "~/.ssh/b", "jump": null } },
        ]))
        .unwrap();
        assert_eq!(entries[0].connection, proxy("socks5://p:1080"));
        assert_eq!(
            entries[1].connection,
            Connection::Ssh(SshSpec {
                host: "ops@bastion".into(),
                port: Some(2222),
                identity_file: Some("~/.ssh/b".into()),
                jump: None,
            })
        );
    }

    #[test]
    fn proxy_urls_are_checked() {
        for ok in ["socks5://127.0.0.1:1080", "http://proxy.corp:3128", " https://user:pw@proxy.corp "] {
            assert!(validate_proxy_url(ok).is_ok(), "{ok}");
        }
        for bad in ["socks4://p:1", "proxy.corp:3128", "ftp://p", "", "http://"] {
            assert!(validate_proxy_url(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn proxy_host_hides_credentials() {
        assert_eq!(proxy_host("http://user:secret@proxy.corp:3128"), "proxy.corp:3128");
        assert_eq!(proxy_host("socks5://10.0.0.5"), "10.0.0.5");
    }

    #[test]
    fn terminals_get_https_proxy_for_http_proxies_only() {
        assert_eq!(
            terminal_env("http://proxy.corp:3128"),
            vec![
                ("HTTPS_PROXY".to_string(), "http://proxy.corp:3128".to_string()),
                ("https_proxy".to_string(), "http://proxy.corp:3128".to_string()),
            ]
        );
        assert!(terminal_env("socks5://127.0.0.1:41000").is_empty());
    }

    /// kube-rs really goes through a SOCKS5 proxy set on the client config:
    /// a tiny SOCKS server sees the CONNECT for the API server's host name
    /// (resolved on the far side, like a bastion does) and relays to a fake
    /// API server.
    #[tokio::test]
    async fn kube_clients_connect_through_socks5() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        use tokio::net::{TcpListener, TcpStream};

        // A plain-HTTP "API server" answering /version.
        let api = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let api_port = api.local_addr().unwrap().port();
        tokio::spawn(async move {
            while let Ok((mut stream, _)) = api.accept().await {
                tokio::spawn(async move {
                    let mut buf = [0u8; 4096];
                    let _ = stream.read(&mut buf).await;
                    let body = r#"{"major":"1","minor":"32","gitVersion":"v1.32.0","gitCommit":"","gitTreeState":"","buildDate":"","goVersion":"","compiler":"","platform":"linux/amd64"}"#;
                    let response = format!(
                        "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\n\r\n{}",
                        body.len(),
                        body
                    );
                    let _ = stream.write_all(response.as_bytes()).await;
                });
            }
        });

        // A SOCKS5 server (no auth, CONNECT by domain name) that records the
        // requested host and relays to the API server.
        let socks = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let socks_port = socks.local_addr().unwrap().port();
        let (seen_tx, mut seen_rx) = tokio::sync::mpsc::unbounded_channel::<String>();
        tokio::spawn(async move {
            while let Ok((mut client, _)) = socks.accept().await {
                let seen_tx = seen_tx.clone();
                tokio::spawn(async move {
                    let mut greeting = [0u8; 2];
                    client.read_exact(&mut greeting).await.unwrap();
                    let mut methods = vec![0u8; greeting[1] as usize];
                    client.read_exact(&mut methods).await.unwrap();
                    client.write_all(&[5, 0]).await.unwrap();
                    let mut head = [0u8; 4];
                    client.read_exact(&mut head).await.unwrap();
                    assert_eq!(head[1], 1, "CONNECT");
                    let host = match head[3] {
                        3 => {
                            let mut len = [0u8; 1];
                            client.read_exact(&mut len).await.unwrap();
                            let mut name = vec![0u8; len[0] as usize];
                            client.read_exact(&mut name).await.unwrap();
                            String::from_utf8(name).unwrap()
                        }
                        1 => {
                            let mut ip = [0u8; 4];
                            client.read_exact(&mut ip).await.unwrap();
                            std::net::Ipv4Addr::from(ip).to_string()
                        }
                        other => panic!("address type {other}"),
                    };
                    let mut port = [0u8; 2];
                    client.read_exact(&mut port).await.unwrap();
                    seen_tx.send(format!("{host}:{}", u16::from_be_bytes(port))).unwrap();
                    client.write_all(&[5, 0, 0, 1, 127, 0, 0, 1, 0, 0]).await.unwrap();
                    let mut upstream = TcpStream::connect(("127.0.0.1", api_port)).await.unwrap();
                    let _ = tokio::io::copy_bidirectional(&mut client, &mut upstream).await;
                });
            }
        });

        // Only reachable through the proxy: the name doesn't resolve here.
        let mut config = kube::Config::new(format!("http://api.cluster.internal:{api_port}").parse().unwrap());
        config.proxy_url = Some(format!("socks5://127.0.0.1:{socks_port}").parse().unwrap());
        let client = kube::Client::try_from(config).unwrap();
        let version = client.apiserver_version().await.unwrap();
        assert_eq!(version.git_version, "v1.32.0");
        assert_eq!(seen_rx.recv().await.unwrap(), format!("api.cluster.internal:{api_port}"));
    }
}

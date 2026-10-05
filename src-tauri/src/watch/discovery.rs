//! Resolves the resource names the frontend uses (`pods`, `deployments`,
//! `deployments.apps`, CRD plurals, ...) to an `ApiResource` the way kubectl
//! does, using a per-context discovery cache.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use kube::discovery::{verbs, ApiCapabilities, ApiResource, Discovery, Scope};
use kube::Client;
use once_cell::sync::Lazy;
use tokio::sync::OnceCell;
use tracing::{debug, warn};

use crate::util::lock;

/// A served resource (at its group's preferred version).
#[derive(Debug, Clone)]
pub struct Candidate {
    pub group: String,
    pub ar: ApiResource,
    pub namespaced: bool,
    pub watchable: bool,
}

type Candidates = Arc<Vec<Candidate>>;

struct CachedDiscovery {
    fetched: Instant,
    cell: Arc<OnceCell<Candidates>>,
}

/// Discovery is refreshed after this long, or earlier (but at most every
/// `MISS_REFRESH`) when a resource can't be found, e.g. a CRD that was just
/// installed. The frontend only asks for resources its own discovery listed,
/// so a miss almost always means this cache is stale: refresh quickly (with
/// 20 s, a new CRD's list fell back to kubectl polling for its lifetime).
const DISCOVERY_TTL: Duration = Duration::from_secs(10 * 60);
const MISS_REFRESH: Duration = Duration::from_secs(2);

static CACHE: Lazy<Mutex<HashMap<(String, String), CachedDiscovery>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

/// kubectl-like group priority: the core group, then the built-in groups,
/// then everything else (CRDs, aggregated APIs) alphabetically.
fn group_rank(group: &str) -> (u8, String) {
    let rank = if group.is_empty() {
        0
    } else if !group.contains('.') || group.ends_with(".k8s.io") {
        1
    } else {
        2
    };
    (rank, group.to_string())
}

fn candidates_from(discovery: &Discovery) -> Vec<Candidate> {
    let mut groups: Vec<_> = discovery.groups().collect();
    groups.sort_by_key(|g| group_rank(g.name()));

    groups
        .into_iter()
        .flat_map(|group| {
            let name = group.name().to_string();
            group
                .recommended_resources()
                .into_iter()
                .map(move |(ar, caps): (ApiResource, ApiCapabilities)| Candidate {
                    group: name.clone(),
                    namespaced: caps.scope == Scope::Namespaced,
                    watchable: caps.supports_operation(verbs::WATCH)
                        && caps.supports_operation(verbs::LIST),
                    ar,
                })
        })
        .collect()
}

async fn run_discovery(client: Client) -> Result<Candidates, kube::Error> {
    let started = Instant::now();
    // Aggregated discovery (k8s >= 1.26): two requests instead of one per
    // API group. Older servers fall back to the classic walk.
    let discovery = match Discovery::new(client.clone()).run_aggregated().await {
        Ok(discovery) => discovery,
        Err(err) => {
            debug!("Aggregated discovery unavailable ({}), using legacy discovery", err);
            Discovery::new(client).run().await?
        }
    };
    let candidates = candidates_from(&discovery);
    debug!(
        "Discovered {} resources in {:?}",
        candidates.len(),
        started.elapsed()
    );
    Ok(Arc::new(candidates))
}

async fn discover(
    client: &Client,
    key: &(String, String),
    force_if_older_than: Option<Duration>,
) -> Result<Candidates, kube::Error> {
    let cell = {
        let mut cache = lock(&CACHE);
        let stale = cache.get(key).is_none_or(|cached| {
            let age = cached.fetched.elapsed();
            age > DISCOVERY_TTL
                || force_if_older_than.is_some_and(|max| age > max && cached.cell.initialized())
        });
        if stale {
            cache.insert(
                key.clone(),
                CachedDiscovery {
                    fetched: Instant::now(),
                    cell: Arc::new(OnceCell::new()),
                },
            );
        }
        cache[key].cell.clone()
    };

    cell.get_or_try_init(|| run_discovery(client.clone()))
        .await
        .cloned()
}

/// Finds the resource the frontend means by `resource` (a plural name,
/// optionally `plural.group`) and `kind`, preferring the core group and
/// built-in groups like kubectl does.
pub fn find<'a>(candidates: &'a [Candidate], resource: &str, kind: Option<&str>) -> Option<&'a Candidate> {
    let resource = resource.trim().to_lowercase();
    let (plural, group) = match resource.split_once('.') {
        Some((plural, group)) => (plural.to_string(), Some(group.to_string())),
        None => (resource.clone(), None),
    };
    let kind = kind.map(str::to_lowercase).filter(|k| !k.is_empty());

    let in_group = |c: &&Candidate| group.as_ref().is_none_or(|g| &c.group == g);

    let by_plural_and_kind = |c: &&Candidate| {
        c.ar.plural == plural && kind.as_ref().is_none_or(|k| &c.ar.kind.to_lowercase() == k)
    };

    candidates
        .iter()
        .filter(in_group)
        .find(by_plural_and_kind)
        .or_else(|| candidates.iter().filter(in_group).find(|c| c.ar.plural == plural))
        .or_else(|| {
            let kind = kind.clone().unwrap_or_else(|| plural.clone());
            candidates
                .iter()
                .filter(in_group)
                .find(|c| c.ar.kind.to_lowercase() == kind)
        })
}

/// Resolves `resource` for the client of `cache_key` (kubeconfig, context).
pub async fn resolve(
    client: &Client,
    cache_key: (String, String),
    resource: &str,
    kind: Option<&str>,
) -> Result<Candidate, String> {
    let candidates = discover(client, &cache_key, None)
        .await
        .map_err(|err| format!("API discovery failed: {err}"))?;
    if let Some(found) = find(&candidates, resource, kind) {
        return Ok(found.clone());
    }

    // Possibly a CRD installed after the last discovery run.
    let candidates = discover(client, &cache_key, Some(MISS_REFRESH))
        .await
        .map_err(|err| format!("API discovery failed: {err}"))?;
    find(&candidates, resource, kind).cloned().ok_or_else(|| {
        warn!("Resource {} not found via discovery", resource);
        format!("the server doesn't have a resource type \"{resource}\"")
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use kube::core::GroupVersionKind;

    fn candidate(group: &str, version: &str, kind: &str, plural: &str) -> Candidate {
        Candidate {
            group: group.into(),
            ar: ApiResource::from_gvk_with_plural(&GroupVersionKind::gvk(group, version, kind), plural),
            namespaced: true,
            watchable: true,
        }
    }

    fn candidates() -> Vec<Candidate> {
        let mut list = vec![
            candidate("cert-manager.io", "v1", "Certificate", "certificates"),
            candidate("events.k8s.io", "v1", "Event", "events"),
            candidate("", "v1", "Event", "events"),
            candidate("", "v1", "Pod", "pods"),
            candidate("apps", "v1", "Deployment", "deployments"),
            candidate("networking.k8s.io", "v1", "NetworkPolicy", "networkpolicies"),
            candidate("example.com", "v1", "Deployment", "deployments"),
        ];
        list.sort_by_key(|c| group_rank(&c.group));
        list
    }

    #[test]
    fn prefers_core_then_builtin_groups() {
        let list = candidates();
        assert_eq!(find(&list, "events", None).unwrap().group, "");
        assert_eq!(find(&list, "deployments", Some("Deployment")).unwrap().group, "apps");
    }

    #[test]
    fn supports_plural_dot_group() {
        let list = candidates();
        assert_eq!(find(&list, "events.events.k8s.io", None).unwrap().group, "events.k8s.io");
        assert_eq!(find(&list, "deployments.example.com", None).unwrap().group, "example.com");
    }

    #[test]
    fn falls_back_to_kind_and_crds() {
        let list = candidates();
        assert_eq!(find(&list, "NetworkPolicies", None).unwrap().ar.kind, "NetworkPolicy");
        assert_eq!(find(&list, "certificate", Some("Certificate")).unwrap().group, "cert-manager.io");
        assert!(find(&list, "widgets", Some("Widget")).is_none());
    }
}

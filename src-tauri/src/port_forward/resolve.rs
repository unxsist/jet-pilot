//! Which pod (and container port) a forward talks to.
//!
//! A pod target is used as is; a deployment resolves through its selector to
//! a ready pod; a service resolves through its EndpointSlices (the pods the
//! service itself would send traffic to), falling back to its selector when
//! the slices can't be read. A service port's `targetPort` is translated to
//! the container port, named ports included.

use std::collections::BTreeSet;

use k8s_openapi::api::apps::v1::Deployment;
use k8s_openapi::api::core::v1::{Pod, Service, ServicePort};
use k8s_openapi::api::discovery::v1::EndpointSlice;
use k8s_openapi::apimachinery::pkg::apis::meta::v1::LabelSelector;
use k8s_openapi::apimachinery::pkg::util::intstr::IntOrString;
use kube::api::{Api, ListParams};
use kube::Client;

use super::machine::{Failure, FailureKind};
use crate::auth::center::AuthFailure;
use crate::kubernetes::client::auth_error_message;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TargetKind {
    Pod,
    Deployment,
    Service,
}

impl TargetKind {
    /// The object types kubectl accepts for these kinds.
    pub fn parse(object_type: &str) -> Option<TargetKind> {
        match object_type.to_ascii_lowercase().as_str() {
            "pod" | "pods" | "po" => Some(TargetKind::Pod),
            "deployment" | "deployments" | "deploy" => Some(TargetKind::Deployment),
            "service" | "services" | "svc" => Some(TargetKind::Service),
            _ => None,
        }
    }
}

/* Why a forward stopped using its pod (shown as "Reconnected · <reason>"). */
pub const LOST_REPLACED: &str = "pod was replaced";
pub const LOST_DELETED: &str = "pod was deleted";
pub const LOST_SHUTTING_DOWN: &str = "pod is shutting down";
pub const LOST_NOT_READY: &str = "pod stopped being ready";
pub const LOST_STOPPED: &str = "pod stopped";
pub const LOST_BROKEN: &str = "connection to the pod broke";
pub const LOST_CLUSTER: &str = "lost the connection to the cluster";

/// A ready pod with all conditions a forward needs: running, ready and not
/// on its way out.
pub fn pod_ready(pod: &Pod) -> bool {
    pod.metadata.deletion_timestamp.is_none()
        && pod_phase(pod) == "Running"
        && pod
            .status
            .as_ref()
            .and_then(|s| s.conditions.as_ref())
            .is_some_and(|conditions| conditions.iter().any(|c| c.type_ == "Ready" && c.status == "True"))
}

fn pod_phase(pod: &Pod) -> &str {
    pod.status.as_ref().and_then(|s| s.phase.as_deref()).unwrap_or("Unknown")
}

/// Why `pod` can't (or shouldn't) carry the forward anymore. `strict` is
/// for pods picked behind a deployment or service: those move on when the
/// pod stops being ready, like the service's own traffic would. A pod the
/// user picked is kept as long as it runs.
pub fn lost_reason(pod: &Pod, strict: bool) -> Option<&'static str> {
    if pod.metadata.deletion_timestamp.is_some() {
        return Some(LOST_SHUTTING_DOWN);
    }
    match pod_phase(pod) {
        "Succeeded" | "Failed" => return Some(LOST_STOPPED),
        _ => {}
    }
    if strict && !pod_ready(pod) {
        return Some(LOST_NOT_READY);
    }
    None
}

/// The label selector of a deployment as a `labelSelector` query value.
/// `None` for a selector that selects nothing useful (empty).
pub fn selector_string(selector: &LabelSelector) -> Option<String> {
    let mut parts: Vec<String> = selector
        .match_labels
        .iter()
        .flatten()
        .map(|(k, v)| format!("{k}={v}"))
        .collect();
    for expression in selector.match_expressions.iter().flatten() {
        let values = expression.values.clone().unwrap_or_default().join(",");
        parts.push(match expression.operator.as_str() {
            "In" => format!("{} in ({values})", expression.key),
            "NotIn" => format!("{} notin ({values})", expression.key),
            "Exists" => expression.key.clone(),
            "DoesNotExist" => format!("!{}", expression.key),
            _ => continue,
        });
    }
    (!parts.is_empty()).then(|| parts.join(","))
}

/// The port of `service` a forward to `port` means.
pub fn service_port(service: &Service, port: u16) -> Result<&ServicePort, Failure> {
    let name = service.metadata.name.as_deref().unwrap_or("service");
    service
        .spec
        .as_ref()
        .and_then(|spec| spec.ports.as_ref())
        .and_then(|ports| ports.iter().find(|p| p.port == i32::from(port)))
        .ok_or_else(|| Failure::new(FailureKind::Invalid, format!("Service {name} has no port {port}")))
}

/// A container port of `pod` by name.
pub fn container_port_by_name(pod: &Pod, name: &str) -> Option<u16> {
    pod.spec
        .as_ref()?
        .containers
        .iter()
        .flat_map(|c| c.ports.iter().flatten())
        .find(|p| p.name.as_deref() == Some(name))
        .and_then(|p| u16::try_from(p.container_port).ok())
}

/// The container port a service port sends traffic to on `pod`: its
/// `targetPort` (a number, or a container port name), else the port itself.
pub fn target_port(port: &ServicePort, pod: &Pod) -> Option<u16> {
    match &port.target_port {
        Some(IntOrString::Int(n)) => u16::try_from(*n).ok(),
        Some(IntOrString::String(name)) => match name.parse::<u16>() {
            Ok(n) => Some(n),
            Err(_) => container_port_by_name(pod, name),
        },
        None => u16::try_from(port.port).ok(),
    }
}

/// Ready, non-terminating pods behind a service port according to its
/// EndpointSlices, with the container port each one listens on.
pub fn slice_candidates(slices: &[EndpointSlice], port_name: Option<&str>) -> Vec<(String, u16)> {
    let wanted = port_name.unwrap_or("");
    let mut out: Vec<(String, u16)> = Vec::new();
    for slice in slices {
        let Some(port) = slice
            .ports
            .iter()
            .flatten()
            .find(|p| p.name.as_deref().unwrap_or("") == wanted)
            .and_then(|p| p.port)
            .and_then(|p| u16::try_from(p).ok())
        else {
            continue;
        };
        for endpoint in &slice.endpoints {
            let conditions = endpoint.conditions.as_ref();
            // Unset `ready` means ready (EndpointSlice API).
            let ready = conditions.and_then(|c| c.ready).unwrap_or(true);
            let terminating = conditions.and_then(|c| c.terminating).unwrap_or(false);
            let Some(target) = endpoint.target_ref.as_ref() else { continue };
            if !ready || terminating || target.kind.as_deref() != Some("Pod") {
                continue;
            }
            if let Some(name) = &target.name {
                if !out.iter().any(|(pod, _)| pod == name) {
                    out.push((name.clone(), port));
                }
            }
        }
    }
    out
}

/// Picks a pod: the current one while it's still a candidate (no needless
/// moves), else the first by name that isn't the one just lost.
pub fn pick<'a>(candidates: &'a [String], current: Option<&str>, avoid: Option<&str>) -> Option<&'a String> {
    if let Some(current) = current {
        if let Some(found) = candidates.iter().find(|c| c.as_str() == current) {
            return Some(found);
        }
    }
    let sorted: BTreeSet<&String> = candidates.iter().collect();
    sorted
        .iter()
        .copied()
        .find(|c| Some(c.as_str()) != avoid)
        .or_else(|| sorted.iter().copied().next())
}

/// Maps a kube error onto what the forward should do about it.
pub fn classify(err: &kube::Error) -> Failure {
    use kube::client::UpgradeConnectionError;
    if let Some(failure) = AuthFailure::of_kube_error(err) {
        return Failure::new(FailureKind::Auth, failure.message.clone());
    }
    let by_code = |code: u16, message: &str| -> Option<Failure> {
        match code {
            401 => Some(Failure::new(
                FailureKind::Auth,
                "The cluster didn't accept your credentials. Sign in again.",
            )),
            403 => Some(Failure::new(
                FailureKind::Forbidden,
                if message.is_empty() {
                    "You don't have permission to port-forward here".to_string()
                } else {
                    message.to_string()
                },
            )),
            404 => Some(Failure::new(FailureKind::NotFound, message.to_string())),
            _ => None,
        }
    };
    match err {
        kube::Error::Auth(auth) => Failure::new(FailureKind::Auth, auth_error_message(auth)),
        kube::Error::Api(status) => by_code(status.code, &status.message)
            .unwrap_or_else(|| Failure::new(FailureKind::Unreachable, status.message.clone())),
        kube::Error::UpgradeConnection(UpgradeConnectionError::ProtocolSwitch(code)) => by_code(code.as_u16(), "")
            .unwrap_or_else(|| {
                Failure::new(
                    FailureKind::Unsupported,
                    format!("The cluster refused the WebSocket port-forward (HTTP {})", code.as_u16()),
                )
            }),
        kube::Error::UpgradeConnection(e) => Failure::new(
            FailureKind::Unsupported,
            format!("The cluster refused the WebSocket port-forward ({e})"),
        ),
        other => Failure::new(FailureKind::Unreachable, other.to_string()),
    }
}

/// Resolves a forward's target to a pod and container port.
pub struct Resolver {
    pub client: Client,
    pub namespace: String,
    pub kind: TargetKind,
    pub name: String,
    pub remote_port: u16,
}

impl Resolver {
    pub fn pods(&self) -> Api<Pod> {
        Api::namespaced(self.client.clone(), &self.namespace)
    }

    /// A pod for the forward: `current` is kept while it's still ready,
    /// `avoid` (the pod just lost) is only used when nothing else is.
    pub async fn resolve(&self, current: Option<&str>, avoid: Option<&str>) -> Result<(String, u16), Failure> {
        match self.kind {
            TargetKind::Pod => {
                let pod = self.pods().get(&self.name).await.map_err(|e| self.not_found(&e, "Pod"))?;
                if pod.metadata.deletion_timestamp.is_some() || pod_phase(&pod) != "Running" {
                    return Err(Failure::new(
                        FailureKind::NoReadyPod,
                        format!("Pod {} is {}", self.name, pod_phase(&pod).to_lowercase()),
                    ));
                }
                Ok((self.name.clone(), self.remote_port))
            }
            TargetKind::Deployment => {
                let deployments: Api<Deployment> = Api::namespaced(self.client.clone(), &self.namespace);
                let deployment = deployments
                    .get(&self.name)
                    .await
                    .map_err(|e| self.not_found(&e, "Deployment"))?;
                let selector = deployment
                    .spec
                    .as_ref()
                    .and_then(|s| selector_string(&s.selector))
                    .ok_or_else(|| {
                        Failure::new(FailureKind::Invalid, format!("Deployment {} has no pod selector", self.name))
                    })?;
                let pods = self.ready_pods(&selector).await?;
                let names: Vec<String> = pods.iter().filter_map(|p| p.metadata.name.clone()).collect();
                let pod = pick(&names, current, avoid).ok_or_else(|| self.no_ready_pods("deployment"))?;
                Ok((pod.clone(), self.remote_port))
            }
            TargetKind::Service => self.resolve_service(current, avoid).await,
        }
    }

    async fn resolve_service(&self, current: Option<&str>, avoid: Option<&str>) -> Result<(String, u16), Failure> {
        let services: Api<Service> = Api::namespaced(self.client.clone(), &self.namespace);
        let service = services.get(&self.name).await.map_err(|e| self.not_found(&e, "Service"))?;
        let port = service_port(&service, self.remote_port)?.clone();

        let slices: Api<EndpointSlice> = Api::namespaced(self.client.clone(), &self.namespace);
        let by_slices = slices
            .list(&ListParams::default().labels(&format!("kubernetes.io/service-name={}", self.name)))
            .await;
        if let Ok(list) = by_slices {
            let candidates = slice_candidates(&list.items, port.name.as_deref());
            let names: Vec<String> = candidates.iter().map(|(pod, _)| pod.clone()).collect();
            if let Some(pod) = pick(&names, current, avoid) {
                let port = candidates.iter().find(|(p, _)| p == pod).map(|(_, port)| *port).unwrap_or(self.remote_port);
                return Ok((pod.clone(), port));
            }
            if !list.items.is_empty() {
                return Err(self.no_ready_pods("service"));
            }
        }

        // No slices (or not allowed to read them): the service's selector.
        let selector = service
            .spec
            .as_ref()
            .and_then(|s| s.selector.as_ref())
            .filter(|s| !s.is_empty())
            .map(|s| s.iter().map(|(k, v)| format!("{k}={v}")).collect::<Vec<_>>().join(","))
            .ok_or_else(|| {
                Failure::new(
                    FailureKind::Invalid,
                    format!("Service {} has no selector, so there's no pod to forward to", self.name),
                )
            })?;
        let pods = self.ready_pods(&selector).await?;
        let names: Vec<String> = pods.iter().filter_map(|p| p.metadata.name.clone()).collect();
        let name = pick(&names, current, avoid).ok_or_else(|| self.no_ready_pods("service"))?;
        let pod = pods.iter().find(|p| p.metadata.name.as_ref() == Some(name)).expect("picked from pods");
        let container_port = target_port(&port, pod).ok_or_else(|| {
            Failure::new(
                FailureKind::Invalid,
                format!("Pod {name} has no container port for service port {}", self.remote_port),
            )
        })?;
        Ok((name.clone(), container_port))
    }

    async fn ready_pods(&self, selector: &str) -> Result<Vec<Pod>, Failure> {
        let list = self
            .pods()
            .list(&ListParams::default().labels(selector))
            .await
            .map_err(|e| classify(&e))?;
        Ok(list.items.into_iter().filter(pod_ready).collect())
    }

    fn not_found(&self, err: &kube::Error, kind: &str) -> Failure {
        let failure = classify(err);
        if failure.kind == FailureKind::NotFound {
            Failure::new(
                FailureKind::NotFound,
                format!("{kind} {} doesn't exist in {}", self.name, self.namespace),
            )
        } else {
            failure
        }
    }

    fn no_ready_pods(&self, kind: &str) -> Failure {
        Failure::new(FailureKind::NoReadyPod, format!("Waiting for a ready pod behind {kind} {}", self.name))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use k8s_openapi::api::core::v1::{Container, ContainerPort, ObjectReference, PodCondition, PodSpec, PodStatus, ServiceSpec};
    use k8s_openapi::api::discovery::v1::{Endpoint, EndpointConditions, EndpointPort};
    use k8s_openapi::apimachinery::pkg::apis::meta::v1::{LabelSelectorRequirement, ObjectMeta, Time};
    use std::collections::BTreeMap;

    fn pod(phase: &str, ready: bool) -> Pod {
        Pod {
            metadata: ObjectMeta { name: Some("web-1".into()), ..Default::default() },
            spec: Some(PodSpec {
                containers: vec![Container {
                    name: "web".into(),
                    ports: Some(vec![
                        ContainerPort { name: Some("http".into()), container_port: 8080, ..Default::default() },
                        ContainerPort { name: Some("metrics".into()), container_port: 9090, ..Default::default() },
                    ]),
                    ..Default::default()
                }],
                ..Default::default()
            }),
            status: Some(PodStatus {
                phase: Some(phase.into()),
                conditions: Some(vec![PodCondition {
                    type_: "Ready".into(),
                    status: if ready { "True" } else { "False" }.into(),
                    ..Default::default()
                }]),
                ..Default::default()
            }),
        }
    }

    fn service_port(name: Option<&str>, port: i32, target: Option<IntOrString>) -> ServicePort {
        ServicePort { name: name.map(Into::into), port, target_port: target, ..Default::default() }
    }

    #[test]
    fn target_kinds_parse_like_kubectl() {
        assert_eq!(TargetKind::parse("svc"), Some(TargetKind::Service));
        assert_eq!(TargetKind::parse("Deployment"), Some(TargetKind::Deployment));
        assert_eq!(TargetKind::parse("pod"), Some(TargetKind::Pod));
        assert_eq!(TargetKind::parse("statefulset"), None);
    }

    #[test]
    fn readiness_needs_running_ready_and_alive() {
        assert!(pod_ready(&pod("Running", true)));
        assert!(!pod_ready(&pod("Running", false)));
        assert!(!pod_ready(&pod("Pending", true)));
        let mut terminating = pod("Running", true);
        terminating.metadata.deletion_timestamp = Some(Time(k8s_openapi::jiff::Timestamp::now()));
        assert!(!pod_ready(&terminating));
    }

    #[test]
    fn lost_reason_is_strict_only_behind_services() {
        assert_eq!(lost_reason(&pod("Running", true), true), None);
        assert_eq!(lost_reason(&pod("Running", false), true), Some(LOST_NOT_READY));
        // A pod picked by hand keeps the forward while it runs.
        assert_eq!(lost_reason(&pod("Running", false), false), None);
        assert_eq!(lost_reason(&pod("Failed", false), false), Some(LOST_STOPPED));
        let mut terminating = pod("Running", true);
        terminating.metadata.deletion_timestamp = Some(Time(k8s_openapi::jiff::Timestamp::now()));
        assert_eq!(lost_reason(&terminating, false), Some(LOST_SHUTTING_DOWN));
    }

    #[test]
    fn selectors_become_label_queries() {
        let selector = LabelSelector {
            match_labels: Some(BTreeMap::from([("app".to_string(), "web".to_string())])),
            match_expressions: Some(vec![
                LabelSelectorRequirement {
                    key: "tier".into(),
                    operator: "In".into(),
                    values: Some(vec!["a".into(), "b".into()]),
                },
                LabelSelectorRequirement { key: "canary".into(), operator: "DoesNotExist".into(), values: None },
            ]),
        };
        assert_eq!(selector_string(&selector).as_deref(), Some("app=web,tier in (a,b),!canary"));
        assert_eq!(selector_string(&LabelSelector::default()), None);
    }

    #[test]
    fn target_ports_resolve_numbers_names_and_defaults() {
        let p = pod("Running", true);
        assert_eq!(target_port(&service_port(None, 80, Some(IntOrString::Int(8080))), &p), Some(8080));
        assert_eq!(target_port(&service_port(None, 80, Some(IntOrString::String("metrics".into()))), &p), Some(9090));
        assert_eq!(target_port(&service_port(None, 80, Some(IntOrString::String("8081".into()))), &p), Some(8081));
        assert_eq!(target_port(&service_port(None, 80, Some(IntOrString::String("grpc".into()))), &p), None);
        assert_eq!(target_port(&service_port(None, 5432, None), &p), Some(5432));
    }

    #[test]
    fn service_ports_are_found_by_number() {
        let service = Service {
            metadata: ObjectMeta { name: Some("web".into()), ..Default::default() },
            spec: Some(ServiceSpec {
                ports: Some(vec![service_port(Some("http"), 80, None), service_port(Some("metrics"), 9090, None)]),
                ..Default::default()
            }),
            ..Default::default()
        };
        assert_eq!(super::service_port(&service, 9090).unwrap().name.as_deref(), Some("metrics"));
        let missing = super::service_port(&service, 443).unwrap_err();
        assert_eq!(missing.kind, FailureKind::Invalid);
        assert_eq!(missing.message, "Service web has no port 443");
    }

    fn endpoint(pod: &str, ready: Option<bool>, terminating: Option<bool>) -> Endpoint {
        Endpoint {
            addresses: vec!["10.0.0.1".into()],
            conditions: Some(EndpointConditions { ready, serving: ready, terminating }),
            target_ref: Some(ObjectReference { kind: Some("Pod".into()), name: Some(pod.into()), ..Default::default() }),
            ..Default::default()
        }
    }

    #[test]
    fn slices_yield_ready_pods_with_the_named_port() {
        let slice = EndpointSlice {
            address_type: "IPv4".into(),
            endpoints: vec![
                endpoint("web-b", Some(true), None),
                endpoint("web-a", None, None),
                endpoint("web-old", Some(false), Some(true)),
                endpoint("web-c", Some(true), Some(true)),
            ],
            ports: Some(vec![
                EndpointPort { name: Some("http".into()), port: Some(8080), ..Default::default() },
                EndpointPort { name: Some("metrics".into()), port: Some(9090), ..Default::default() },
            ]),
            metadata: ObjectMeta::default(),
        };
        let slices = [slice];
        assert_eq!(
            slice_candidates(&slices, Some("metrics")),
            vec![("web-b".to_string(), 9090), ("web-a".to_string(), 9090)]
        );
        // An unnamed service port matches the slice's unnamed port only.
        assert!(slice_candidates(&slices, None).is_empty());
    }

    #[test]
    fn picking_keeps_the_current_pod_and_avoids_the_lost_one() {
        let candidates = vec!["web-c".to_string(), "web-a".to_string(), "web-b".to_string()];
        assert_eq!(pick(&candidates, Some("web-c"), None).unwrap(), "web-c");
        assert_eq!(pick(&candidates, None, None).unwrap(), "web-a");
        assert_eq!(pick(&candidates, Some("gone"), Some("web-a")).unwrap(), "web-b");
        // The lost pod is still better than nothing (it may have recovered).
        assert_eq!(pick(&["web-a".to_string()], None, Some("web-a")).unwrap(), "web-a");
        assert!(pick(&[], None, None).is_none());
    }

    #[test]
    fn errors_are_classified() {
        use kube::client::UpgradeConnectionError;
        let api = |code: u16| {
            kube::Error::Api(Box::new(kube::core::Status {
                code,
                message: "nope".into(),
                ..Default::default()
            }))
        };
        assert_eq!(classify(&api(403)).kind, FailureKind::Forbidden);
        assert_eq!(classify(&api(403)).message, "nope");
        assert_eq!(classify(&api(404)).kind, FailureKind::NotFound);
        assert_eq!(classify(&api(401)).kind, FailureKind::Auth);
        assert_eq!(classify(&api(500)).kind, FailureKind::Unreachable);
        let upgrade = |code: u16| {
            kube::Error::UpgradeConnection(UpgradeConnectionError::ProtocolSwitch(
                http::StatusCode::from_u16(code).unwrap(),
            ))
        };
        assert_eq!(classify(&upgrade(400)).kind, FailureKind::Unsupported);
        assert_eq!(classify(&upgrade(403)).kind, FailureKind::Forbidden);
        assert_eq!(classify(&upgrade(404)).kind, FailureKind::NotFound);
        assert_eq!(
            classify(&kube::Error::UpgradeConnection(UpgradeConnectionError::MissingUpgradeWebSocketHeader)).kind,
            FailureKind::Unsupported
        );
    }
}

/*
 * PromQL of the usage charts.
 *
 * Usage comes from cAdvisor (through the kubelet, scraped by every
 * Prometheus setup): `container_cpu_usage_seconds_total` and
 * `container_memory_working_set_bytes` (what the OOM killer looks at),
 * per container, without the pod-level cgroup (`container=""`) and the
 * pause container (`POD`), so nothing is counted twice. Requests, limits
 * and restarts come from kube-state-metrics when it is there.
 *
 * Old cAdvisors (Kubernetes < 1.16) label pods `pod_name` / `container_name`
 * (the "legacy" flavour); the charts retry with it when the modern labels
 * find nothing.
 *
 * Workloads are matched by their pods' names (a deployment's pods are
 * `<name>-<template hash>-<suffix>`), which also finds the pods of earlier
 * rollouts in a 7 day range; the hash and suffix alphabet is Kubernetes'
 * "safe" one (no vowels), so `api` doesn't match `api-gateway-…`.
 */

export type Flavour = "modern" | "legacy";

/** Pods of an object: in a namespace (or any), names matching a regex (or any). */
export interface PodScope {
  type: "pods";
  namespace?: string;
  /** An RE2 regex for whole pod names (Prometheus anchors it). */
  pods?: string;
}

/** A node, by name and addresses (some setups label targets by IP). */
export interface NodeScope {
  type: "node";
  node: string;
  addresses: string[];
}

export type Scope = PodScope | NodeScope;

/** Kubernetes' random suffix alphabet (k8s.io/apimachinery rand.SafeEncodeString). */
const SAFE = "[bcdfghjklmnpqrstvwxz2456789]";

/** A regex matching `text` literally. */
export function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A PromQL double-quoted string literal. */
export function quote(text: string): string {
  return `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;
}

/** The pod-name regex of an object of `kind` named `name`; null: any pod. */
export function podPattern(kind: string, name: string): string | null {
  const base = escapeRegex(name);
  switch (kind) {
    case "Pod":
      return base;
    case "Deployment":
      return `${base}-${SAFE}{1,10}-${SAFE}{5}`;
    case "ReplicaSet":
    case "DaemonSet":
      return `${base}-${SAFE}{5}`;
    case "StatefulSet":
      return `${base}-[0-9]+`;
    case "Job":
      // Indexed jobs: <name>-<index>-<suffix>.
      return `${base}-(?:[0-9]+-)?${SAFE}{5}`;
    case "Namespace":
      return null;
    default:
      return base;
  }
}

/** Whether a pod name matches a scope's regex (anchored, like Prometheus). */
export function matchesPods(pattern: string | undefined, podName: string): boolean {
  if (!pattern) return true;
  return new RegExp(`^(?:${pattern})$`).test(podName);
}

const LABELS: Record<Flavour, { pod: string; container: string }> = {
  modern: { pod: "pod", container: "container" },
  legacy: { pod: "pod_name", container: "container_name" },
};

function podMatchers(scope: PodScope, podLabel: string): string[] {
  const matchers: string[] = [];
  if (scope.namespace) matchers.push(`namespace=${quote(scope.namespace)}`);
  if (scope.pods) matchers.push(`${podLabel}=~${quote(scope.pods)}`);
  return matchers;
}

/** cAdvisor matchers of app containers in the scope. */
export function containerSelector(scope: PodScope, flavour: Flavour = "modern"): string {
  const { pod, container } = LABELS[flavour];
  return `{${[...podMatchers(scope, pod), `${container}!=""`, `${container}!="POD"`].join(",")}}`;
}

/** kube-state-metrics matchers (always `pod` / `namespace`). */
function ksmSelector(scope: Scope, extra: string[] = []): string {
  const matchers = scope.type === "node" ? [`node=${quote(scope.node)}`] : podMatchers(scope, "pod");
  return `{${[...matchers, ...extra].join(",")}}`;
}

/** Sums per pod (for the per-pod lines) or the whole scope. */
const sumBy = (byPod: boolean, flavour: Flavour) => (byPod ? `sum by (${LABELS[flavour].pod})` : "sum");

/** CPU in cores. */
export function cpuQuery(scope: PodScope, window: string, byPod = false, flavour: Flavour = "modern"): string {
  return `${sumBy(byPod, flavour)} (rate(container_cpu_usage_seconds_total${containerSelector(scope, flavour)}[${window}]))`;
}

/** Working-set memory in bytes. */
export function memoryQuery(scope: PodScope, byPod = false, flavour: Flavour = "modern"): string {
  return `${sumBy(byPod, flavour)} (container_memory_working_set_bytes${containerSelector(scope, flavour)})`;
}

/**
 * Network in and out in bytes/s, one series per `direction` label. Network
 * is counted per pod sandbox, so there is no container filter.
 */
export function networkQuery(scope: PodScope, window: string, flavour: Flavour = "modern"): string {
  const selector = `{${podMatchers(scope, LABELS[flavour].pod).join(",")}}`;
  const side = (metric: string, direction: string) =>
    `label_replace(sum(rate(${metric}${selector}[${window}])), "direction", "${direction}", "", "")`;
  return `${side("container_network_receive_bytes_total", "in")} or ${side("container_network_transmit_bytes_total", "out")}`;
}

/**
 * Requests and limits (kube-state-metrics) of the pods that are running or
 * about to: one series per `resource` (cpu in cores, memory in bytes) and
 * `kind` (request / limit), so they follow scaling and rollouts over time.
 */
export function resourcesQuery(scope: Scope): string {
  const phase = scope.type === "pods" ? ksmSelector(scope, ['phase=~"Pending|Running"']) : '{phase=~"Pending|Running"}';
  const active = `max by (namespace, pod) (kube_pod_status_phase${phase} == 1)`;
  const part = (metric: string, kind: string) =>
    `label_replace(sum by (resource) (${metric}${ksmSelector(scope, ['resource=~"cpu|memory"'])} * on (namespace, pod) group_left () ${active}), "kind", "${kind}", "", "")`;
  return `${part("kube_pod_container_resource_requests", "request")} or ${part("kube_pod_container_resource_limits", "limit")}`;
}

/** Container restarts per pod and step (kube-state-metrics), only where there were any. */
export function restartsQuery(scope: PodScope, window: string): string {
  return `sum by (pod) (increase(kube_pod_container_status_restarts_total${ksmSelector(scope)}[${window}])) > 0.5`;
}

/** Why containers last stopped (`reason` label: OOMKilled, Error, ...). */
export function terminationReasonsQuery(scope: PodScope): string {
  return `max by (pod, reason) (kube_pod_container_status_last_terminated_reason${ksmSelector(scope)})`;
}

/** Matches a node's scrape target: `instance` is its name or an address, with or without a port. */
function instancePattern(scope: NodeScope): string {
  const names = [scope.node, ...scope.addresses].filter(Boolean).map(escapeRegex);
  return `(?:${names.join("|")})(?::[0-9]+)?`;
}

/*
 * A node's total usage: the kubelet's root cgroup (`id="/"`), labelled with
 * the node in one of the ways setups do it, else node-exporter. `or` takes
 * the first that has data.
 */
function nodeAlternatives(scope: NodeScope, metric: (selector: string) => string): string[] {
  const instance = quote(instancePattern(scope));
  return [
    metric(`{id="/",node=${quote(scope.node)}}`),
    metric(`{id="/",instance=~${instance}}`),
    metric(`{id="/",kubernetes_io_hostname=${quote(scope.node)}}`),
  ];
}

/** A node's CPU in cores. */
export function nodeCpuQuery(scope: NodeScope, window: string): string {
  const instance = quote(instancePattern(scope));
  return [
    ...nodeAlternatives(scope, (s) => `sum(rate(container_cpu_usage_seconds_total${s}[${window}]))`),
    `sum(rate(node_cpu_seconds_total{mode!~"idle|iowait|steal",instance=~${instance}}[${window}]))`,
  ].join(" or ");
}

/** A node's memory in use, in bytes. */
export function nodeMemoryQuery(scope: NodeScope): string {
  const instance = quote(instancePattern(scope));
  return [
    ...nodeAlternatives(scope, (s) => `sum(container_memory_working_set_bytes${s})`),
    `sum(node_memory_MemTotal_bytes{instance=~${instance}} - node_memory_MemAvailable_bytes{instance=~${instance}})`,
  ].join(" or ");
}

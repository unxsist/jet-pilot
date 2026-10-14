/*
 * Harness mock of a cluster's Prometheus (the usage charts): the services
 * discovery lists (a kube-prometheus-stack in `monitoring` of the first
 * context; the second context has none) and the Prometheus HTTP API behind
 * the service proxy, answering the app's PromQL with generated series:
 * a daily rhythm, a traffic spike three hours ago on payments-api, a
 * payments-worker pod living close to its memory limit and one that runs
 * out of memory (sawtooth + OOM restarts), pods appearing as a deployment
 * scaled up during the week.
 *
 *   ?scenario=metrics-none    no Prometheus (charts fall back to metrics-server)
 *   ?scenario=metrics-error   Prometheus is found but range queries fail
 *
 * Also `nodeHistory()`: metrics-server history of the nodes, for the
 * fallback node charts (used by setup.ts's metrics service mock).
 */
import { CLUSTERS, CONTEXTS } from "./fixtures";
import { kubeError, registerKubeRoutes, type MockKubeRequest } from "./kubeApi";

const scenario = () => localStorage.getItem("harness-scenario") || "default";

const MI = 1024 ** 2;
const GI = 1024 ** 3;
const HOUR = 3600;
const DAY = 86400;
const NOW = Date.now() / 1000;

/* ---------------------------------------------------------- services -- */

const service = (name: string, ports: { name: string; port: number }[], extra: any = {}) => ({
  apiVersion: "v1",
  kind: "Service",
  metadata: {
    name,
    namespace: "monitoring",
    uid: `metrics-${name}`,
    creationTimestamp: new Date((NOW - 88 * DAY) * 1000).toISOString(),
    labels: { "app.kubernetes.io/instance": "kube-prometheus-stack", "app.kubernetes.io/part-of": "kube-prometheus-stack", ...extra.labels },
  },
  spec: { type: "ClusterIP", clusterIP: extra.clusterIP ?? `172.20.9.${ports[0]!.port % 250}`, ports: ports.map((p) => ({ ...p, protocol: "TCP", targetPort: p.port })) },
});

const STACK = [
  service("kube-prometheus-stack-prometheus", [{ name: "http-web", port: 9090 }, { name: "reloader-web", port: 8080 }], { labels: { app: "kube-prometheus-stack-prometheus" } }),
  service("prometheus-operated", [{ name: "web", port: 9090 }], { clusterIP: "None", labels: { "operated-prometheus": "true" } }),
  service("kube-prometheus-stack-alertmanager", [{ name: "http-web", port: 9093 }]),
  service("kube-prometheus-stack-prometheus-node-exporter", [{ name: "http-metrics", port: 9100 }], { labels: { "app.kubernetes.io/name": "prometheus-node-exporter" } }),
  service("kube-prometheus-stack-kube-state-metrics", [{ name: "http", port: 8080 }], { labels: { "app.kubernetes.io/name": "kube-state-metrics" } }),
  service("kube-prometheus-stack-operator", [{ name: "https", port: 443 }]),
];

const PROD = CONTEXTS[0]!.name;
CLUSTERS[PROD]!.services.push(...STACK);

/* The services that answer Prometheus queries. */
const ANSWERS = new Set(["kube-prometheus-stack-prometheus", "prometheus-operated", "prometheus"]);

/* ------------------------------------------------------------ series -- */

const hashOf = (text: string) => {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return (h >>> 0) / 4294967296;
};

/* Smooth deterministic noise in [-1, 1]. */
const noise = (seed: number, t: number) =>
  0.55 * Math.sin(t / 1300 + seed * 40) + 0.3 * Math.sin(t / 470 + seed * 17) + 0.15 * Math.sin(t / 97 + seed * 9);

/* Busy afternoons, quiet nights (local time), a bit quieter at weekends. */
function daily(t: number): number {
  const d = new Date(t * 1000);
  const hour = d.getHours() + d.getMinutes() / 60;
  const curve = 0.62 + 0.38 * Math.cos(((hour - 14.5) / 24) * 2 * Math.PI);
  const weekend = d.getDay() === 0 || d.getDay() === 6 ? 0.8 : 1;
  return curve * weekend;
}

/* A traffic spike on the payments API three hours ago. */
const spike = (t: number) => Math.exp(-(((t - (NOW - 3 * HOUR)) / 540) ** 2));

interface PodModel {
  name: string;
  namespace: string;
  node?: string;
  app: string;
  created: number;
  cpu: number; // millicores, around now
  memory: number; // bytes, around now
  requests: { cpu: number; memory: number };
  limits: { cpu: number; memory: number };
  /** OOM restarts (seconds) for the pod that runs out of memory. */
  ooms: number[];
  seed: number;
}

const cpuOf = (q: string) => (q.endsWith("m") ? parseFloat(q) : parseFloat(q) * 1000);
const memOf = (q: string) => parseFloat(q) * (q.endsWith("Gi") ? GI : q.endsWith("Mi") ? MI : q.endsWith("Ki") ? 1024 : 1);

const models = new Map<string, PodModel[]>();

function podModels(context: string): PodModel[] {
  const cached = models.get(context);
  if (cached) return cached;
  const cluster = CLUSTERS[context];
  if (!cluster) return [];
  const usage = new Map(cluster.podmetrics.map((m: any) => [m.metadata.name, m]));
  const list = cluster.pods
    .filter((p: any) => usage.has(p.metadata.name))
    .map((p: any) => {
      const metric: any = usage.get(p.metadata.name);
      const sum = (pick: (c: any) => number) => metric.containers.reduce((s: number, c: any) => s + pick(c), 0);
      const containers = p.spec.containers;
      const total = (kind: "requests" | "limits", r: "cpu" | "memory") =>
        containers.reduce((s: number, c: any) => s + (r === "cpu" ? cpuOf(c.resources[kind].cpu) : memOf(c.resources[kind].memory)), 0);
      const app = p.metadata.labels?.["app.kubernetes.io/name"] ?? p.metadata.name;
      const state = p.status.containerStatuses?.[0]?.state;
      const oom = state?.terminated?.reason === "OOMKilled";
      return {
        name: p.metadata.name,
        namespace: p.metadata.namespace,
        node: p.spec.nodeName,
        app,
        created: Date.parse(p.metadata.creationTimestamp) / 1000,
        cpu: sum((c) => parseFloat(c.usage.cpu) / 1e6),
        memory: sum((c) => parseFloat(c.usage.memory) * 1024),
        requests: { cpu: total("requests", "cpu"), memory: total("requests", "memory") },
        limits: { cpu: total("limits", "cpu"), memory: total("limits", "memory") },
        ooms: oom ? oomTimes(Date.parse(p.metadata.creationTimestamp) / 1000) : [],
        seed: hashOf(p.metadata.name),
      };
    });
  models.set(context, list);
  return list;
}

/* Out of memory every few hours lately, about twice a day before (oldest first). */
function oomTimes(created: number): number[] {
  const times = [NOW - 2 * 60, NOW - 2.4 * HOUR, NOW - 5.2 * HOUR];
  for (let t = NOW - 15 * HOUR, i = 0; t > created + 2 * HOUR; t -= (9 + 5 * hashOf(`oom${i}`)) * HOUR, i++) times.push(t);
  return times.reverse();
}

/* The payments-worker pod that isn't out of memory but close: kept near 90% of its limit. */
const nearLimit = (pod: PodModel, pods: PodModel[]) =>
  pod.app === "payments-worker" && !pod.ooms.length && pods.filter((p) => p.app === pod.app && !p.ooms.length)[0]?.name === pod.name;

/* Mostly between request and limit, busier in the afternoon. */
function cpuAt(pod: PodModel, t: number): number {
  const level = pod.requests.cpu * 0.5 + pod.cpu * 0.35;
  const wave = (0.45 + 0.75 * daily(t)) * (1 + 0.12 * noise(pod.seed, t));
  const burst = pod.app === "payments-api" ? 1.9 * spike(t) : 0;
  return Math.max(1, level * (wave + burst));
}

function memoryAt(pod: PodModel, t: number, pods: PodModel[]): number {
  if (pod.ooms.length) {
    // Grows from a fresh start until it hits the limit and is killed.
    const last = [...pod.ooms].reverse().find((o) => o <= t) ?? pod.created;
    const next = pod.ooms.find((o) => o > t);
    const cycle = next ? next - last : 3 * HOUR;
    const progress = Math.min(1, (t - last) / cycle);
    return pod.limits.memory * (0.38 + 0.6 * progress ** 0.8) * (1 + 0.01 * noise(pod.seed, t));
  }
  if (nearLimit(pod, pods)) return pod.limits.memory * (0.87 + 0.04 * daily(t) + 0.015 * noise(pod.seed, t));
  // Working sets drift slowly with load.
  return pod.memory * (0.9 + 0.1 * daily(t) + 0.025 * noise(pod.seed, t * 0.3));
}

/* --------------------------------------------------------- PromQL -- */

/* A matcher's value from the query: `label="x"` or `label=~"x"`. */
function matcher(query: string, label: string): { op: string; value: string } | null {
  const match = new RegExp(`[{,]${label}(=~|=)"((?:[^"\\\\]|\\\\.)*)"`).exec(query);
  return match ? { op: match[1]!, value: match[2]!.replace(/\\\\/g, "\\").replace(/\\"/g, '"') } : null;
}

function selectPods(query: string, pods: PodModel[]): PodModel[] {
  const namespace = matcher(query, "namespace");
  const pod = matcher(query, "pod");
  const node = matcher(query, "node");
  const pattern = pod ? new RegExp(`^(?:${pod.value})$`) : null;
  return pods.filter(
    (p) =>
      (!namespace || p.namespace === namespace.value) &&
      (!pattern || pattern.test(p.name)) &&
      (!node || p.node === node.value)
  );
}

type Matrix = { metric: Record<string, string>; values: [number, string][] }[];

function timeline(query: MockKubeRequest["query"]) {
  const start = Number(query.get("start"));
  const end = Number(query.get("end"));
  const step = Number(query.get("step"));
  const times: number[] = [];
  for (let t = start; t <= end; t += step) times.push(t);
  return { times, step };
}

const series = (metric: Record<string, string>, times: number[], value: (t: number) => number | null) => ({
  metric,
  values: times.flatMap((t): [number, string][] => {
    const v = value(t);
    return v === null ? [] : [[t, String(v)]];
  }),
});

const alive = (pod: PodModel, t: number) => t >= pod.created;

/* A node's usage: its pods plus the system (kubelet, runtime, page cache). */
function nodeUsageAt(context: string, node: string, t: number, cpu: boolean): number {
  const all = podModels(context);
  const seed = hashOf(node);
  const fromPods = all
    .filter((p) => p.node === node && alive(p, t))
    .reduce((s, p) => s + (cpu ? cpuAt(p, t) / 1000 : memoryAt(p, t, all)), 0);
  return cpu ? fromPods + 0.35 + 0.08 * noise(seed, t) : fromPods + 3.1 * GI + 0.2 * GI * daily(t) + 0.05 * GI * noise(seed, t);
}

function nodeSeries(query: string, times: number[], context: string): Matrix {
  const node = matcher(query, "node")?.value ?? "";
  const cpu = query.includes("container_cpu_usage_seconds_total");
  return [series({}, times, (t) => nodeUsageAt(context, node, t, cpu))];
}

function answerRange(request: MockKubeRequest): Matrix {
  const query = request.query.get("query") ?? "";
  const { times, step } = timeline(request.query);
  const all = podModels(request.context);
  // A modern cluster: nothing has the legacy `pod_name` label.
  if (/pod_name|container_name/.test(query)) return [];
  if (query.includes('id="/"')) return nodeSeries(query, times, request.context);

  const pods = selectPods(query, all);
  if (query.includes("container_cpu_usage_seconds_total")) {
    return pods.map((p) => series({ pod: p.name }, times, (t) => (alive(p, t) ? cpuAt(p, t) / 1000 : null)));
  }
  if (query.includes("container_memory_working_set_bytes")) {
    return pods.map((p) => series({ pod: p.name }, times, (t) => (alive(p, t) ? memoryAt(p, t, all) : null)));
  }
  if (query.includes("container_network_receive_bytes_total")) {
    const total = (t: number, scale: number) =>
      pods.filter((p) => alive(p, t)).reduce((s, p) => s + (cpuAt(p, t) / 1000) * scale * (1 + 0.1 * noise(p.seed + 0.3, t)), 0);
    return [
      series({ direction: "in" }, times, (t) => total(t, 2.6e6)),
      series({ direction: "out" }, times, (t) => total(t, 0.9e6)),
    ];
  }
  if (query.includes("kube_pod_container_resource_requests")) {
    const nodeScoped = !!matcher(query, "node");
    const sum = (t: number, pick: (p: PodModel) => number) => {
      const living = pods.filter((p) => alive(p, t));
      return living.length ? living.reduce((s, p) => s + pick(p), 0) : null;
    };
    const kinds: ["request" | "limit", "requests" | "limits"][] = nodeScoped ? [["request", "requests"]] : [["request", "requests"], ["limit", "limits"]];
    return kinds.flatMap(([kind, field]) => [
      series({ resource: "cpu", kind }, times, (t) => {
        const v = sum(t, (p) => p[field].cpu);
        return v === null ? null : v / 1000;
      }),
      series({ resource: "memory", kind }, times, (t) => sum(t, (p) => p[field].memory)),
    ]);
  }
  if (query.includes("kube_pod_container_status_restarts_total")) {
    return pods
      .filter((p) => p.ooms.length)
      .map((p) => series({ pod: p.name }, times, (t) => (p.ooms.some((o) => o > t - step && o <= t) ? 1 : null)))
      .filter((s) => s.values.length);
  }
  if (query.includes("kube_pod_container_status_last_terminated_reason")) {
    return pods
      .filter((p) => p.ooms.length)
      .map((p) => series({ pod: p.name, reason: "OOMKilled" }, times, (t) => (t >= p.ooms[0]! - step ? 1 : null)));
  }
  return [];
}

const success = (data: unknown) => ({ status: "success", data });

registerKubeRoutes([
  {
    method: "GET",
    path: /^\/api\/v1\/services$/,
    handle: (request) => {
      const services = CLUSTERS[request.context]?.services ?? [];
      const items = scenario() === "metrics-none" ? services.filter((s: any) => !STACK.includes(s)) : services;
      return { kind: "ServiceList", apiVersion: "v1", items };
    },
  },
  {
    method: "GET",
    path: /^\/api\/v1\/namespaces\/([^/]+)\/services\/(?:https?:)?([^/:]+)(?::[^/]+)?\/proxy(\/.*)$/,
    handle: (request, match) => {
      const [, namespace, name, rest] = match;
      const exists = (CLUSTERS[request.context]?.services ?? []).some(
        (s: any) => s.metadata.name === name && s.metadata.namespace === namespace
      );
      if (!exists) throw kubeError(404, `services "${name}" not found`, "NotFound");
      if (!ANSWERS.has(name!) || (scenario() === "metrics-none" && name === "prometheus")) {
        throw kubeError(503, `no endpoints available for service "${name}"`, "ServiceUnavailable");
      }
      if (rest!.endsWith("/api/v1/query")) {
        return success({ resultType: "vector", result: [{ metric: {}, value: [NOW, "214"] }] });
      }
      if (rest!.endsWith("/api/v1/query_range")) {
        if (scenario() === "metrics-error") {
          throw kubeError(
            503,
            JSON.stringify({ status: "error", errorType: "timeout", error: "query timed out in expression evaluation" })
          );
        }
        return success({ resultType: "matrix", result: answerRange(request) });
      }
      throw kubeError(404, "404 page not found", "NotFound");
    },
  },
]);

/* --------------------------------------------- metrics-server (nodes) -- */

/** metrics-server ring buffers of the nodes: 40 samples, 15 s apart. */
export function nodeHistory(context: string, nowMs: number): Record<string, [number, number, number][]> {
  const history: Record<string, [number, number, number][]> = {};
  for (const node of CLUSTERS[context]?.nodes ?? []) {
    const name = node.metadata.name;
    history[name] = Array.from({ length: 40 }, (_, i) => {
      const ts = nowMs - (39 - i) * 15_000;
      return [ts, nodeUsageAt(context, name, ts / 1000, true) * 1000, nodeUsageAt(context, name, ts / 1000, false)];
    });
  }
  return history;
}

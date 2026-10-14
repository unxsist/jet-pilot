/*
 * Finding a cluster's Prometheus-compatible API without configuration:
 * Services that look like Prometheus (kube-prometheus-stack, the Prometheus
 * Operator's `prometheus-operated`, the community chart), Thanos Query or
 * VictoriaMetrics, in any namespace, ranked by how sure we are, then
 * verified with a tiny query through the service proxy. The best one that
 * answers wins. The result is kept per cluster for the session and checked
 * again after a failure.
 */
import { kubeGet, type KubeTarget } from "@/lib/kubeApi";
import { ping, sameSource, toPrometheusError, type PromSource, type SourceKind } from "./prometheus";

interface ServicePort {
  name?: string;
  port: number;
  protocol?: string;
}

export interface ServiceLike {
  metadata?: { name?: string; namespace?: string; labels?: Record<string, string> };
  spec?: { ports?: ServicePort[]; clusterIP?: string };
}

export interface Candidate {
  source: PromSource;
  kind: SourceKind;
  /** Higher is more likely the API people mean. */
  score: number;
}

/* Services next to Prometheus that are not its query API. */
const NOT_AN_API =
  /alertmanager|node-exporter|pushgateway|kube-state-metrics|operator|adapter|blackbox|grafana|kubelet|coredns|kube-proxy|kube-scheduler|kube-controller-manager|kube-etcd|etcd|sidecar|thanos-discovery|thanos-store|storegateway|compactor|ruler|vmagent|vmalert|vminsert|vmauth|config-reloader|webhook/;

interface Rule {
  kind: SourceKind;
  score: number;
  test: (name: string, labels: Record<string, string>) => boolean;
  /** Path of the Prometheus API on this kind of service. */
  pathPrefix?: string;
  ports: (string | number)[];
}

const label = (labels: Record<string, string>, ...keys: string[]) =>
  keys.map((k) => labels[k]).filter(Boolean).join(" ");

/*
 * Highest score first. A query layer over several Prometheus (Thanos,
 * VictoriaMetrics) usually keeps more history, so it wins over a single
 * Prometheus; the operator's headless `prometheus-operated` comes after the
 * stack's own service.
 */
const RULES: Rule[] = [
  {
    kind: "thanos",
    score: 95,
    test: (name, labels) => /thanos-query-frontend|thanos-frontend/.test(name) || label(labels, "app.kubernetes.io/component") === "query-frontend",
    ports: ["http", 9090, 10902],
  },
  {
    kind: "thanos",
    score: 90,
    test: (name, labels) => /thanos-query(?!-grpc)|thanos-querier/.test(name) || /thanos-query/.test(label(labels, "app.kubernetes.io/name", "app")),
    ports: ["http", "web", 9090, 10902],
  },
  {
    kind: "victoriametrics",
    score: 88,
    test: (name, labels) => /^vmselect|vmselect/.test(name) || label(labels, "app.kubernetes.io/name") === "vmselect",
    pathPrefix: "/select/0/prometheus",
    ports: ["http", 8481],
  },
  {
    kind: "victoriametrics",
    score: 86,
    test: (name, labels) =>
      /^vmsingle|victoria-metrics-single|victoriametrics/.test(name) ||
      ["vmsingle", "victoria-metrics-single"].includes(label(labels, "app.kubernetes.io/name")),
    ports: ["http", 8429, 8428],
  },
  {
    // kube-prometheus-stack (`<release>-kube-prometheus-prometheus`), kube-prometheus (`prometheus-k8s`).
    kind: "prometheus",
    score: 82,
    test: (name) => /kube-prometheus(-stack)?-prometheus$|^prometheus-k8s$|-kube-prom-prometheus$/.test(name),
    ports: ["http-web", "web", 9090],
  },
  {
    // The community chart's server.
    kind: "prometheus",
    score: 78,
    test: (name, labels) => /prometheus-server$/.test(name) || (labels["app"] === "prometheus" && labels["component"] === "server"),
    ports: ["http", 80, 9090],
  },
  {
    kind: "prometheus",
    score: 70,
    test: (name, labels) => name === "prometheus-operated" || labels["operated-prometheus"] === "true",
    ports: ["web", "http-web", 9090],
  },
  {
    kind: "prometheus",
    score: 60,
    test: (name, labels) => /prometheus/.test(name) || label(labels, "app.kubernetes.io/name", "app") === "prometheus",
    ports: ["http-web", "web", "http", 9090, 80],
  },
];

const MONITORING_NAMESPACES = /^(monitoring|prometheus|observability|metrics|kube-prometheus|victoria-metrics|vm|thanos)$/;

/** The port of a service to query on, by the rule's preference. */
function pickPort(ports: ServicePort[], preferred: (string | number)[]): ServicePort | undefined {
  const tcp = ports.filter((p) => !p.protocol || p.protocol === "TCP");
  for (const want of preferred) {
    const port = tcp.find((p) => (typeof want === "number" ? p.port === want : p.name === want));
    if (port) return port;
  }
  // A single unnamed-ish port that isn't gRPC or metrics-only.
  const plain = tcp.filter((p) => !/grpc|reloader|metrics|https/.test(p.name ?? ""));
  return plain.length === 1 ? plain[0] : undefined;
}

/** Services that may serve a Prometheus API, most likely first. */
export function rankCandidates(services: ServiceLike[]): Candidate[] {
  const candidates: Candidate[] = [];
  for (const service of services) {
    const name = service.metadata?.name ?? "";
    const namespace = service.metadata?.namespace ?? "";
    const labels = service.metadata?.labels ?? {};
    if (!name || !namespace) continue;
    const identity = `${name} ${label(labels, "app.kubernetes.io/name", "app", "app.kubernetes.io/component")}`;
    const rule = RULES.find((r) => r.test(name, labels));
    if (!rule) continue;
    // Thanos and VictoriaMetrics names say what they are; anything else that
    // mentions an exporter or helper is not the query API.
    if (rule.kind === "prometheus" && NOT_AN_API.test(identity)) continue;
    if (rule.kind !== "prometheus" && /sidecar|store|compactor|ruler|vminsert|vmagent|vmalert/.test(name)) continue;
    const port = pickPort(service.spec?.ports ?? [], rule.ports);
    if (!port) continue;
    let score = rule.score;
    if (MONITORING_NAMESPACES.test(namespace)) score += 4;
    // Headless services work through the proxy too, but a ClusterIP one is the intended entry.
    if (service.spec?.clusterIP === "None") score -= 3;
    candidates.push({
      kind: rule.kind,
      score,
      source: {
        namespace,
        service: name,
        port: port.name || port.port,
        ...(rule.pathPrefix ? { pathPrefix: rule.pathPrefix } : {}),
      },
    });
  }
  return candidates.sort(
    (a, b) => b.score - a.score || a.source.namespace.localeCompare(b.source.namespace) || a.source.service.localeCompare(b.source.service)
  );
}

/* Tried when listing services isn't allowed: the usual installs. */
export const WELL_KNOWN: Candidate[] = [
  { kind: "prometheus", score: 50, source: { namespace: "monitoring", service: "prometheus-k8s", port: "web" } },
  { kind: "prometheus", score: 49, source: { namespace: "monitoring", service: "kube-prometheus-stack-prometheus", port: "http-web" } },
  { kind: "prometheus", score: 48, source: { namespace: "monitoring", service: "prometheus-operated", port: "web" } },
  { kind: "prometheus", score: 47, source: { namespace: "monitoring", service: "prometheus-server", port: 80 } },
  { kind: "prometheus", score: 46, source: { namespace: "prometheus", service: "prometheus-server", port: 80 } },
];

export interface VerifiedCandidate extends Candidate {
  ok: boolean;
  /** Why it didn't answer. */
  error?: string;
}

export interface Discovery {
  /** The API the charts use; null: none answered. */
  found: VerifiedCandidate | null;
  /** What was tried, best first (the override dialog lists them). */
  candidates: VerifiedCandidate[];
  /** Listing services wasn't allowed, so only the usual names were tried. */
  limited: boolean;
}

/** Candidates verified in parallel (at most this many). */
const VERIFY_LIMIT = 5;

async function verify(target: KubeTarget, candidate: Candidate): Promise<VerifiedCandidate> {
  try {
    await ping(target, candidate.source);
    return { ...candidate, ok: true };
  } catch (error) {
    return { ...candidate, ok: false, error: toPrometheusError(error, candidate.source).summary };
  }
}

/** Finds and verifies a cluster's Prometheus-compatible API (uncached). */
export async function discover(target: KubeTarget): Promise<Discovery> {
  let candidates: Candidate[];
  let limited = false;
  try {
    const list = await kubeGet<{ items?: ServiceLike[] }>(target, "/api/v1/services");
    candidates = rankCandidates(list?.items ?? []);
  } catch {
    candidates = WELL_KNOWN;
    limited = true;
  }
  const tried = await Promise.all(candidates.slice(0, VERIFY_LIMIT).map((c) => verify(target, c)));
  const rest = candidates.slice(VERIFY_LIMIT).map((c) => ({ ...c, ok: false, error: "Not checked" }));
  const verified = [...tried, ...rest];
  return {
    found: tried.find((c) => c.ok) ?? null,
    // Guesses that don't exist are noise in the list.
    candidates: limited ? verified.filter((c) => c.ok) : verified,
    limited,
  };
}

const cache = new Map<string, Promise<Discovery>>();
const keyOf = (target: KubeTarget) => `${target.kubeConfig ?? ""}\u0000${target.context}`;

/** The cluster's discovery, once per session (or after `forgetDiscovery`). */
export function discoverCached(target: KubeTarget): Promise<Discovery> {
  const key = keyOf(target);
  let entry = cache.get(key);
  if (!entry) {
    entry = discover(target);
    cache.set(key, entry);
    // A failed lookup (no client yet, a sign-in) is retried next time.
    entry.catch(() => cache.delete(key));
  }
  return entry;
}

/** Forgets a cluster's discovery (its API stopped answering, or the user asked to look again). */
export function forgetDiscovery(target: KubeTarget): void {
  cache.delete(keyOf(target));
}

/** Whether `source` is what discovery found for the cluster (the "Automatic" choice). */
export async function isDiscovered(target: KubeTarget, source: PromSource): Promise<boolean> {
  const discovery = await discoverCached(target);
  return sameSource(discovery.found?.source, source);
}

/*
 * The Prometheus HTTP API (Prometheus, Thanos Query, VictoriaMetrics)
 * through the API server's service proxy: no port-forward, the cluster's own
 * credentials, and RBAC decides (`services/proxy`).
 */
import { kubeServiceProxy, queryString, type KubeTarget } from "@/lib/kubeApi";
import type { MatrixSeries } from "./series";

export type SourceKind = "prometheus" | "thanos" | "victoriametrics";

/** A Prometheus-compatible API behind a service. */
export interface PromSource {
  namespace: string;
  service: string;
  /** Port name or number. */
  port: string | number;
  scheme?: "http" | "https";
  /** Path before `/api/v1`, e.g. `/select/0/prometheus` (vmselect). */
  pathPrefix?: string;
}

export const KIND_LABELS: Record<SourceKind, string> = {
  prometheus: "Prometheus",
  thanos: "Thanos",
  victoriametrics: "VictoriaMetrics",
};

/** `prometheus-k8s in monitoring`. */
export const describeSource = (s: PromSource) => `${s.service} in ${s.namespace}`;

export const sourceKey = (s: PromSource) =>
  [s.scheme ?? "http", s.namespace, s.service, s.port, s.pathPrefix ?? ""].join("|");

export const sameSource = (a: PromSource | null | undefined, b: PromSource | null | undefined) =>
  !!a && !!b && sourceKey(a) === sourceKey(b);

/** A failed request: a short reason to show, the full message on hover. */
export class PrometheusError extends Error {
  constructor(
    public summary: string,
    public detail: string,
    public code?: number
  ) {
    super(summary);
  }
}

/* The API server returns the proxied body as the message of non-2xx answers. */
function bodyError(message: string): string | null {
  try {
    const body = JSON.parse(message);
    return typeof body?.error === "string" ? body.error : null;
  } catch {
    return null;
  }
}

/** A thrown `kube_request` error (or a Prometheus `status: error`) as a PrometheusError. */
export function toPrometheusError(error: unknown, source?: PromSource): PrometheusError {
  if (error instanceof PrometheusError) return error;
  // An answer that isn't JSON: a web page, a login proxy, another API.
  if (error instanceof SyntaxError) {
    return new PrometheusError("No Prometheus API at this address", `The service didn't answer with JSON: ${error.message}`);
  }
  const raw = error as { message?: string; code?: number } | string | undefined;
  const message = (typeof raw === "string" ? raw : raw?.message) || String(error);
  const code = typeof raw === "object" ? raw?.code : undefined;
  const fromBody = bodyError(message);
  const detail = fromBody ?? message;
  const service = source ? `${source.service} in ${source.namespace}` : "the service";
  const lower = detail.toLowerCase();

  let summary: string;
  if (lower.includes("no endpoints available")) summary = `No running pods behind ${service}`;
  else if (code === 403) summary = "Not allowed to use the service proxy";
  else if (code === 401) summary = "The cluster rejected the credentials";
  else if (code === 404 && /services? "[^"]*" not found/.test(lower)) summary = `${service} doesn't exist`;
  else if (code === 404) summary = "No Prometheus API at this address";
  // The API server couldn't dial the pod (refused, or an "i/o timeout" when a
  // firewall drops the control plane's traffic): not a slow Prometheus.
  else if (lower.includes("error trying to reach service")) summary = `Can't connect to ${service}`;
  else if (code === 504 || lower.includes("timed out") || lower.includes("timeout")) summary = "Prometheus took too long to answer";
  else if (fromBody && (code === 400 || code === 422)) summary = "Prometheus rejected the query";
  else if (code === 502 || code === 503 || lower.includes("connection refused")) summary = `Can't connect to ${service}`;
  else summary = detail.split("\n")[0]!.slice(0, 120);
  return new PrometheusError(summary, detail, code);
}

interface ApiResponse<T> {
  status: "success" | "error";
  data?: T;
  error?: string;
  errorType?: string;
}

/** GET `/api/v1/<endpoint>` of a source; resolves to `data`. */
export async function promGet<T>(
  target: KubeTarget,
  source: PromSource,
  endpoint: string,
  params: Record<string, string | number>
): Promise<T> {
  const prefix = (source.pathPrefix ?? "").replace(/\/+$/, "");
  const path = `${prefix}/api/v1/${endpoint}${queryString(params)}`;
  let response: ApiResponse<T>;
  try {
    response = await kubeServiceProxy<ApiResponse<T>>(
      target,
      { namespace: source.namespace, service: source.service, port: source.port, scheme: source.scheme },
      path
    );
  } catch (error) {
    throw toPrometheusError(error, source);
  }
  if (!response || typeof response !== "object" || !("status" in response)) {
    throw new PrometheusError("No Prometheus API at this address", "The service answered, but not like a Prometheus API.");
  }
  if (response.status !== "success") {
    throw toPrometheusError({ message: JSON.stringify(response), code: 422 }, source);
  }
  return response.data as T;
}

export interface RangeResult {
  resultType: "matrix";
  result: MatrixSeries[];
}

export const queryRange = (
  target: KubeTarget,
  source: PromSource,
  query: string,
  window: { start: number; end: number; step: number }
) =>
  promGet<RangeResult>(target, source, "query_range", {
    query,
    start: window.start,
    end: window.end,
    step: window.step,
  }).then((data) => data.result ?? []);

/** A cheap instant query that a working Prometheus with targets answers. */
export const ping = (target: KubeTarget, source: PromSource) =>
  promGet<{ resultType: string; result: unknown[] }>(target, source, "query", { query: "count(up)" });

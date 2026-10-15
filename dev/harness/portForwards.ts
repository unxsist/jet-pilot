/*
 * Port forwards: the native forward commands, their lifecycle events, local
 * port checks and the HTTP tester's answers.
 *
 *   (default)          payments-api · http (ready, with traffic) and
 *                      checkout-web · http, healed 4 minutes ago
 *   ?pf=reconnecting   checkout-web reconnecting after its pod was replaced,
 *                      grafana failed (no permission), payments-api ready
 *   ?pf=profiles       saved profiles: one running, one starting on launch
 *   ?pf=none           nothing running
 *
 * Starting a forward plays a native one: started, "waiting for a ready
 * pod" for a moment, then ready on the pod behind the target. Forwards to
 * a target named "*-flaky" lose their pod 4 s later and heal. Ports used by
 * mocked forwards (and 3000) count as in use, so the dialog moves to the
 * next free one and says so.
 */
import { emit } from "@tauri-apps/api/event";
import { CONTEXTS, KUBECONFIG } from "./fixtures";

type Status = "starting" | "ready" | "reconnecting" | "error";

interface Forward {
  id: string;
  kubeConfig: string;
  context: string;
  namespace: string;
  objectType: string;
  objectName: string;
  objectPort: number;
  portName: string | null;
  localPort: number;
  address: string;
  ttlSeconds: number | null;
  status: Status;
  error: string | null;
  reason: string | null;
  pod: string | null;
  engine: "native" | "kubectl";
  reconnects: number;
  lastReconnect: { atMs: number; reason: string } | null;
  startedAtMs: number;
  expiresAtMs: number | null;
  traffic: { openConnections: number; connections: number; bytesSent: number; bytesReceived: number };
}

const MIN = 60_000;
const now = Date.now();
const context = CONTEXTS[0].name;

const forward = (over: Partial<Forward> & Pick<Forward, "id" | "namespace" | "objectName" | "objectPort" | "localPort">): Forward => ({
  kubeConfig: KUBECONFIG,
  context,
  objectType: "service",
  portName: "http",
  address: "localhost",
  ttlSeconds: null,
  status: "ready",
  error: null,
  reason: null,
  pod: `${over.objectName}-7d9f8b6c4-x2klq`,
  engine: "native",
  reconnects: 0,
  lastReconnect: null,
  startedAtMs: now - 42 * MIN,
  expiresAtMs: null,
  traffic: { openConnections: 0, connections: 0, bytesSent: 0, bytesReceived: 0 },
  ...over,
});

const PAYMENTS = forward({
  id: "pf-1",
  namespace: "payments",
  objectName: "payments-api",
  objectPort: 80,
  localPort: 8080,
  traffic: { openConnections: 2, connections: 37, bytesSent: 48_200, bytesReceived: 1_284_000 },
});
const CHECKOUT_HEALED = forward({
  id: "pf-2",
  namespace: "checkout",
  objectName: "checkout-web",
  objectType: "deployment",
  objectPort: 3000,
  localPort: 3000,
  pod: "checkout-web-5c8d7f9b6-q4wzn",
  reconnects: 1,
  lastReconnect: { atMs: now - 4 * MIN, reason: "pod was replaced" },
  traffic: { openConnections: 0, connections: 12, bytesSent: 9_400, bytesReceived: 220_000 },
});
const POSTGRES = forward({
  id: "pf-3",
  namespace: "payments",
  objectName: "postgres",
  objectType: "service",
  objectPort: 5432,
  portName: "pg",
  localPort: 5432,
  pod: "postgres-0",
  traffic: { openConnections: 1, connections: 3, bytesSent: 12_800, bytesReceived: 96_000 },
});
const CHECKOUT_RECONNECTING = forward({
  ...CHECKOUT_HEALED,
  status: "reconnecting",
  reason: "Pod was replaced",
  pod: null,
  reconnects: 0,
  lastReconnect: null,
});
const GRAFANA_FAILED = forward({
  id: "pf-4",
  namespace: "monitoring",
  objectName: "grafana",
  objectPort: 3000,
  localPort: 3001,
  status: "error",
  pod: null,
  error: "You don't have permission to port-forward to pods in monitoring",
});

const pf = new URLSearchParams(location.search).get("pf") ?? "default";

const initial = (): Forward[] => {
  switch (pf) {
    case "none":
      return [];
    case "reconnecting":
      return [PAYMENTS, CHECKOUT_RECONNECTING, GRAFANA_FAILED];
    case "profiles":
      return [PAYMENTS];
    default:
      return [PAYMENTS, CHECKOUT_HEALED, POSTGRES];
  }
};

const profileSpec = (f: Forward) => ({
  kubeConfig: f.kubeConfig,
  context: f.context,
  namespace: f.namespace,
  objectType: f.objectType,
  objectName: f.objectName,
  objectPort: f.objectPort,
  localPort: f.localPort,
  address: f.address,
  ...(f.portName ? { portName: f.portName } : {}),
});

/** Saved profiles and remembered ports for the harness settings. */
export const portForwardSettings = (): Record<string, unknown> =>
  pf === "profiles"
    ? {
        portForwardProfiles: [
          { name: "Payments API", spec: profileSpec(PAYMENTS), autoStart: true },
          { name: "checkout-web · http", spec: profileSpec(CHECKOUT_HEALED), autoStart: false },
          { name: "Orders database", spec: profileSpec(POSTGRES), autoStart: false },
          {
            name: "Grafana",
            spec: { ...profileSpec(GRAFANA_FAILED), localPort: 3001 },
            autoStart: true,
          },
        ],
        portForwardPorts: { [`${context}|payments|service/payments-api|80`]: 8080 },
      }
    : {};

/* ------------------------------------------------------------ the mock -- */

export function createPortForwardMocks() {
  const forwards = new Map<string, Forward>(initial().map((f) => [f.id, structuredClone(f)]));
  let counter = 10;

  const update = (id: string, event: string, change: Partial<Forward>) => {
    const current = forwards.get(id);
    if (!current) return;
    const next = { ...current, ...change };
    forwards.set(id, next);
    void emit(event, next);
  };

  const later = (ms: number, fn: () => void) => setTimeout(fn, ms);

  /* Plays a native forward: waiting for a pod, ready, (flaky) healing. */
  const play = (id: string) => {
    const f = forwards.get(id)!;
    const pod = `${f.objectName}-6b7c9d8f5-${id.slice(-5).padStart(5, "k")}`;
    later(150, () =>
      update(id, "port_forward_updated", {
        reason: `Waiting for a ready pod behind ${f.objectType} ${f.objectName}`,
      })
    );
    later(900, () => update(id, "port_forward_ready", { status: "ready", reason: null, pod }));
    if (f.objectName.endsWith("-flaky")) {
      later(4000, () =>
        update(id, "port_forward_reconnecting", { status: "reconnecting", reason: "Pod was replaced", pod: null })
      );
      later(5500, () =>
        update(id, "port_forward_ready", {
          status: "ready",
          reason: null,
          pod: `${pod}-2`,
          reconnects: 1,
          lastReconnect: { atMs: Date.now(), reason: "pod was replaced" },
        })
      );
    }
  };

  const busy = () => new Set([3000, ...[...forwards.values()].filter((f) => f.status !== "error").map((f) => f.localPort)]);

  const handlers: Record<string, (p: any) => unknown> = {
    list_port_forwards: () => [...forwards.values()],
    start_port_forward: (p) => {
      const spec = p.spec;
      if (busy().has(spec.localPort)) {
        throw `Port ${spec.localPort} is already in use on ${spec.address}`;
      }
      const id = `pf-${++counter}`;
      const f: Forward = {
        ...forward({ id, namespace: spec.namespace, objectName: spec.objectName, objectPort: spec.objectPort, localPort: spec.localPort }),
        ...spec,
        id,
        portName: spec.portName ?? null,
        ttlSeconds: spec.ttlSeconds ?? null,
        status: "starting",
        pod: null,
        startedAtMs: Date.now(),
        expiresAtMs: spec.ttlSeconds ? Date.now() + spec.ttlSeconds * 1000 : null,
      };
      forwards.set(id, f);
      void emit("port_forward_started", f);
      play(id);
      return f;
    },
    stop_port_forward: (p) => {
      forwards.delete(p.id);
      void emit("port_forward_stopped", { id: p.id, reason: "user", exitCode: null });
      return null;
    },
    restart_port_forward: (p) => {
      const f = forwards.get(p.id);
      if (!f) throw "This forward has stopped";
      const fresh = { ...f, status: "starting" as const, error: null, reason: null, pod: null, reconnects: 0, lastReconnect: null, startedAtMs: Date.now() };
      forwards.set(p.id, fresh);
      void emit("port_forward_started", fresh);
      play(p.id);
      return fresh;
    },
    check_local_ports: (p) => {
      const taken = busy();
      return (p.ports as number[]).filter((port) => !taken.has(port));
    },
    port_forward_http_request: (p) => httpAnswer(p.request, forwards.get(p.request.id)),
  };

  return { handlers };
}

/* ------------------------------------------------------ HTTP answers -- */

const json = (status: number, statusText: string, value: unknown, extra: [string, string][] = []) => {
  const body = JSON.stringify(value);
  return {
    status,
    statusText,
    headers: [
      { name: "content-type", value: "application/json; charset=utf-8" },
      { name: "content-length", value: String(body.length) },
      { name: "date", value: new Date(now).toUTCString() },
      { name: "server", value: "envoy" },
      { name: "x-request-id", value: "6f1c2a9e-3b4d-4e8f-9a7c-1d2e3f4a5b6c" },
      ...extra.map(([name, value]) => ({ name, value })),
    ],
    body,
    size: body.length,
    truncated: false,
    binary: false,
  };
};

async function httpAnswer(request: { method: string; path: string }, f: Forward | undefined) {
  if (!f) throw "This forward has stopped";
  if (f.status !== "ready" && f.status !== "reconnecting") throw "This forward isn't ready";
  await new Promise((r) => setTimeout(r, 180));
  const path: string = request.path;
  const url = `http://127.0.0.1:${f.localPort}${path}`;
  let answer;
  if (path.startsWith("/healthz") || path.startsWith("/health")) {
    answer = json(200, "OK", { status: "ok", version: "2.14.3", uptimeSeconds: 3_612_480 });
  } else if (path.startsWith("/api/orders") && request.method === "POST") {
    answer = json(201, "Created", { id: "ord_8Kq2Lm", status: "pending", total: { amount: 4999, currency: "EUR" } }, [
      ["location", "/api/orders/ord_8Kq2Lm"],
    ]);
  } else if (path.startsWith("/api/orders")) {
    answer = json(200, "OK", {
      items: [
        { id: "ord_7Hn1Kd", customer: "cus_31xQ", status: "paid", total: { amount: 12900, currency: "EUR" }, createdAt: "2026-10-14T21:04:11Z" },
        { id: "ord_7Hm9Zp", customer: "cus_2Lw8", status: "refunded", total: { amount: 3450, currency: "EUR" }, createdAt: "2026-10-14T20:51:37Z" },
      ],
      nextCursor: "b3JkXzdIbTlacA",
      hasMore: true,
    });
  } else if (path.startsWith("/metrics")) {
    const body = "# HELP http_requests_total Requests served.\n# TYPE http_requests_total counter\nhttp_requests_total{code=\"200\"} 184213\nhttp_requests_total{code=\"500\"} 12\n";
    answer = { ...json(200, "OK", null), body, size: body.length, headers: [{ name: "content-type", value: "text/plain; version=0.0.4" }] };
  } else {
    answer = json(404, "Not Found", { error: "not_found", message: `No route for ${request.method} ${path}` });
  }
  return { ...answer, durationMs: 23 + (path.length % 7) * 4, url };
}

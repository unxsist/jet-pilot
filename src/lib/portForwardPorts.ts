/**
 * Ports of a forward: the remote ports a pod, deployment or service offers
 * (with their names: "http · 8080"), a sensible default among them, and a
 * predictable local port (see portForwardLocal.ts for the remembered ones).
 */
import type {
  V1Container,
  V1ContainerPort,
  V1ServicePort,
} from "@kubernetes/client-node";

/* ------------------------------------------------------- remote ports -- */

export interface PortOption {
  /** Unique within the object: `<container>/<port>` or the service port. */
  value: string;
  port: number;
  name?: string;
  /** Pods and deployments: the container that declares the port. */
  container?: string;
  /** Services: the port on the pod (number or container port name). */
  targetPort?: number | string;
}

/** "http · 8080", or just "8080" for an unnamed port. */
export function portLabel(name: string | null | undefined, port: number): string {
  return name ? `${name} · ${port}` : String(port);
}

const isTcp = (protocol: string | undefined) => (protocol ?? "TCP") === "TCP";

/** TCP ports declared by `containers` (port-forward is TCP only). */
export function containerPortOptions(containers: V1Container[] | undefined): PortOption[] {
  const options: PortOption[] = [];
  for (const container of containers ?? []) {
    for (const port of container.ports ?? ([] as V1ContainerPort[])) {
      if (!isTcp(port.protocol)) continue;
      options.push({
        value: `${container.name}/${port.containerPort}`,
        port: port.containerPort,
        name: port.name || undefined,
        container: container.name,
      });
    }
  }
  return options;
}

export function servicePortOptions(ports: V1ServicePort[] | undefined): PortOption[] {
  return (ports ?? [])
    .filter((port) => isTcp(port.protocol))
    .map((port) => ({
      value: String(port.port),
      port: port.port,
      name: port.name || undefined,
      targetPort: port.targetPort as number | string | undefined,
    }));
}

/*
 * Names people forward to look at something: the app's HTTP port first,
 * operational side ports (metrics, health, debug) last.
 */
const PRIMARY = [/^http$/, /^web$/, /^(https?|web|ui|app|api|frontend|dashboard|server)\b/, /http|web|ui$/];
const SECONDARY = /metric|health|probe|debug|pprof|admin|monitor|status|profil|trace|jmx/;
const HTTP_PORTS = new Set([80, 3000, 4200, 5000, 5173, 8000, 8008, 8080, 8081, 8888, 9000]);

function rank(option: PortOption): number {
  const name = option.name?.toLowerCase();
  if (name) {
    const primary = PRIMARY.findIndex((re) => re.test(name));
    if (primary >= 0) return primary;
    return SECONDARY.test(name) ? 9 : 6;
  }
  return HTTP_PORTS.has(option.port) ? 5 : 7;
}

/** The port to preselect: http/web first, metrics and friends last. */
export function defaultPortOption(options: PortOption[]): PortOption | undefined {
  let best: PortOption | undefined;
  for (const option of options) {
    if (!best || rank(option) < rank(best)) best = option;
  }
  return best;
}

const NOT_HTTP =
  /^(grpc|tcp|pg|postgres|postgresql|mysql|mariadb|redis|mongo|mongodb|amqp|amqps|kafka|nats|dns|dns-tcp|ssh|smtp|ldap|memcache|memcached|zk|zookeeper|cql|db|database|sql|tls|mqtt|cluster|gossip|raft|peer|client)$/;
const HTTP_NAME = /http|web|ui|api|metrics|admin|dashboard|frontend|prom|grafana/;
const MORE_HTTP_PORTS = new Set([443, 3001, 8443, 9090, 9093, 9100, 15672, 16686]);

/** Whether a forwarded port probably speaks HTTP (open in a browser, test requests). */
export function isHttpPort(name: string | null | undefined, port: number): boolean {
  const n = name?.toLowerCase();
  if (n && NOT_HTTP.test(n)) return false;
  if (n && HTTP_NAME.test(n)) return true;
  return HTTP_PORTS.has(port) || MORE_HTTP_PORTS.has(port);
}

/* -------------------------------------------------------- local ports -- */

/** Remote ports below 1024 would need admin rights locally: 80 → 8080. */
export const PRIVILEGED_OFFSET = 8000;

export function preferredLocalPort(remote: number): number {
  return remote < 1024 ? remote + PRIVILEGED_OFFSET : remote;
}

const SEARCH = 20;

/** Local ports to check for `remote`, best first. */
export function portCandidates(remote: number, remembered?: number): number[] {
  const start = remembered ?? preferredLocalPort(remote);
  const out: number[] = [];
  for (let port = start; port <= 65535 && out.length <= SEARCH; port++) {
    out.push(port);
  }
  return out;
}

export interface PortChoice {
  port: number;
  /** One short line under the field; never silent about a moved port. */
  note: string | null;
  tone: "muted" | "warning";
}

/**
 * The local port for a forward: the remembered one, else the remote port
 * (privileged ones shifted), else the next free one, saying so.
 */
export function chooseLocalPort(
  remote: number,
  remembered: number | undefined,
  free: number[]
): PortChoice {
  const start = remembered ?? preferredLocalPort(remote);
  const available = new Set(free);
  if (available.has(start)) {
    if (remembered) {
      return { port: start, note: "Same port as last time", tone: "muted" };
    }
    if (start !== remote) {
      return {
        port: start,
        note: `Ports below 1024 need admin rights, using ${start}`,
        tone: "muted",
      };
    }
    return { port: start, note: null, tone: "muted" };
  }
  const next = portCandidates(remote, remembered).find((port) =>
    available.has(port)
  );
  if (next === undefined) {
    return { port: start, note: `${start} is in use`, tone: "warning" };
  }
  return {
    port: next,
    note: `${start} is in use, using ${next}`,
    tone: "warning",
  };
}

/**
 * The local side of a forward: its URL, and the local port remembered per
 * target (state.json) so a forward comes back on the same port next time.
 * Kept apart from portForwardPorts.ts: the provider needs this at startup,
 * the rest loads with the dialog and the manager.
 */

export function isHttpsPort(name: string | null | undefined, port: number): boolean {
  return /https/.test(name?.toLowerCase() ?? "") || port === 443 || port === 8443;
}

/** `http://localhost:8080` (https for TLS ports). */
export function forwardUrl(pf: {
  address: string;
  localPort: number;
  portName?: string | null;
  objectPort: number;
}): string {
  const host = ["0.0.0.0", "::", ""].includes(pf.address)
    ? "localhost"
    : pf.address.includes(":")
    ? `[${pf.address}]`
    : pf.address;
  const scheme = isHttpsPort(pf.portName, pf.objectPort) ? "https" : "http";
  return `${scheme}://${host}:${pf.localPort}`;
}

export interface ForwardTarget {
  context: string;
  namespace: string;
  objectType: string;
  objectName: string;
  objectPort: number;
}

/** The key a local port is remembered under. */
export function targetKey(target: ForwardTarget): string {
  return [
    target.context,
    target.namespace,
    `${target.objectType}/${target.objectName}`,
    target.objectPort,
  ].join("|");
}

export type PortMemory = Record<string, number>;

const MAX_REMEMBERED = 200;

const isPort = (value: unknown): value is number =>
  typeof value === "number" &&
  Number.isInteger(value) &&
  value > 0 &&
  value < 65536;

export function parsePortMemory(value: unknown): PortMemory {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: PortMemory = {};
  for (const [key, port] of Object.entries(value)) {
    if (isPort(port)) out[key] = port;
  }
  return out;
}

/** Remembers `port` for `key`, the most recent last; old entries fall off. */
export function rememberPort(
  memory: PortMemory,
  key: string,
  port: number
): PortMemory {
  const next = { ...memory };
  delete next[key];
  next[key] = port;
  const keys = Object.keys(next);
  for (const old of keys.slice(0, Math.max(0, keys.length - MAX_REMEMBERED))) {
    delete next[old];
  }
  return next;
}

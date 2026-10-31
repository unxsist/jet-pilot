/*
 * How JET Pilot reaches a cluster: directly (the default, where a proxy-url
 * in the kubeconfig keeps working), through a SOCKS5 / HTTP(S) proxy, or
 * through an SSH jump host (the backend runs `ssh -N -D` while the cluster
 * is in use). Stored per cluster as `connection` in state.json; the
 * backend (src-tauri/src/connection) applies it to every way the app talks
 * to the cluster.
 */
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { warn } from "@/lib/logger";
import type { ClusterRecord, ConnectionSetting } from "./meta";

export interface ConnectionEntry {
  kubeConfig: string;
  context: string;
  connection: ConnectionSetting;
}

export type TunnelState =
  | { state: "connecting" }
  | { state: "connected"; since: number }
  | { state: "retrying"; error: string; attempt: number }
  | { state: "failed"; error: string }
  | { state: "stopped" };

export interface ConnectionStatus {
  mode: "direct" | "proxy" | "ssh";
  via?: string | null;
  tunnel?: TunnelState | null;
  /** The kubeconfig's own proxy-url (host only). */
  kubeconfigProxy?: string | null;
}

export const connectionEntries = (records: readonly ClusterRecord[]): ConnectionEntry[] =>
  records
    .filter((record) => record.connection)
    .map((record) => ({ kubeConfig: record.kubeConfig, context: record.context, connection: record.connection! }));

const PROXY_SCHEMES = ["socks5:", "http:", "https:"];
/* Like the backend: a value ssh takes as one plain argument, never an option. */
const plain = (value: string) => !!value && !value.startsWith("-") && !/[\s\u0000-\u001f]/.test(value);

/** What's wrong with a setting, in a sentence; null when it's fine. */
export function connectionProblem(setting: ConnectionSetting | undefined): string | null {
  if (!setting) return null;
  if (setting.mode === "proxy") {
    const url = setting.url.trim();
    if (!url) return "Enter the proxy's URL, for example socks5://proxy.example.com:1080.";
    if (!url.includes("://")) return `Start with the kind of proxy: socks5://${url} or http://${url}.`;
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return `"${url}" isn't a URL. Start it with socks5://, http:// or https://.`;
    }
    if (!PROXY_SCHEMES.includes(parsed.protocol)) return "Use a socks5://, http:// or https:// proxy.";
    if (!parsed.hostname) return `"${url}" has no host.`;
    return null;
  }
  const host = setting.host.trim();
  if (!host) return "Enter the jump host, for example user@bastion.example.com.";
  if (!plain(host) || host.endsWith("@")) return `"${host}" isn't a host name.`;
  if (setting.port !== undefined && (!Number.isInteger(setting.port) || setting.port < 1 || setting.port > 65535)) {
    return "The SSH port is a number from 1 to 65535.";
  }
  const jump = setting.jump?.trim();
  if (jump && !plain(jump)) return `"${jump}" isn't a jump host.`;
  const identity = setting.identityFile?.trim();
  if (identity && identity.startsWith("-")) return `"${identity}" isn't a file.`;
  return null;
}

/** `host:port` of a proxy URL, without credentials. */
export function proxyHost(url: string): string {
  try {
    const parsed = new URL(url.trim());
    return parsed.port ? `${parsed.hostname}:${parsed.port}` : parsed.hostname;
  } catch {
    return url;
  }
}

const hostName = (host: string) => host.trim().split("@").pop() ?? host;

export type Tone = "success" | "warning" | "destructive" | "muted";

export interface ConnectionLine {
  title: string;
  detail?: string;
  tone: Tone;
  /** The tunnel failed: offer "Try again". */
  retry: boolean;
}

/**
 * The hub's lines about a cluster's connection ("Connects via"): the host
 * it goes through, then how and its state ("SSH jump host · connected").
 * Null when it connects directly.
 */
export function connectionLine(status: ConnectionStatus | null, setting?: ConnectionSetting): ConnectionLine | null {
  const mode = status?.mode ?? setting?.mode ?? "direct";
  if (mode === "direct") {
    return status?.kubeconfigProxy
      ? { title: status.kubeconfigProxy, detail: "Proxy set in the kubeconfig", tone: "muted", retry: false }
      : null;
  }
  if (mode === "proxy") {
    const url = setting?.mode === "proxy" ? setting.url : "";
    const kind = url.trim().startsWith("socks5") ? "SOCKS5 proxy" : "HTTP proxy";
    return { title: status?.via ?? proxyHost(url), detail: url ? kind : undefined, tone: "muted", retry: false };
  }
  const title = status?.via ?? (setting?.mode === "ssh" ? hostName(setting.host) : "");
  const tunnel = status?.tunnel;
  switch (tunnel?.state) {
    case "connected":
      return { title, detail: "SSH jump host · connected", tone: "success", retry: false };
    case "connecting":
      return { title, detail: "SSH jump host · connecting…", tone: "warning", retry: false };
    case "retrying":
      return { title, detail: `Reconnecting: ${tunnel.error}`, tone: "warning", retry: false };
    case "failed":
      return { title, detail: tunnel.error, tone: "destructive", retry: true };
    default:
      return { title, detail: "SSH jump host · opens when you use the cluster", tone: "muted", retry: false };
  }
}

/* ------------------------------------------------------------ backend -- */

let sentEntries = "[]";
let configured = false;
let active: { context: string; kubeConfig: string }[] = [];
let sentActive = "";

const sendActive = () => {
  const json = JSON.stringify(active);
  if (!configured || json === sentActive) return;
  sentActive = json;
  invoke("cluster_connections_active", { targets: active }).catch((e) =>
    warn(`Failed to pass the active clusters to the connection routes: ${e}`)
  );
};

/** Pushes the clusters' connection settings to the backend (when they changed). */
export function syncConnections(records: readonly ClusterRecord[]) {
  const entries = connectionEntries(records);
  const json = JSON.stringify(entries);
  if (json === sentEntries) return;
  sentEntries = json;
  configured = entries.length > 0;
  invoke("cluster_connections_set", { entries }).catch((e) => warn(`Failed to apply the connection settings: ${e}`));
  sendActive();
}

/** The active contexts keep their SSH tunnels up. */
export function syncActiveConnections(targets: { context: string; kubeConfig: string }[]) {
  active = targets;
  sendActive();
}

/**
 * kubectl / helm arguments for runs started from the frontend: through the
 * cluster's proxy or SSH tunnel when it has one.
 */
export async function routedCliArgs(args: string[]): Promise<string[]> {
  if (!configured) return args;
  return invoke<string[]>("cluster_cli_args", { args });
}

export const connectionStatus = (context: string, kubeConfig: string) =>
  invoke<ConnectionStatus>("cluster_connection_status", { context, kubeConfig: kubeConfig || null });

export const connectNow = (context: string, kubeConfig: string) =>
  invoke<void>("cluster_connection_connect", { context, kubeConfig: kubeConfig || null });

/** Called when a tunnel's state changes. */
export const onConnectionChange = (handler: () => void) => listen("cluster-connection://changed", handler);

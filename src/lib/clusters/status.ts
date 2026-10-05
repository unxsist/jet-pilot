/*
 * Cluster status for the Clusters hub (src-tauri/src/probe.rs): the last
 * known status instantly, then a probe that streams results. Contexts whose
 * sign-in may need the user (browser, device code) are skipped unless asked.
 */
import { Channel, invoke } from "@tauri-apps/api/core";
import type { InteractiveClass } from "./inventory";

export type Reachability = "reachable" | "unreachable" | "unauthorized" | "forbidden" | "skipped" | "error";

export interface ClusterStatus {
  kubeConfig: string;
  context: string;
  reachability: Reachability;
  serverVersion?: string | null;
  nodeCount?: number | null;
  latencyMs?: number | null;
  /** Unix ms. */
  checkedAt: number;
  lastOkAt?: number | null;
  interactive: InteractiveClass;
  authCommand?: string | null;
  message?: string | null;
}

export type ProbeEvent = { type: "result"; status: ClusterStatus } | { type: "done" };

export interface ContextRef {
  context: string;
  kubeConfig: string;
}

export function cachedStatuses(contexts: ContextRef[]): Promise<ClusterStatus[]> {
  return invoke<ClusterStatus[] | null>("cluster_status_cached", { contexts }).then((list) => list ?? []);
}

/** Probes `contexts`; resolves with the batch id (pass it to cancelProbe). */
export function probeClusters(
  contexts: ContextRef[],
  onStatus: (status: ClusterStatus) => void,
  options: { includeNodes?: boolean; includeInteractive?: boolean; onDone?: () => void } = {}
): Promise<number> {
  const channel = new Channel<ProbeEvent>();
  channel.onmessage = (event) => {
    if (event.type === "result") onStatus(event.status);
    else options.onDone?.();
  };
  return invoke<number>("cluster_probe", {
    contexts,
    includeNodes: options.includeNodes ?? true,
    includeInteractive: options.includeInteractive ?? false,
    onEvent: channel,
  });
}

export function cancelProbe(batchId: number): Promise<void> {
  return invoke("cluster_probe_cancel", { batchId });
}

export const STATUS_TONES: Record<Reachability, "success" | "warning" | "destructive" | "muted"> = {
  reachable: "success",
  unreachable: "destructive",
  unauthorized: "warning",
  forbidden: "warning",
  skipped: "muted",
  error: "destructive",
};

export const STATUS_LABELS: Record<Reachability, string> = {
  reachable: "Reachable",
  unreachable: "Unreachable",
  unauthorized: "Sign-in needed",
  forbidden: "No access",
  skipped: "Not checked",
  error: "Error",
};

/** "just now", "5m ago", "3h ago", "2d ago". */
export function relativeTime(at: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

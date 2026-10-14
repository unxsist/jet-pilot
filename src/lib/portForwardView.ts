/**
 * How a forward reads in the forward manager: one quiet line under its
 * name that only gets colour when something needs attention, and a self-
 * healed forward saying so in muted words for a while.
 */
import type { StatusTone } from "@/components/ui/status";
import { relativeTime } from "@/lib/clusters/status";
import type {
  ActivePortForwarding,
  ForwardTraffic,
} from "@/providers/PortForwardingProvider";

/** "512 B", "1.2 KB", "3.4 MB" (decimal: these are payload sizes). */
export function formatSize(bytes: number): string {
  if (bytes < 1000) return `${bytes} B`;
  if (bytes < 1_000_000) return `${(bytes / 1000).toFixed(bytes < 10_000 ? 1 : 0)} KB`;
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

/** How long "Reconnected 2m ago · pod was replaced" stays visible. */
export const HEALED_NOTE_MS = 15 * 60 * 1000;

export function forwardTone(pf: Pick<ActivePortForwarding, "status">): StatusTone {
  switch (pf.status) {
    case "ready":
      return "success";
    case "reconnecting":
      return "warning";
    case "error":
      return "destructive";
    default:
      return "muted";
  }
}

const lowerFirst = (text: string) =>
  text ? text.charAt(0).toLowerCase() + text.slice(1) : text;

export interface ForwardLine {
  text: string;
  tone: "muted" | "warning" | "destructive";
}

export function forwardLine(
  pf: Pick<
    ActivePortForwarding,
    | "status"
    | "error"
    | "reason"
    | "lastReconnect"
    | "namespace"
    | "context"
    | "engine"
  >,
  now = Date.now()
): ForwardLine {
  switch (pf.status) {
    case "error":
      return { text: pf.error || "Stopped working", tone: "destructive" };
    case "reconnecting":
      return {
        text: pf.reason
          ? `Reconnecting · ${lowerFirst(pf.reason)}`
          : "Reconnecting",
        tone: "warning",
      };
    case "starting":
      return {
        text: pf.reason ? `Starting · ${lowerFirst(pf.reason)}` : "Starting",
        tone: "muted",
      };
  }
  const healed = pf.lastReconnect;
  if (healed && now - healed.atMs < HEALED_NOTE_MS) {
    return {
      text: `Reconnected ${relativeTime(healed.atMs, now)} · ${healed.reason}`,
      tone: "muted",
    };
  }
  const where = `${pf.namespace} · ${pf.context}`;
  return {
    text: pf.engine === "kubectl" ? `${where} · via kubectl` : where,
    tone: "muted",
  };
}

/** "3 open · 14 KB", "12 connections · 1.4 MB"; null before any traffic. */
export function trafficLine(traffic: ForwardTraffic | undefined): string | null {
  if (!traffic || traffic.connections === 0) return null;
  const bytes = formatSize(traffic.bytesSent + traffic.bytesReceived);
  if (traffic.openConnections > 0) {
    return `${traffic.openConnections} open · ${bytes}`;
  }
  return `${traffic.connections} connection${
    traffic.connections === 1 ? "" : "s"
  } · ${bytes}`;
}

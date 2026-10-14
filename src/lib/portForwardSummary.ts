/**
 * Counts for the sidebar's port-forward entry (loaded at startup; the
 * manager's own copy lives in portForwardView.ts and loads with it).
 */
import type { ActivePortForwarding } from "@/providers/PortForwardingProvider";

export interface ForwardCounts {
  ready: number;
  starting: number;
  reconnecting: number;
  failed: number;
}

export function countForwards(
  forwards: Pick<ActivePortForwarding, "status">[]
): ForwardCounts {
  const counts: ForwardCounts = { ready: 0, starting: 0, reconnecting: 0, failed: 0 };
  for (const pf of forwards) {
    if (pf.status === "ready") counts.ready++;
    else if (pf.status === "starting") counts.starting++;
    else if (pf.status === "reconnecting") counts.reconnecting++;
    else counts.failed++;
  }
  return counts;
}

/** "2 running · 1 reconnecting" for the manager's subtitle. */
export function forwardSummary(counts: ForwardCounts, saved: number): string {
  const parts: string[] = [];
  const running = counts.ready + counts.starting;
  if (running) parts.push(`${running} running`);
  if (counts.reconnecting) parts.push(`${counts.reconnecting} reconnecting`);
  if (counts.failed) parts.push(`${counts.failed} failed`);
  if (saved) parts.push(`${saved} saved`);
  return parts.join(" · ") || "Nothing forwarded";
}

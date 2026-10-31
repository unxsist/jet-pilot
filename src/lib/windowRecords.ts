/**
 * What pop-out windows and the main window exchange and store (see
 * @/lib/windows): the messages, and validation of payloads, stored
 * records, state reports and tab transfers. Kept apart so the main
 * window's startup code stays small.
 */
import { parseTabSession } from "@/lib/tabDescriptors";
import type { WorkspaceContext } from "@/lib/workspaces";
import {
  isPopOutLabel,
  POP_OUT_PREFIX,
  QUIT_REQUESTED_EVENT,
  type TabTransfer,
  type WindowBounds,
  type WindowPayload,
  type WindowRecord,
  type WindowStateReport,
} from "@/lib/windows";

/** Events between the windows (Tauri events, targeted with emitTo). */
export const WINDOW_EVENTS = {
  /** pop-out → main: loaded, send my payload. `{ label }` */
  ready: "window://ready",
  /** main → pop-out: what to show. `WindowPayload` */
  payload: "window://payload",
  /** pop-out → main: open tabs / route / bounds changed. `WindowStateReport` */
  state: "window://state",
  /** pop-out → main: put this tab back into the main window. `TabTransfer` */
  tabToMain: "window://tab-to-main",
  /** pop-out → main: show this view in the main window. `{ label, route }` */
  viewToMain: "window://view-to-main",
  /** backend → main: a pop-out window is gone. `{ label }` */
  closed: "window://closed",
  /** backend → main: the main window is closing, quit the app. */
  quitRequested: QUIT_REQUESTED_EVENT,
} as const;

/** At most this many pop-out windows are remembered and restored. */
export const MAX_WINDOWS = 12;

let counter = 0;
export const newWindowLabel = (now = Date.now()) =>
  `${POP_OUT_PREFIX}${now.toString(36)}${(counter++).toString(36)}`;

/** Window title: "Pods — prod-eu-west-1", "logs api-7d9f — JET Pilot"... */
export function windowTitle(subject: string, context?: string | null): string {
  return [subject, context].filter(Boolean).join(" — ") || "JET Pilot";
}

function parseBounds(value: unknown): WindowBounds | null {
  if (!value || typeof value !== "object") return null;
  const { x, y, width, height } = value as Record<string, unknown>;
  const numbers = [x, y, width, height];
  if (!numbers.every((n) => typeof n === "number" && Number.isFinite(n))) return null;
  if ((width as number) < 200 || (height as number) < 150) return null;
  return {
    x: Math.round(x as number),
    y: Math.round(y as number),
    width: Math.round(width as number),
    height: Math.round(height as number),
  };
}

function parseContexts(value: unknown): WorkspaceContext[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(
      (c) =>
        !!c &&
        typeof c.context === "string" &&
        c.context !== "" &&
        typeof c.kubeConfig === "string" &&
        Array.isArray(c.namespaces) &&
        c.namespaces.length > 0 &&
        c.namespaces.every((n: unknown) => typeof n === "string")
    )
    .map((c) => ({ context: c.context, kubeConfig: c.kubeConfig, namespaces: [...c.namespaces] }));
}

/** A window payload from an event or state.json; null when unusable. */
export function parsePayload(value: unknown): WindowPayload | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const kind = raw.kind === "view" || raw.kind === "tabs" ? raw.kind : null;
  if (!kind) return null;
  const route = typeof raw.route === "string" && raw.route.startsWith("/") ? raw.route : null;
  const tabs = parseTabSession(raw.tabs);
  if (kind === "view" && !route) return null;
  if (kind === "tabs" && tabs.tabs.length === 0) return null;
  const payload: WindowPayload = { kind, route: kind === "view" ? route : null, contexts: parseContexts(raw.contexts), tabs };
  if (raw.attach && typeof raw.attach === "object") {
    const attach = Object.fromEntries(
      Object.entries(raw.attach as Record<string, unknown>).filter(
        ([id, session]) => typeof session === "string" && tabs.tabs.some((t) => t.id === id)
      )
    ) as Record<string, string>;
    if (Object.keys(attach).length > 0) payload.attach = attach;
  }
  return payload;
}

/** Stored pop-out windows (state.json): valid ones, unique labels, no live sessions. */
export function parseWindowRecords(value: unknown): WindowRecord[] {
  if (!Array.isArray(value)) return [];
  const records: WindowRecord[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object") continue;
    const label = (raw as Record<string, unknown>).label;
    if (!isPopOutLabel(label) || records.some((r) => r.label === label)) continue;
    const payload = parsePayload(raw);
    if (!payload) continue;
    delete payload.attach;
    records.push({ ...payload, label, bounds: parseBounds((raw as Record<string, unknown>).bounds) });
  }
  return records.slice(-MAX_WINDOWS);
}

/** The record with a pop-out window's report applied. */
export function applyReport(record: WindowRecord, report: WindowStateReport): WindowRecord {
  const next: WindowRecord = { ...record };
  if (report.tabs) next.tabs = parseTabSession(report.tabs);
  if (record.kind === "view" && typeof report.route === "string" && report.route.startsWith("/")) {
    next.route = report.route;
  }
  const bounds = parseBounds(report.bounds);
  if (bounds) next.bounds = bounds;
  // Live sessions were attached once; a reload must not try again.
  delete next.attach;
  return next;
}

/** What the main window stores: records without the one-off shell handover. */
export function storableRecords(records: WindowRecord[]): WindowRecord[] {
  return records.map((record) => {
    const stored: WindowRecord = JSON.parse(JSON.stringify(record));
    delete stored.attach;
    return stored;
  });
}

/** A tab transfer from another window; null when unusable. */
export function parseTabTransfer(value: unknown): TabTransfer | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const tab = parseTabSession({ tabs: [raw.tab] }).tabs[0];
  if (!tab || typeof raw.label !== "string") return null;
  return {
    label: raw.label,
    tab,
    ...(typeof raw.session === "string" && raw.session ? { session: raw.session } : {}),
  };
}

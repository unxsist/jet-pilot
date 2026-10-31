/*
 * One change on the timeline, whatever it came from: the recorder (seen
 * live while the app was open) or the cluster's own history (ReplicaSets,
 * ControllerRevisions, Helm, Argo CD, Flux, managedFields, pod restarts,
 * node conditions, events). Merging, day groups and search. Pure.
 */
import type { StatusTone } from "@/components/ui/status/tones";
import type { ObjectRef } from "@/lib/resources/kinds";
import { managerLabel } from "./words";

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;
/** How far back the timeline goes (the recorder keeps as long). */
export const CHANGES_WINDOW_MS = 14 * DAY;

export type ChangeSource =
  | "recorded"
  | "revisions"
  | "helm"
  | "argocd"
  | "flux"
  | "managed-fields"
  | "pods"
  | "nodes"
  | "events";

/** What a change did. */
export type ChangeKind =
  /** The pod template: image, env, resources, the config it uses. */
  | "template"
  /** A ConfigMap's or Secret's data. */
  | "config"
  /** A Helm, Argo CD or Flux revision. */
  | "release"
  /** `kubectl rollout restart` and the like. */
  | "restart"
  | "scale"
  /** Another spec change (strategy, a cordon, taints). */
  | "spec"
  | "created"
  | "deleted"
  /** A container restarted. */
  | "crash"
  /** A node condition changed. */
  | "condition"
  | "event";

export interface ChangeTarget {
  context: string;
  kubeConfig: string;
}

export interface ChangeDiff {
  before: unknown;
  after: unknown;
  beforeLabel: string;
  afterLabel: string;
}

export interface Change {
  key: string;
  /** When (ISO 8601). */
  at: string;
  target: ChangeTarget;
  object: ObjectRef & { uid?: string };
  kind: ChangeKind;
  /** Lower case words for a row: "image api:1.4.2 → api:1.5.0". */
  summary: string;
  /** A sentence: "Image changed from api:1.4.2 to api:1.5.0". */
  sentence: string;
  /** The field manager or component that made it. */
  by?: string;
  source: ChangeSource;
  /** Seen live by the recorder (not reconstructed). */
  recorded: boolean;
  /** Problems only (a warning, a crash, a node not ready). */
  tone?: StatusTone;
  diff?: ChangeDiff;
}

export const atMs = (change: Pick<Change, "at">) => Date.parse(change.at);

export const byNewest = (a: Change, b: Change) => atMs(b) - atMs(a);

const identity = (c: Change) =>
  [c.target.context, c.target.kubeConfig, c.object.kind, c.object.namespace ?? "", c.object.name].join("\u0000");

/* The same moment, give or take: an RS's creation vs the manager's timestamp. */
const SAME_MOMENT_MS = 2 * MINUTE;

/* What a reconstructed change may absorb: the same change seen another way. */
const ABSORBS: Partial<Record<ChangeSource, ChangeKind[]>> = {
  revisions: ["template", "restart", "spec"],
};

/**
 * One line per change: the same change seen by several sources becomes one
 * (the richest), keeping who made it and whether it was seen live.
 *
 * - The same key (an event recorded and still in the cluster): the newest.
 * - A revision (with its template diff) absorbs a recorded update and a
 *   managedFields write of the same object at the same moment.
 * - A managedFields write next to any other change of the object only
 *   says who made it.
 */
export function mergeChanges(changes: Change[]): Change[] {
  const byKey = new Map<string, Change>();
  for (const change of changes) {
    const existing = byKey.get(change.key);
    if (!existing || atMs(change) > atMs(existing)) {
      byKey.set(change.key, existing ? { ...change, by: change.by ?? existing.by, recorded: change.recorded || existing.recorded } : change);
    }
  }

  const groups = new Map<string, Change[]>();
  for (const change of byKey.values()) {
    const key = identity(change);
    groups.set(key, [...(groups.get(key) ?? []), change]);
  }

  const out: Change[] = [];
  for (const group of groups.values()) {
    const dropped = new Set<Change>();
    const near = (a: Change, b: Change) => Math.abs(atMs(a) - atMs(b)) <= SAME_MOMENT_MS;
    const merged = group.map((c) => ({ ...c }));
    for (const rich of merged.filter((c) => ABSORBS[c.source])) {
      for (const other of merged) {
        if (other === rich || dropped.has(other) || !near(rich, other)) continue;
        const absorbable =
          (other.source === "recorded" && ABSORBS[rich.source]!.includes(other.kind)) || other.source === "managed-fields";
        if (!absorbable) continue;
        rich.by ??= other.by;
        rich.recorded ||= other.recorded;
        dropped.add(other);
      }
    }
    for (const write of merged.filter((c) => c.source === "managed-fields" && !dropped.has(c))) {
      const other = merged.find(
        (c) => c !== write && !dropped.has(c) && c.source !== "managed-fields" && near(c, write) && !["event", "crash", "condition"].includes(c.kind)
      );
      if (other) {
        other.by ??= write.by;
        dropped.add(write);
      }
    }
    out.push(...merged.filter((c) => !dropped.has(c)));
  }
  return out.sort(byNewest);
}

/* --------------------------------------------------------------- days -- */

export interface DayGroup {
  /** yyyy-mm-dd (local). */
  id: string;
  title: string;
  changes: Change[];
}

const dayId = (date: Date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;

/** "Today", "Yesterday", "Thursday" (this week), "29 October" (2025 when another year). */
export function dayTitle(date: Date, now = new Date()): string {
  const startOf = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((startOf(now) - startOf(date)) / DAY);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return date.toLocaleDateString("en-GB", { weekday: "long" });
  return date.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    ...(date.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}),
  });
}

/** Changes (newest first) grouped by local day. */
export function groupByDay(changes: Change[], now = new Date()): DayGroup[] {
  const groups: DayGroup[] = [];
  for (const change of changes) {
    const date = new Date(change.at);
    const id = dayId(date);
    const last = groups[groups.length - 1];
    if (last?.id === id) last.changes.push(change);
    else groups.push({ id, title: dayTitle(date, now), changes: [change] });
  }
  return groups;
}

/** "14:02" in the user's clock. */
export const timeOfDay = (at: string) =>
  new Date(at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

/* ------------------------------------------------------------- search -- */

/** Every word of `query` appears in its name, kind, namespace, cluster, words or author. */
export function matchesChange(change: Change, query: string, clusterName = ""): boolean {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const haystack = [
    change.object.name,
    change.object.kind,
    change.object.namespace ?? "",
    change.target.context,
    clusterName,
    change.summary,
    change.by ?? "",
    managerLabel(change.by),
  ]
    .join(" ")
    .toLowerCase();
  return words.every((word) => haystack.includes(word));
}

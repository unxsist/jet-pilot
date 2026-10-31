/*
 * The backend recorder (src-tauri/src/changes): which clusters it records,
 * what it recorded, and a callback when a cluster has new records.
 */
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { ObjectRef } from "@/lib/resources/kinds";
import type { ChangeRecord } from "./sources";

export interface RecordTarget {
  context: string;
  kubeConfig: string;
  /** ["all"] = every namespace. */
  namespaces: string[];
}

export interface Session {
  from: string;
  to: string;
}

export interface RecordedCluster {
  context: string;
  /** The resolved kubeconfig path. */
  kubeConfig: string;
  /** The recorder runs for it now. */
  recording: boolean;
  /** When the recorder ran, oldest first. */
  sessions: Session[];
  /** Newest first. */
  records: ChangeRecord[];
}

/**
 * Records these clusters while the app is open (and stops recording the
 * others). `fresh` after a page load: the backend restarts its recorders,
 * whose WatchHub subscriptions the reload dropped.
 */
export const trackChanges = (targets: RecordTarget[], fresh = false) =>
  invoke<void>("changes_track", { targets, fresh });

export const listRecorded = (request: { targets: RecordTarget[]; since?: string; objects?: ObjectRef[] }) =>
  invoke<RecordedCluster[]>("changes_list", {
    request: {
      targets: request.targets,
      since: request.since ?? null,
      objects: (request.objects ?? []).map((o) => ({ kind: o.kind, name: o.name, namespace: o.namespace ?? "" })),
    },
  });

/** Calls `handler` when a cluster has new records (debounced in the backend). */
export const onRecorded = (handler: (cluster: { context: string; kubeConfig?: string }) => void): Promise<UnlistenFn> =>
  listen<{ context: string; kubeConfig?: string }>("changes://changed", (event) => handler(event.payload));

/** Since when the record of these clusters is complete: the start of the oldest session that still runs. */
export function recordingSince(clusters: RecordedCluster[]): string | null {
  const starts = clusters
    .filter((c) => c.recording && c.sessions.length)
    .map((c) => c.sessions[c.sessions.length - 1].from)
    .sort();
  return starts[0] ?? null;
}

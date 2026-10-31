/*
 * The change that most likely caused a problem: the newest change to the
 * object or its owners (a new image, an edited ConfigMap it mounts, a Helm
 * upgrade) shortly before the problem started. The change timeline
 * (@/lib/changes) answers it; null when nothing explains the problem.
 */
import type { KubeTarget } from "@/lib/kubeApi";
import type { ObjectRef } from "@/lib/resources/kinds";
import { atMs, HOUR, type Change, type ChangeKind } from "./model";

export interface ChangeSummary {
  /** When the change happened (ISO 8601). */
  at: string;
  /** What changed: the object itself, its owner or something it uses. */
  object: ObjectRef;
  /** One sentence: "Image changed from api:1.4.2 to api:1.5.0." */
  summary: string;
  /** Who made it when known: "helm", "argocd-application-controller", "kubectl-edit". */
  by?: string;
}

export type LikelyCause = (
  target: KubeTarget,
  object: ObjectRef,
  /** When the problem started (ISO 8601); changes after it don't count. */
  since?: string
) => Promise<ChangeSummary | null>;

/** How far before a problem a change still explains it. */
export const CAUSE_WINDOW_MS = 24 * HOUR;
/* Timestamps have second precision, and a pod fails seconds after its ReplicaSet appears. */
const GRACE_MS = 10_000;

/*
 * Changes that can break a workload, most telling first (for changes at
 * the same moment): its pod template, its config (edited or deleted), a
 * release, another spec change, a restart. Scaling, crashes and events are
 * symptoms, not causes.
 */
const PREFERENCE: Partial<Record<ChangeKind, number>> = {
  template: 0,
  config: 1,
  deleted: 1,
  release: 2,
  spec: 3,
  restart: 4,
};

const isCandidate = (change: Change) => {
  if (PREFERENCE[change.kind] === undefined) return false;
  // Only a deleted ConfigMap or Secret breaks what uses it.
  if (change.kind === "deleted") return change.object.kind === "ConfigMap" || change.object.kind === "Secret";
  // A cordon doesn't break a running pod.
  return change.object.kind !== "Node";
};

/**
 * The newest candidate change in the window before `since`. A restart
 * only re-reads what changed before it, so a template or config change
 * since the window started wins over it.
 */
export function pickCause(changes: Change[], since: number, window = CAUSE_WINDOW_MS): Change | null {
  const candidates = changes
    .filter(isCandidate)
    .filter((c) => atMs(c) <= since + GRACE_MS && atMs(c) >= since - window)
    .sort((a, b) => atMs(b) - atMs(a) || PREFERENCE[a.kind]! - PREFERENCE[b.kind]!);
  const newest = candidates[0];
  if (!newest) return null;
  if (newest.kind === "restart") return candidates.find((c) => c.kind === "template" || c.kind === "config") ?? newest;
  return newest;
}

export const causeSummary = (change: Change): ChangeSummary => ({
  at: change.at,
  object: {
    kind: change.object.kind,
    name: change.object.name,
    ...(change.object.namespace ? { namespace: change.object.namespace } : {}),
    ...(change.object.apiVersion ? { apiVersion: change.object.apiVersion } : {}),
  },
  summary: /[.!?]$/.test(change.sentence) ? change.sentence : `${change.sentence}.`,
  ...(change.by ? { by: change.by } : {}),
});

/* Problems ask again on every update: answers are kept for a minute. */
const ANSWER_MS = 60_000;
const answers = new Map<string, { at: number; value: Promise<ChangeSummary | null> }>();

export const likelyCause: LikelyCause = (target, object, since) => {
  const sinceMs = since ? Date.parse(since) : Date.now();
  const at = Number.isFinite(sinceMs) ? sinceMs : Date.now();
  const key = [target.context, target.kubeConfig ?? "", object.kind, object.namespace ?? "", object.name, Math.floor(at / 60_000)].join("\u0000");
  const hit = answers.get(key);
  if (hit && Date.now() - hit.at < ANSWER_MS) return hit.value;
  const value = import("./history")
    .then(({ objectHistory }) =>
      objectHistory({ context: target.context, kubeConfig: target.kubeConfig ?? "" }, object, {
        chain: true,
        window: { from: at - CAUSE_WINDOW_MS, to: at + GRACE_MS },
      })
    )
    .then((changes) => {
      const cause = pickCause(changes, at);
      return cause ? causeSummary(cause) : null;
    })
    .catch(() => null);
  answers.set(key, { at: Date.now(), value });
  if (answers.size > 300) answers.delete(answers.keys().next().value!);
  return value;
};

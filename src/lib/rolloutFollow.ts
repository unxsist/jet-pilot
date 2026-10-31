/*
 * Following a rollout started from JET Pilot until it finishes or gets
 * stuck (pure, unit tested): a verdict per look at the workload, and what
 * to say then, in the words of the side panel's state line.
 */
import yaml from "js-yaml";
import { ROLLOUT_KINDS, rolloutProgress, type RolloutKind, type Workload } from "./rollout";
import { durationWords, plural } from "./resources/format";

/** A workload whose rollout is followed. */
export interface RolloutRef {
  context: string;
  kubeConfig?: string;
  namespace: string;
  kind: RolloutKind;
  name: string;
}

export const isRolloutKind = (kind: string | undefined): kind is RolloutKind =>
  ROLLOUT_KINDS.includes(kind as RolloutKind);

/** What progress looked like, and since when. */
export interface ProgressMark {
  key: string;
  since: number;
}

export type RolloutCheck =
  | { state: "progressing"; mark: ProgressMark }
  | { state: "complete"; detail: string }
  | { state: "stuck"; detail: string }
  | { state: "paused"; detail: string };

/*
 * Deployments report a stuck rollout themselves (ProgressDeadlineExceeded).
 * StatefulSets and DaemonSets have no deadline: one without progress for
 * as long as a Deployment's default deadline counts as stuck.
 */
const DEFAULT_DEADLINE_MS = 600_000;

const versionDetail = (kind: string | undefined, updated: number, desired: number, ready: number) =>
  kind === "DaemonSet"
    ? `${updated} of ${plural(desired, "node")} run the new version, ${ready} ready.`
    : `${updated} of ${plural(desired, "replica")} are on the new version, ${ready} ready.`;

/** One look at the workload; `mark` is what the previous look returned. */
export function checkRollout(workload: Workload, mark: ProgressMark | null, now: number): RolloutCheck {
  const progress = rolloutProgress(workload);
  const { desired, updated, ready } = progress;

  if (progress.phase === "complete") {
    const detail =
      desired === 0
        ? "Scaled to zero."
        : workload.kind === "DaemonSet"
          ? `All ${plural(desired, "node")} run the new version.`
          : desired === 1
            ? "Its replica is on the new version and ready."
            : `All ${plural(desired, "replica")} are on the new version and ready.`;
    return { state: "complete", detail };
  }
  // The controller's message names a ReplicaSet hash; the side panel has it.
  if (progress.phase === "failed") {
    return { state: "stuck", detail: "The new pods didn't become ready in time." };
  }
  if (progress.phase === "paused") {
    return { state: "paused", detail: "Rollouts are paused until it is resumed." };
  }

  const key = [workload.status?.observedGeneration, updated, ready, progress.available].join("/");
  const since = mark && mark.key === key ? mark.since : now;
  if (workload.kind !== "Deployment" && now - since >= DEFAULT_DEADLINE_MS) {
    return {
      state: "stuck",
      detail: `No progress for ${durationWords(now - since)}: ${versionDetail(workload.kind, updated, desired, ready)}`,
    };
  }
  return { state: "progressing", mark: { key, since } };
}

export type FinishedCheck = Exclude<RolloutCheck, { state: "progressing" }>;

export interface RolloutMessage {
  outcome: "complete" | "stuck" | "paused";
  title: string;
  body: string;
  /** The workload to open: the one that's stuck, else the first. */
  ref: RolloutRef;
}

/**
 * The message once every followed workload is done, or one is stuck or
 * paused (that one is the news); null while they're still rolling out.
 * `name` names the whole (a workload, a Helm release, "3 deployments").
 */
export function rolloutMessage(
  name: string,
  results: { ref: RolloutRef; check: RolloutCheck }[]
): RolloutMessage | null {
  const problem = results.find((r) => r.check.state === "stuck" || r.check.state === "paused");
  if (problem) {
    const check = problem.check as FinishedCheck;
    return {
      outcome: check.state,
      title: `${problem.ref.name}'s rollout is ${check.state === "stuck" ? "stuck" : "paused"}`,
      body: check.detail,
      ref: problem.ref,
    };
  }
  if (results.length === 0 || results.some((r) => r.check.state !== "complete")) return null;
  return {
    outcome: "complete",
    title: `${name} rolled out`,
    body:
      results.length === 1
        ? (results[0].check as FinishedCheck).detail
        : results.length === 2
          ? "Both workloads are on the new version."
          : `All ${plural(results.length, "workload")} are on the new version.`,
    ref: results[0].ref,
  };
}

/** "checkout-api", or "3 deployments" for several of one kind. */
export function followName(refs: RolloutRef[]): string {
  if (refs.length === 1) return refs[0].name;
  const kinds = new Set(refs.map((ref) => ref.kind));
  return kinds.size === 1
    ? plural(refs.length, refs[0].kind.toLowerCase())
    : plural(refs.length, "workload");
}

/* ------------------------------------------------- Helm manifests -- */

/**
 * The workloads of a rendered Helm manifest (the ones that roll out), in
 * the release namespace unless they name their own.
 */
export function manifestWorkloads(
  manifest: string,
  target: { context: string; kubeConfig?: string; namespace: string }
): RolloutRef[] {
  let documents: unknown[];
  try {
    documents = yaml.loadAll(manifest);
  } catch {
    return [];
  }
  return documents.flatMap((document) => {
    const object = document as { kind?: string; metadata?: { name?: string; namespace?: string } } | null;
    const name = object?.metadata?.name;
    if (!isRolloutKind(object?.kind) || !name) return [];
    return [{ ...target, namespace: object.metadata?.namespace ?? target.namespace, kind: object.kind, name }];
  });
}

/*
 * Which fixes a problem offers, and the changes they make (pure, unit
 * tested). Every fix runs through the guardrails (./actions); changes to a
 * spec are previewed with a server-side dry run first.
 */
import { parseMemory } from "@/components/tables/metrics";
import type { PodTemplate } from "@/lib/rollout";
import { KINDS, type Problem } from "./model";

export type FixId = "raise-memory" | "rollback" | "restart" | "retry" | "delete-pod" | "delete-evicted";

const ROLLOUT_KINDS = new Set(["Deployment", "StatefulSet", "DaemonSet"]);
const TEMPLATE_KINDS = new Set([...ROLLOUT_KINDS, "CronJob"]);

/** The fixes a problem offers, the most fitting first. */
export function fixesFor(problem: Problem): FixId[] {
  const kind = problem.subject.kind;
  const rollout = ROLLOUT_KINDS.has(kind);
  const fixes: FixId[] = [];
  switch (problem.kind) {
    case "oom":
      if (TEMPLATE_KINDS.has(kind) && memoryTarget(problem)) fixes.push("raise-memory");
      if (rollout) fixes.push("rollback", "restart");
      break;
    case "crashloop":
    case "cant-start":
    case "probe":
      if (rollout) fixes.push("rollback", "restart");
      break;
    case "config":
    case "image-pull":
    case "rollout-stuck":
    case "create-failed":
      if (rollout) fixes.push("rollback");
      break;
    case "job-failed":
    case "cronjob-failed":
      fixes.push("retry");
      break;
    case "stuck-terminating":
      if (problem.findings.some((f) => f.object.kind === "Pod")) fixes.push("delete-pod");
      break;
    case "evicted":
      fixes.push("delete-evicted");
      break;
  }
  return fixes;
}

/** What a fix button says. */
export function fixLabel(fix: FixId, problem: Problem): string {
  switch (fix) {
    case "raise-memory":
      return "Raise memory limit…";
    case "rollback":
      return "Roll back…";
    case "restart":
      return "Restart";
    case "retry":
      return problem.subject.kind === "CronJob" ? "Run now" : "Retry";
    case "delete-pod":
      return "Delete pod…";
    case "delete-evicted":
      return "Delete evicted pods";
  }
}

/* Containers that never started have no logs to show. */
const NO_LOGS = new Set(["image-pull", "config"]);

/** Whether a container log can explain the problem (see ./evidence logSource). */
export const hasLogs = (problem: Problem) =>
  problem.findings.some((f) => f.object.kind === "Pod" && f.container && !NO_LOGS.has(f.kind)) ||
  problem.kind === "job-failed" ||
  problem.kind === "cronjob-failed";

/* Rolling back fits these when every pod has them: the version is what's broken. */
const VERSION_KINDS = new Set(["oom", "crashloop", "image-pull", "cant-start"]);

/**
 * The fix worth the primary button, if one is clearly right: more memory
 * for a container that ran out, a retry, deleting what's stuck, or rolling
 * back when a change explains the problem, the rollout stalled, or every
 * pod of the new version is broken. Otherwise looking (the logs) comes first.
 */
export function primaryFix(problem: Problem, causeFound: boolean): FixId | null {
  const everyPod = !problem.pods || problem.pods.affected >= problem.pods.total;
  for (const fix of fixesFor(problem)) {
    if (fix === "raise-memory" || fix === "retry" || fix === "delete-pod" || fix === "delete-evicted") return fix;
    if (
      fix === "rollback" &&
      (causeFound || problem.findings.some((f) => f.kind === "rollout-stuck") || (everyPod && VERSION_KINDS.has(problem.kind)))
    ) {
      return fix;
    }
  }
  return null;
}

/* Problems a recent change can explain (not a stuck pod, an eviction or a node in trouble). */
const CHANGE_FAMILIES = new Set(["crash", "config", "image", "schedule", "start", "probe", "rollout", "job", "storage"]);
export const changeCanExplain = (problem: Problem) => CHANGE_FAMILIES.has(KINDS[problem.kind].family) && problem.kind !== "pvc-lost";

/** The container that ran out of memory, with its limit; null without a limit to raise. */
export function memoryTarget(problem: Problem): { container: string; init: boolean } | null {
  const finding = problem.findings.find((f) => f.kind === "oom" && f.container && f.memoryLimit);
  return finding ? { container: finding.container!, init: !!finding.init } : null;
}

const MI = 1024 ** 2;

/** Half as much again, rounded up to 64 Mi: 256Mi → 384Mi, 1Gi → 1536Mi, 4Gi → 6Gi. */
export function suggestMemoryLimit(current: string): string {
  const bytes = parseMemory(current);
  if (!bytes) return current;
  const mi = Math.ceil((bytes * 1.5) / MI / 64) * 64;
  return mi % 1024 === 0 ? `${mi / 1024}Gi` : `${mi}Mi`;
}

/** A memory quantity Kubernetes accepts, larger than nothing. */
export const validMemory = (value: string) => /^\d+(\.\d+)?(Ki|Mi|Gi|Ti|k|M|G|T)?$/.test(value.trim()) && parseMemory(value.trim()) > 0;

/** The containers path of a workload's pod template. */
function templatePatch(kind: string, spec: Record<string, unknown>) {
  const template = { template: { spec } };
  return kind === "CronJob" ? { spec: { jobTemplate: { spec: template } } } : { spec: template };
}

/** Strategic merge patch that sets one container's memory limit. */
export function memoryPatch(kind: string, target: { container: string; init: boolean }, limit: string) {
  return templatePatch(kind, {
    [target.init ? "initContainers" : "containers"]: [{ name: target.container, resources: { limits: { memory: limit.trim() } } }],
  });
}

/** The pod template of a workload. */
export function templateOf(object: any): PodTemplate | undefined {
  return object?.kind === "CronJob" ? object?.spec?.jobTemplate?.spec?.template : object?.spec?.template;
}

/** A container's memory limit in a workload. */
export function memoryLimitOf(object: any, target: { container: string; init: boolean }): string | undefined {
  const containers: any[] = (templateOf(object)?.spec as any)?.[target.init ? "initContainers" : "containers"] ?? [];
  return containers.find((c) => c.name === target.container)?.resources?.limits?.memory;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/*
 * The fields of a pod template that differ between the revision rolled
 * back to and the current one, as a patch: what to change in Git or the
 * chart's values instead of rolling back here. Containers are matched by
 * name and only their changed fields are kept.
 */
export function revertPatch(kind: string, current: PodTemplate | undefined, previous: PodTemplate | undefined): object | null {
  const now: Record<string, any> = current?.spec ?? {};
  const before: Record<string, any> = previous?.spec ?? {};
  const spec: Record<string, unknown> = {};
  for (const key of new Set([...Object.keys(now), ...Object.keys(before)])) {
    if (key === "containers" || key === "initContainers") {
      const changed = (before[key] ?? []).flatMap((container: any) => {
        const live = (now[key] ?? []).find((c: any) => c.name === container.name) ?? {};
        const fields = Object.keys(container).filter((field) => field !== "name" && !same(container[field], live[field]));
        return fields.length ? [{ name: container.name, ...Object.fromEntries(fields.map((f) => [f, container[f]])) }] : [];
      });
      if (changed.length) spec[key] = changed;
    } else if (!same(now[key], before[key])) {
      spec[key] = before[key] ?? null;
    }
  }
  return Object.keys(spec).length ? templatePatch(kind, spec) : null;
}

/* Labels the Job controller adds; a copy gets its own. */
const JOB_LABELS = ["controller-uid", "batch.kubernetes.io/controller-uid", "job-name", "batch.kubernetes.io/job-name"];
const withoutJobLabels = (labels: Record<string, string> | undefined) =>
  labels ? Object.fromEntries(Object.entries(labels).filter(([key]) => !JOB_LABELS.includes(key))) : undefined;

/** A new Job with the spec of a failed one: what "Retry" creates. */
export function retryJob(job: any) {
  const spec = { ...job.spec };
  delete spec.selector;
  delete spec.manualSelector;
  const template = spec.template ?? {};
  spec.template = { ...template, metadata: { ...template.metadata, labels: withoutJobLabels(template.metadata?.labels) } };
  return {
    apiVersion: "batch/v1",
    kind: "Job",
    metadata: {
      // Names are at most 63 characters; the API server adds 5.
      generateName: `${String(job.metadata?.name ?? "job").slice(0, 51)}-retry-`,
      namespace: job.metadata?.namespace,
      labels: withoutJobLabels(job.metadata?.labels),
    },
    spec,
  };
}

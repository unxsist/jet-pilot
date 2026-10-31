/*
 * Findings per object (pure, unit tested): what is broken about one pod,
 * node, Deployment, Job, CronJob or claim right now, from its status alone.
 * Healthy objects return nothing, quickly: every pod of every active
 * cluster passes through here on each change.
 *
 * Warning events only add detail (which probe fails, why a claim can't
 * bind); they never make a problem on their own, so the count is the same
 * whether they are watched or not.
 */
import { ago, plural, toMs } from "@/lib/resources/format";
import { nodeHealth } from "@/lib/resources/node";
import type { Finding, Ref } from "./model";
import {
  claimWords,
  configWords,
  createWords,
  evictionWords,
  exitWords,
  messageWords,
  mountWords,
  nodeConditionWords,
  probeWords,
  pullWords,
  schedulingWords,
} from "./words";

/* A pod that isn't ready this soon after its last change is still starting. */
const STARTING_MS = 60_000;
/* Creating containers this long means something is in the way (a mount, a sandbox). */
const STUCK_STARTING_MS = 5 * 60_000;
/* A container running again after a crash this recent still counts. */
const RECENT_CRASH_MS = 30 * 60_000;
/* Restarts after which a recently crashed container counts as crashing. */
const FLAPPING_RESTARTS = 3;
/* Like the pod side panel: a minute past its grace period is stuck. */
const TERMINATING_MS = 60_000;
/* A claim gets this long to bind before it counts as stuck. */
const CLAIM_MS = 60_000;
/* Failed Jobs nobody cleaned up stop counting after a week. */
const OLD_JOB_MS = 7 * 24 * 3600_000;

export const refOf = (object: any, kind = object?.kind ?? ""): Ref => ({
  kind,
  name: object?.metadata?.name ?? "",
  namespace: object?.metadata?.namespace || undefined,
  uid: object?.metadata?.uid,
});

const condition = (object: any, type: string) =>
  (object?.status?.conditions ?? []).find((c: any) => c.type === type);

const ms = (value: unknown) => toMs(value) ?? undefined;

/* ------------------------------------------------------------- pods -- */

function containerFinding(status: any, spec: any, pod: Ref, now: number, restartPolicy: string | undefined, init: boolean): Finding | null {
  const waiting = status.state?.waiting;
  const terminated = status.state?.terminated;
  const last = status.lastState?.terminated;
  const restarts = status.restartCount ?? 0;
  const base = { object: pod, container: status.name as string, ...(init ? { init } : {}), restarts };
  const limit = spec?.resources?.limits?.memory;
  const oom = (at: unknown): Finding => ({
    ...base,
    kind: "oom",
    short: limit ? `Over its ${limit} memory limit` : "Used more memory than the node had",
    exitCode: 137,
    ...(limit ? { memoryLimit: limit } : {}),
    lastSeen: ms(at),
  });
  const crash = (state: any): Finding =>
    state?.reason === "OOMKilled"
      ? oom(state.finishedAt)
      : { ...base, kind: "crashloop", short: exitWords(state?.exitCode), exitCode: state?.exitCode, message: state?.message, lastSeen: ms(state?.finishedAt) };

  switch (waiting?.reason) {
    case "CrashLoopBackOff":
      return crash(last);
    case "ImagePullBackOff":
    case "ErrImagePull":
    case "ErrImageNeverPull":
    case "InvalidImageName":
      return { ...base, kind: "image-pull", short: status.image || spec?.image || "Its image", message: waiting.message };
    case "CreateContainerConfigError": {
      const words = configWords(waiting.message);
      return { ...base, kind: "config", label: words.label, short: words.short, message: waiting.message };
    }
    case "CreateContainerError":
    case "RunContainerError":
      return { ...base, kind: "cant-start", short: messageWords(waiting.message, "The container runtime can't start it"), message: waiting.message };
  }
  if (terminated && terminated.exitCode !== 0 && restartPolicy !== "Never") return crash(terminated);

  // Running again after a crash: an out-of-memory kill counts, and so do
  // repeated crashes (a liveness probe restarting it, say).
  const lastAt = toMs(last?.finishedAt);
  if (status.state?.running && last && last.exitCode !== 0 && lastAt !== null && now - lastAt < RECENT_CRASH_MS) {
    if (last.reason === "OOMKilled") return oom(last.finishedAt);
    if (restarts >= FLAPPING_RESTARTS) {
      return { ...crash(last), short: `Restarted ${plural(restarts, "time")}, last ${ago(lastAt, now)}` };
    }
  }
  return null;
}

/** What's wrong with a pod: nothing, or one finding per failing container. */
export function podFindings(pod: any, now = Date.now()): Finding[] {
  const status = pod?.status ?? {};
  const spec = pod?.spec ?? {};
  const ref = refOf(pod, "Pod");

  const deletion = toMs(pod?.metadata?.deletionTimestamp);
  if (deletion !== null) {
    // deletionTimestamp is when the grace period ends.
    return now - deletion > TERMINATING_MS
      ? [{ kind: "stuck-terminating", object: ref, short: `Its grace period ended ${ago(deletion, now)}`, since: deletion }]
      : [];
  }
  if (status.phase === "Succeeded") return [];
  if (status.reason === "Evicted") {
    const at = latest((status.conditions ?? []).map((c: any) => c.lastTransitionTime)) ?? ms(status.startTime);
    return [{ kind: "evicted", object: ref, short: evictionWords(status.message), message: status.message, since: at, lastSeen: at }];
  }

  const statuses: any[] = status.containerStatuses ?? [];
  if (status.phase === "Failed") {
    // A Job's failed pods are its evidence; the Job itself is the problem.
    if ((pod.metadata?.ownerReferences ?? []).some((o: any) => o.kind === "Job")) return [];
    const failed = statuses.find((c) => (c.state?.terminated?.exitCode ?? 0) !== 0)?.state?.terminated;
    const at = ms(failed?.finishedAt);
    return [{ kind: "crashloop", label: "Failed", object: ref, short: failed ? exitWords(failed.exitCode) : evictionWords(status.message), exitCode: failed?.exitCode, message: status.message ?? failed?.message, since: at, lastSeen: at }];
  }

  const scheduled = condition(pod, "PodScheduled");
  if (status.phase === "Pending" && scheduled?.status === "False") {
    return [{ kind: "unschedulable", object: ref, short: schedulingWords(scheduled.message), message: scheduled.message, since: ms(scheduled.lastTransitionTime) ?? ms(pod.metadata?.creationTimestamp) }];
  }

  const ready = condition(pod, "Ready");
  const notReadySince = ready?.status === "False" ? ms(ready.lastTransitionTime) : undefined;
  const findings: Finding[] = [];
  // Init containers run one at a time: the first one that fails blocks the rest.
  for (const init of status.initContainerStatuses ?? []) {
    if (init.state?.terminated?.exitCode === 0) continue;
    const initSpec = spec.initContainers?.find((c: any) => c.name === init.name);
    // Sidecars run next to the app: only one that can't start counts.
    if (initSpec?.restartPolicy === "Always" && !init.state?.waiting) continue;
    const finding = containerFinding(init, initSpec, ref, now, spec.restartPolicy, true);
    if (finding) findings.push(finding);
    break;
  }
  for (const container of statuses) {
    const containerSpec = spec.containers?.find((c: any) => c.name === container.name);
    const finding = containerFinding(container, containerSpec, ref, now, spec.restartPolicy, false);
    if (finding) findings.push(finding);
  }
  if (findings.length) return findings.map((f) => ({ ...f, since: f.since ?? notReadySince }));

  const scheduledAt = toMs(scheduled?.lastTransitionTime) ?? toMs(pod.metadata?.creationTimestamp);
  const creating = statuses.length === 0 || statuses.every((c) => c.state?.waiting?.reason === "ContainerCreating");
  if (status.phase === "Pending" && creating && scheduledAt !== null && now - scheduledAt > STUCK_STARTING_MS) {
    return [{ kind: "stuck-starting", object: ref, short: `Creating its containers for ${ago(scheduledAt, now).replace(/ ago$/, "")}`, since: scheduledAt }];
  }

  if (status.phase === "Running" && notReadySince !== undefined && now - notReadySince > STARTING_MS) {
    const probed = statuses.filter(
      (c) => !c.ready && c.state?.running && spec.containers?.find((s: any) => s.name === c.name)?.readinessProbe
    );
    if (probed.length) {
      const single = (spec.containers?.length ?? 0) <= 1;
      return probed.map((c) => ({
        kind: "probe" as const,
        object: ref,
        container: c.name,
        short: single ? "Its readiness probe doesn't pass" : `The readiness probe of ${c.name} doesn't pass`,
        since: notReadySince,
      }));
    }
  }
  return [];
}

const latest = (values: unknown[]) => {
  const times = values.map(toMs).filter((t): t is number => t !== null);
  return times.length ? Math.max(...times) : undefined;
};

/* ------------------------------------------------------------ nodes -- */

/** A node that isn't ready, or one under pressure (memory, disk, processes). */
export function nodeFindings(node: any): Finding[] {
  const health = nodeHealth(node);
  const ref = refOf(node, "Node");
  if (health.ready !== "True") {
    const unknown = health.ready === "Unknown";
    return [
      {
        kind: "node-not-ready",
        object: ref,
        label: unknown ? "Not responding" : "Not ready",
        short: unknown ? "The kubelet stopped reporting" : messageWords(health.readyMessage, "The kubelet says it isn't ready"),
        message: health.readyMessage,
        since: ms(health.readySince),
      },
    ];
  }
  return health.problems.map((problem) => ({
    kind: "node-pressure" as const,
    object: ref,
    ...nodeConditionWords(problem.type, problem.label, problem.message),
    message: problem.message,
    since: ms(problem.since),
  }));
}

/* ------------------------------------------------- workloads, jobs -- */

/** A Deployment whose rollout stalled or that can't create its pods. */
export function deploymentFindings(deployment: any): Finding[] {
  if (deployment?.spec?.paused) return [];
  const ref = refOf(deployment, "Deployment");
  const findings: Finding[] = [];
  const failure = condition(deployment, "ReplicaFailure");
  if (failure?.status === "True") {
    findings.push({ kind: "create-failed", object: ref, short: createWords(failure.message), message: failure.message, since: ms(failure.lastTransitionTime) });
  }
  const progressing = condition(deployment, "Progressing");
  if (progressing?.status === "False" && progressing.reason === "ProgressDeadlineExceeded") {
    findings.push({
      kind: "rollout-stuck",
      object: ref,
      short: "The new pods didn't become ready in time",
      message: progressing.message,
      since: ms(progressing.lastTransitionTime),
    });
  }
  return findings;
}

/** How a failed Job gave up, in words; null while it hasn't failed. */
export function jobFailure(job: any): { short: string; message?: string; at?: number } | null {
  const failed = condition(job, "Failed");
  if (failed?.status !== "True") return null;
  const status = job.status ?? {};
  const short =
    failed.reason === "BackoffLimitExceeded"
      ? `Failed ${plural(status.failed ?? 0, "time")} and gave up`
      : failed.reason === "DeadlineExceeded"
        ? "Ran past its deadline"
        : messageWords(failed.message, "It failed");
  return { short, message: failed.message, at: ms(failed.lastTransitionTime) ?? ms(status.completionTime) ?? ms(status.startTime) };
}

/** A Job that failed (in the last week). */
export function jobFindings(job: any, now = Date.now()): Finding[] {
  const failure = jobFailure(job);
  if (!failure || (failure.at !== undefined && now - failure.at > OLD_JOB_MS)) return [];
  return [{ kind: "job-failed", object: refOf(job, "Job"), short: failure.short, message: failure.message, since: failure.at, lastSeen: failure.at }];
}

/**
 * A CronJob whose last run failed: its newest Job failed, or (without its
 * Jobs, cleaned up already) its last schedule never succeeded.
 */
export function cronJobFindings(cronJob: any, jobs: any[], now = Date.now()): Finding[] {
  const spec = cronJob?.spec ?? {};
  const status = cronJob?.status ?? {};
  if (spec.suspend || (status.active?.length ?? 0) > 0) return [];
  const ref = refOf(cronJob, "CronJob");
  const newest = [...jobs].sort((a, b) => (toMs(b.metadata?.creationTimestamp) ?? 0) - (toMs(a.metadata?.creationTimestamp) ?? 0))[0];
  if (newest) {
    const failure = jobFailure(newest);
    if (!failure) return [];
    return [{ kind: "cronjob-failed", object: ref, short: failure.short, message: failure.message, since: failure.at, lastSeen: failure.at }];
  }
  const scheduled = toMs(status.lastScheduleTime);
  const succeeded = toMs(status.lastSuccessfulTime);
  if (scheduled === null || (succeeded !== null && succeeded >= scheduled)) return [];
  return [
    {
      kind: "cronjob-failed",
      object: ref,
      short: succeeded !== null ? `The last success was ${ago(succeeded, now)}` : "It hasn't succeeded yet",
      since: scheduled,
      lastSeen: scheduled,
    },
  ];
}

/* ----------------------------------------------------------- claims -- */

/** A claim whose volume is gone, or one still waiting for a volume. */
export function claimFindings(claim: any, now = Date.now()): Finding[] {
  const phase = claim?.status?.phase;
  const ref = refOf(claim, "PersistentVolumeClaim");
  if (phase === "Lost") return [{ kind: "pvc-lost", object: ref, short: "The volume it was bound to is gone" }];
  const created = toMs(claim?.metadata?.creationTimestamp);
  if (phase === "Pending" && created !== null && now - created > CLAIM_MS) {
    return [{ kind: "pvc-pending", object: ref, short: `${ref.name} isn't bound to a volume`, since: created }];
  }
  return [];
}

/** The claims a pod mounts (generic ephemeral volumes included). */
export function podClaims(pod: any): string[] {
  return (pod?.spec?.volumes ?? []).flatMap((volume: any) =>
    volume.persistentVolumeClaim?.claimName
      ? [volume.persistentVolumeClaim.claimName]
      : volume.ephemeral
        ? [`${pod.metadata?.name}-${volume.name}`]
        : []
  );
}

/* ----------------------------------------------------------- events -- */

/** Warning events by the object they're about: "Pod/checkout/checkout-api-7d9-x2". */
export type EventIndex = Map<string, any[]>;

export const eventKey = (kind: string, namespace: string | undefined, name: string) => `${kind}/${namespace ?? ""}/${name}`;

/** Warning events of one context, newest first per object. */
export function indexEvents(events: any[]): EventIndex {
  const index: EventIndex = new Map();
  for (const event of events) {
    if (event.type !== "Warning") continue;
    const involved = event.involvedObject ?? event.regarding ?? {};
    const key = eventKey(involved.kind, involved.namespace, involved.name);
    const list = index.get(key);
    if (list) list.push(event);
    else index.set(key, [event]);
  }
  for (const list of index.values()) list.sort((a, b) => (eventTime(b) ?? 0) - (eventTime(a) ?? 0));
  return index;
}

export const eventTime = (event: any) =>
  toMs(event.series?.lastObservedTime ?? event.lastTimestamp ?? event.eventTime ?? event.firstTimestamp ?? event.metadata?.creationTimestamp) ?? undefined;

/* Probe failures older than this no longer explain a restart. */
const PROBE_EVENT_MS = 15 * 60_000;

/**
 * Detail from warning events: which probe fails and how, why containers
 * can't be created, why an image can't be pulled, why a claim can't bind.
 */
export function withEvents(finding: Finding, index: EventIndex, now = Date.now()): Finding {
  const events = index.get(eventKey(finding.object.kind, finding.object.namespace, finding.object.name));
  if (!events?.length) return finding;
  const find = (reasons: string[], match?: (event: any) => boolean) =>
    events.find((e) => reasons.includes(e.reason) && (!match || match(e)));

  switch (finding.kind) {
    case "probe":
    case "crashloop": {
      const unhealthy = find(["Unhealthy"], (e) => {
        const probe = probeWords(e.message);
        if (!probe) return false;
        // Readiness explains not being ready; liveness and startup explain restarts.
        if ((finding.kind === "probe") !== (probe.type === "Readiness")) return false;
        const at = eventTime(e);
        return finding.kind === "probe" || (at !== undefined && now - at < PROBE_EVENT_MS);
      });
      const probe = unhealthy && probeWords(unhealthy.message);
      if (!probe) return finding;
      return { ...finding, label: `${probe.type} probe failing`, short: probe.short, message: unhealthy.message, lastSeen: eventTime(unhealthy) ?? finding.lastSeen };
    }
    case "stuck-starting": {
      const mount = find(["FailedMount", "FailedAttachVolume", "FailedCreatePodSandBox"]);
      return mount ? { ...finding, short: mountWords(mount.message), message: mount.message, lastSeen: eventTime(mount) } : finding;
    }
    case "image-pull": {
      const failed = find(["Failed"], (e) => /pull/i.test(e.message ?? ""));
      return failed ? { ...finding, short: pullWords(finding.short, failed.message), message: failed.message, lastSeen: eventTime(failed) } : finding;
    }
    case "unschedulable": {
      const failed = find(["FailedScheduling"]);
      return failed ? { ...finding, short: schedulingWords(failed.message), message: failed.message, lastSeen: eventTime(failed) } : finding;
    }
    case "pvc-pending": {
      const failed = find(["ProvisioningFailed", "ExternalProvisioning", "WaitForFirstConsumer"]);
      return failed ? { ...finding, short: claimWords(failed.message), message: failed.message, lastSeen: eventTime(failed) } : finding;
    }
    default:
      return finding;
  }
}

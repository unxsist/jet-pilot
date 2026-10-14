/*
 * The state of an object in a word and a sentence (pure, unit tested), for
 * the top of its side panel and its describe: healthy objects stay quiet,
 * problems say what is wrong and since when. Kinds without a meaningful
 * state return null.
 */
import { nextCronRun } from "./cron";
import { ago, between, fromNow, plural, sentence, toMs } from "./format";
import { nodeHealth } from "./node";
import { podState, type ObjectState } from "./pod";

export type { ObjectState } from "./pod";

const condition = (object: any, type: string) =>
  (object?.status?.conditions ?? []).find((c: any) => c.type === type);

/* Deployments, StatefulSets, DaemonSets and ReplicaSets. */
function workloadState(object: any): ObjectState {
  const kind = object.kind;
  const status = object.status ?? {};
  const daemon = kind === "DaemonSet";
  const desired = daemon ? (status.desiredNumberScheduled ?? 0) : (object.spec?.replicas ?? 1);
  const ready = daemon ? (status.numberReady ?? 0) : (status.readyReplicas ?? 0);
  // Controllers leave the count out until a rollout touches it.
  const updated = daemon ? (status.updatedNumberScheduled ?? desired) : (status.updatedReplicas ?? desired);
  const progressing = condition(object, "Progressing");

  if (object.spec?.paused) return { label: "Paused", tone: "muted", detail: "Rollouts are paused until it is resumed." };
  if (progressing?.status === "False" && progressing.reason === "ProgressDeadlineExceeded") {
    return {
      label: "Rollout stuck",
      tone: "destructive",
      detail: sentence(progressing.message ?? "The new pods didn't become ready in time."),
      since: progressing.lastTransitionTime,
    };
  }
  if (desired === 0) {
    return { label: daemon ? "No nodes" : "Scaled to zero", tone: "muted", detail: daemon ? "No node matches its node selector." : undefined };
  }
  const stale =
    (object.metadata?.generation ?? 0) > (status.observedGeneration ?? object.metadata?.generation ?? 0) ||
    (kind === "StatefulSet" && !!status.updateRevision && status.currentRevision !== status.updateRevision);
  if (kind !== "ReplicaSet" && (stale || updated < desired)) {
    return {
      label: "Rolling out",
      tone: "warning",
      detail: `${updated} of ${desired} ${daemon ? "nodes run" : "replicas are on"} the new version, ${ready} ready.`,
    };
  }
  if (ready < desired) {
    return {
      label: ready === 0 ? "Unavailable" : "Degraded",
      tone: ready === 0 ? "destructive" : "warning",
      detail: `${ready} of ${plural(desired, daemon ? "pod" : "replica")} ready.`,
    };
  }
  return { label: "Available", tone: "success", detail: undefined };
}

function jobState(job: any, now: number): ObjectState {
  const status = job.status ?? {};
  const failed = condition(job, "Failed");
  const complete = condition(job, "Complete");
  if (failed?.status === "True") {
    const limit = job.spec?.backoffLimit;
    const detail =
      failed.reason === "BackoffLimitExceeded"
        ? `It failed ${plural(status.failed ?? 0, "time")} and gave up${limit !== undefined ? ` (backoff limit ${limit})` : ""}.`
        : failed.reason === "DeadlineExceeded"
          ? "It ran longer than its deadline and was stopped."
          : sentence(failed.message ?? "");
    return { label: "Failed", tone: "destructive", detail, since: failed.lastTransitionTime ?? status.completionTime };
  }
  if (complete?.status === "True" || status.completionTime) {
    const took = between(status.startTime, status.completionTime);
    return {
      label: "Completed",
      tone: "muted",
      detail: `Finished ${ago(status.completionTime ?? complete?.lastTransitionTime, now)}${took ? `, after ${took}` : ""}.`,
      since: status.completionTime,
    };
  }
  if (job.spec?.suspend) return { label: "Suspended", tone: "muted", detail: "It doesn't start pods until it is resumed." };
  return {
    label: "Running",
    tone: "info",
    detail: `${plural(status.active ?? 0, "pod")} running${status.failed ? `, ${plural(status.failed, "failure")} so far` : ""}.`,
    since: status.startTime,
  };
}

function cronJobState(cronJob: any, now: number): ObjectState {
  const spec = cronJob.spec ?? {};
  const status = cronJob.status ?? {};
  if (spec.suspend) return { label: "Suspended", tone: "muted", detail: "It doesn't run until it is resumed." };
  const active = status.active?.length ?? 0;
  if (active > 0) {
    return { label: "Running", tone: "info", detail: `${plural(active, "job")} running, started ${ago(status.lastScheduleTime, now)}.`, since: status.lastScheduleTime };
  }
  const lastSchedule = toMs(status.lastScheduleTime);
  const lastSuccess = toMs(status.lastSuccessfulTime);
  if (lastSchedule !== null && (lastSuccess === null || lastSuccess < lastSchedule)) {
    return {
      label: "Last run failed",
      tone: "destructive",
      detail: `The run of ${ago(lastSchedule, now)} didn't succeed${lastSuccess !== null ? `; the last success was ${ago(lastSuccess, now)}` : ""}.`,
      since: status.lastScheduleTime,
    };
  }
  const next = nextCronRun(spec.schedule ?? "", now, spec.timeZone || "UTC");
  return { label: "Scheduled", tone: "success", detail: next ? `Next run ${fromNow(next, now)}.` : undefined };
}

function hpaState(hpa: any): ObjectState {
  const spec = hpa.spec ?? {};
  const status = hpa.status ?? {};
  const able = condition(hpa, "AbleToScale");
  const active = condition(hpa, "ScalingActive");
  const limited = condition(hpa, "ScalingLimited");
  if (able?.status === "False") {
    return { label: "Can't scale", tone: "destructive", detail: sentence(able.message ?? "It can't change the target's replicas."), since: able.lastTransitionTime };
  }
  if (active?.status === "False") {
    return {
      label: active.reason === "ScalingDisabled" ? "Scaling off" : "Can't read metrics",
      tone: active.reason === "ScalingDisabled" ? "muted" : "warning",
      detail: sentence(active.message ?? "It can't compute a replica count."),
      since: active.lastTransitionTime,
    };
  }
  if (limited?.status === "True" && (status.currentReplicas ?? 0) >= spec.maxReplicas) {
    return {
      label: "At its maximum",
      tone: "warning",
      detail: `It wants more replicas but stops at ${spec.maxReplicas}.`,
      since: limited.lastTransitionTime,
    };
  }
  return { label: "Active", tone: "success" };
}

/** The state of any object; null for kinds without one (ConfigMaps, ...). */
export function objectState(object: any, now = Date.now()): ObjectState | null {
  const status = object?.status ?? {};
  switch (object?.kind) {
    case "Pod":
      return podState(object, now);
    case "Node": {
      const health = nodeHealth(object);
      if (health.ready !== "True") {
        return {
          label: health.ready === "False" ? "Not ready" : "Not responding",
          tone: "destructive",
          detail: sentence(health.readyMessage ?? (health.ready === "Unknown" ? "The kubelet stopped reporting." : "")) || undefined,
          since: health.readySince,
        };
      }
      if (health.problems.length) {
        const [problem] = health.problems;
        return {
          label: health.problems.length > 1 ? `${problem!.label} and more` : problem!.label,
          tone: "warning",
          detail: sentence(problem!.message ?? "The kubelet may evict pods to recover.") || undefined,
          since: problem!.since,
        };
      }
      if (object.spec?.unschedulable) {
        return { label: "Cordoned", tone: "warning", detail: "No new pods are scheduled here; running pods stay." };
      }
      return { label: "Ready", tone: "success", since: health.readySince };
    }
    case "Deployment":
    case "StatefulSet":
    case "DaemonSet":
    case "ReplicaSet":
      return workloadState(object);
    case "Job":
      return jobState(object, now);
    case "CronJob":
      return cronJobState(object, now);
    case "HorizontalPodAutoscaler":
      return hpaState(object);
    case "PersistentVolumeClaim":
      if (status.phase === "Bound") return { label: "Bound", tone: "success" };
      if (status.phase === "Lost") return { label: "Volume lost", tone: "destructive", detail: "The volume it was bound to no longer exists." };
      return { label: "Pending", tone: "warning", detail: "No volume is bound to it yet.", since: object.metadata?.creationTimestamp };
    case "PersistentVolume":
      switch (status.phase) {
        case "Bound":
          return { label: "Bound", tone: "success" };
        case "Available":
          return { label: "Available", tone: "success", detail: "Not claimed yet." };
        case "Released":
          return {
            label: "Released",
            tone: "warning",
            detail: `Its claim was deleted; reclaim policy ${object.spec?.persistentVolumeReclaimPolicy ?? "Retain"} keeps it until someone cleans it up.`,
          };
        case "Failed":
          return { label: "Failed", tone: "destructive", detail: sentence(status.message ?? "Reclaiming it failed.") };
        default:
          return status.phase ? { label: status.phase, tone: "warning" } : null;
      }
    case "Namespace":
      if (status.phase === "Terminating") {
        const stuck = (status.conditions ?? []).find((c: any) => c.status === "True" && /Failure|Remaining/.test(c.type));
        return {
          label: "Terminating",
          tone: "warning",
          detail: stuck ? sentence(stuck.message ?? "") : "Its objects are being deleted.",
          since: object.metadata?.deletionTimestamp,
        };
      }
      return null;
    case "Service":
      if (object.spec?.type === "LoadBalancer" && !status.loadBalancer?.ingress?.length) {
        return { label: "Waiting for a load balancer", tone: "warning", detail: "The cloud provider hasn't assigned an address yet.", since: object.metadata?.creationTimestamp };
      }
      return null;
    case "Ingress":
      if (!status.loadBalancer?.ingress?.length) {
        return { label: "No address yet", tone: "warning", detail: "No ingress controller has picked it up (yet).", since: object.metadata?.creationTimestamp };
      }
      return null;
    default:
      return null;
  }
}

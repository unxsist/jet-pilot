import type {
  CoreV1Event,
  V1ContainerStatus,
  V1Deployment,
  V1Node,
  V1Pod,
} from "@kubernetes/client-node";
import { toDate } from "./age";

/*
 * Status classification for table cells. Pure functions so they can be unit
 * tested; tones map onto classes that work in both light and dark mode.
 */

export type StatusTone = "success" | "warning" | "destructive" | "muted" | "none";

export const toneClasses: Record<StatusTone, string> = {
  success: "text-success",
  warning: "text-warning",
  destructive: "text-destructive",
  muted: "text-muted-foreground",
  none: "",
};

export const toneClass = (tone: StatusTone): string => toneClasses[tone];

/* ---------------------------------------------------------------- Pods -- */

const containerReason = (status: V1ContainerStatus): string | undefined =>
  status.state?.waiting?.reason || status.state?.terminated?.reason;

/**
 * Pod status as shown by `kubectl get pods`: Terminating, a failing init
 * container (`Init:<reason>`), the first waiting / terminated container
 * reason, the pod reason (e.g. Evicted) or the phase.
 */
export function getPodStatus(pod: V1Pod): string {
  if (pod.metadata?.deletionTimestamp) {
    return "Terminating";
  }

  const initStatuses = pod.status?.initContainerStatuses || [];
  for (const [index, init] of initStatuses.entries()) {
    const terminated = init.state?.terminated;
    if (terminated && terminated.exitCode === 0) {
      continue;
    }

    if (terminated) {
      return `Init:${terminated.reason || "Error"}`;
    }

    const waitingReason = init.state?.waiting?.reason;
    if (waitingReason && waitingReason !== "PodInitializing") {
      return `Init:${waitingReason}`;
    }

    return `Init:${index}/${initStatuses.length}`;
  }

  for (const status of pod.status?.containerStatuses || []) {
    const reason = containerReason(status);
    if (reason) {
      return reason;
    }
  }

  return pod.status?.reason || pod.status?.phase || "Unknown";
}

const destructivePodReasons = new Set([
  "CrashLoopBackOff",
  "ImagePullBackOff",
  "ErrImagePull",
  "ErrImageNeverPull",
  "InvalidImageName",
  "OOMKilled",
  "Error",
  "Failed",
  "Evicted",
  "CreateContainerConfigError",
  "CreateContainerError",
  "RunContainerError",
  "ContainerStatusUnknown",
  "Terminating",
]);

const warningPodReasons = new Set([
  "Pending",
  "ContainerCreating",
  "PodInitializing",
  "Unknown",
]);

export function getPodStatusTone(status: string): StatusTone {
  const reason = status.startsWith("Init:") ? status.slice(5) : status;

  if (destructivePodReasons.has(reason)) return "destructive";
  if (status === "Running") return "success";
  if (status === "Completed" || status === "Succeeded") return "muted";
  if (warningPodReasons.has(reason) || status.startsWith("Init:")) {
    return "warning";
  }

  return "none";
}

/** Ready / total containers; falls back to the spec when statuses are missing. */
export function getPodReadiness(pod: V1Pod): { ready: number; total: number } {
  const statuses = pod.status?.containerStatuses;
  if (!statuses?.length) {
    return { ready: 0, total: pod.spec?.containers?.length ?? 0 };
  }

  return {
    ready: statuses.filter((c) => c.ready).length,
    total: statuses.length,
  };
}

export function getPodReadinessTone(pod: V1Pod): StatusTone {
  if (pod.status?.phase === "Succeeded") return "muted";

  const { ready, total } = getPodReadiness(pod);
  return ready < total ? "warning" : "none";
}

export function getPodRestarts(pod: V1Pod): number {
  return (pod.status?.containerStatuses || []).reduce(
    (acc, curr) => acc + (curr.restartCount || 0),
    0
  );
}

export const getRestartsTone = (restarts: number): StatusTone =>
  restarts > 0 ? "warning" : "none";

/* --------------------------------------------------------------- Nodes -- */

/**
 * Node status as shown by `kubectl get nodes`: derived from the Ready
 * condition's status (not the last condition's type) plus
 * `spec.unschedulable` (cordoned) - not from NoSchedule taints, which are
 * also used for dedicated / control-plane nodes.
 */
export function getNodeStatus(node: V1Node): string {
  const ready = node.status?.conditions?.find((c) => c.type === "Ready");

  let status = "Unknown";
  if (ready?.status === "True") status = "Ready";
  else if (ready?.status === "False") status = "NotReady";

  return node.spec?.unschedulable ? `${status},SchedulingDisabled` : status;
}

export function getNodeStatusTone(status: string): StatusTone {
  if (status === "Ready") return "success";
  if (status === "Ready,SchedulingDisabled") return "warning";
  return "destructive";
}

/* --------------------------------------------------------- Deployments -- */

export function getDeploymentReadiness(deployment: V1Deployment): {
  ready: number;
  total: number;
} {
  return {
    ready: deployment.status?.readyReplicas || 0,
    total: deployment.spec?.replicas ?? deployment.status?.replicas ?? 0,
  };
}

export const getReplicaTone = (ready: number, total: number): StatusTone => {
  if (total === 0) return "muted";
  return ready < total ? "warning" : "none";
};

/* -------------------------------------------------------------- Events -- */

/**
 * When an event was last seen: `lastTimestamp` for core/v1 events,
 * `series.lastObservedTime` / `eventTime` for events.k8s.io style events,
 * falling back to the creation time.
 */
export function getEventLastSeen(event: CoreV1Event): Date | null {
  return (
    toDate(event.lastTimestamp) ||
    toDate(event.series?.lastObservedTime) ||
    toDate(event.eventTime) ||
    toDate(event.firstTimestamp) ||
    toDate(event.metadata?.creationTimestamp)
  );
}

export const getEventTypeTone = (type?: string): StatusTone =>
  type === "Warning" ? "warning" : "none";

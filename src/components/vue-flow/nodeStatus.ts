import type { KubernetesObject } from "@kubernetes/client-node";
import type { StatusTone } from "@/components/ui/status";
import { getPodStatus, getPodStatusTone } from "@/components/tables/status";

/*
 * Presentational health of a graph object: pods by their status, scalable
 * workloads by ready vs desired replicas. null when there is nothing to say.
 */
export function graphNodeTone(object: KubernetesObject): StatusTone | null {
  const anyObject = object as any;

  if (object.kind === "Pod") {
    const tone = getPodStatusTone(getPodStatus(anyObject));
    return tone === "none" ? "muted" : tone;
  }

  if (
    ["Deployment", "ReplicaSet", "StatefulSet", "ReplicationController"].includes(
      object.kind || ""
    )
  ) {
    const desired = anyObject.spec?.replicas ?? anyObject.status?.replicas ?? 0;
    const ready = anyObject.status?.readyReplicas ?? 0;
    if (desired === 0) return "muted";
    return ready >= desired ? "success" : "warning";
  }

  if (object.kind === "DaemonSet") {
    const desired = anyObject.status?.desiredNumberScheduled ?? 0;
    const ready = anyObject.status?.numberReady ?? 0;
    return ready >= desired ? "success" : "warning";
  }

  return null;
}

/** Pod dot tone for the pods group node. */
export function podTone(pod: KubernetesObject): StatusTone {
  const tone = getPodStatusTone(getPodStatus(pod as any));
  return tone === "none" ? "muted" : tone;
}

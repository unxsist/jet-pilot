/*
 * Presentation helpers for the resource graph cards: health -> status
 * tones, one-line summaries per kind and the pod strip. Pure (tested).
 */
import type { StatusTone } from "@/components/ui/status";
import { getPodRestarts, getPodStatus } from "@/components/tables/status";
import {
  GraphObject,
  Health,
  NodeCategory,
  TopoNode,
  podHealth,
  replicaCounts,
  routeHosts,
} from "@/lib/clusterGraph";

export const HEALTH_TONE: Record<Health, StatusTone> = {
  ok: "success",
  warning: "warning",
  error: "destructive",
  neutral: "muted",
};

export const HEALTH_LABEL: Record<Health, string> = {
  ok: "Healthy",
  warning: "Degraded",
  error: "Failing",
  neutral: "No health",
};

/** Icon tile of a card, by category (tokens only, adapts to the theme). */
export const CATEGORY_TILE: Record<NodeCategory, string> = {
  traffic: "bg-info/10 text-info",
  service: "bg-info/10 text-info",
  workload: "bg-primary/10 text-link",
  replicaset: "bg-primary/10 text-link",
  job: "bg-primary/10 text-link",
  pod: "bg-primary/10 text-link",
  config: "bg-muted text-muted-foreground",
  storage: "bg-muted text-muted-foreground",
  identity: "bg-muted text-muted-foreground",
  policy: "bg-muted text-muted-foreground",
};

const plural = (count: number, word: string) =>
  `${count} ${word}${count === 1 ? "" : "s"}`;

const servicePorts = (object: GraphObject) =>
  (object.spec?.ports || [])
    .slice(0, 2)
    .map((port: any) =>
      port.targetPort && port.targetPort !== port.port
        ? `${port.port}→${port.targetPort}`
        : `${port.port}`
    )
    .join(", ") +
  ((object.spec?.ports || []).length > 2
    ? ` +${object.spec.ports.length - 2}`
    : "");

const SERVICE_TYPE: Record<string, string> = {
  ClusterIP: "ClusterIP",
  NodePort: "NodePort",
  LoadBalancer: "LoadBalancer",
  ExternalName: "ExternalName",
};

/** A short, kind-specific summary line for a card. */
export function nodeSubtitle(node: TopoNode): string {
  if (node.missing) return `${node.kind} · not found`;
  const object = node.object;
  if (!object) return `${node.kind} · not loaded`;
  const status = object.status || {};
  const spec = object.spec || {};

  switch (node.kind) {
    case "Deployment":
    case "StatefulSet":
    case "ReplicaSet":
    case "ReplicationController":
    case "DaemonSet": {
      const counts = replicaCounts(object)!;
      if (node.category === "replicaset") {
        const revision =
          object.metadata.annotations?.["deployment.kubernetes.io/revision"];
        return `${revision ? `rev ${revision} · ` : ""}${counts.ready}/${counts.desired} ready`;
      }
      return `${node.kind} · ${counts.ready}/${counts.desired} ready`;
    }
    case "CronJob":
      return spec.suspend
        ? `CronJob · suspended`
        : `CronJob · ${spec.schedule || ""}`;
    case "Job": {
      if (status.succeeded && !status.active) return "Job · complete";
      if (status.active) return `Job · ${status.active} running`;
      if (status.failed) return `Job · ${plural(status.failed, "failure")}`;
      return "Job";
    }
    case "Pod": {
      const restarts = getPodRestarts(object as any);
      return `${getPodStatus(object as any)}${restarts > 0 ? ` · ${plural(restarts, "restart")}` : ""}`;
    }
    case "Service": {
      const type = SERVICE_TYPE[spec.type] || spec.type || "Service";
      if (spec.type === "ExternalName") return `ExternalName · ${spec.externalName}`;
      const headless = spec.clusterIP === "None" ? "Headless" : type;
      const ports = servicePorts(object);
      return ports ? `${headless} · ${ports}` : headless;
    }
    case "Ingress":
    case "HTTPRoute":
    case "VirtualService": {
      const hosts = routeHosts(object);
      if (hosts.length === 0) return node.kind;
      return `${hosts[0]}${hosts.length > 1 ? ` +${hosts.length - 1}` : ""}`;
    }
    case "Gateway": {
      const listeners = spec.listeners || [];
      return `Gateway · ${plural(listeners.length, "listener")}`;
    }
    case "ConfigMap": {
      const keys =
        Object.keys(object.data || {}).length +
        Object.keys(object.binaryData || {}).length;
      return `ConfigMap · ${plural(keys, "key")}`;
    }
    case "Secret": {
      const type = String(object.type || "Opaque").replace(
        /^kubernetes\.io\//,
        ""
      );
      return `Secret · ${type}`;
    }
    case "PersistentVolumeClaim": {
      const size =
        status.capacity?.storage || spec.resources?.requests?.storage || "";
      return [size, status.phase, spec.storageClassName]
        .filter(Boolean)
        .join(" · ");
    }
    case "PersistentVolume":
      return [spec.capacity?.storage, status.phase].filter(Boolean).join(" · ");
    case "StorageClass":
      return `StorageClass · ${object.provisioner || ""}`;
    case "HorizontalPodAutoscaler":
      return `HPA · ${spec.minReplicas ?? 1}–${spec.maxReplicas} · now ${status.currentReplicas ?? "?"}`;
    case "PodDisruptionBudget": {
      const rule =
        spec.minAvailable !== undefined
          ? `min ${spec.minAvailable}`
          : `max unavailable ${spec.maxUnavailable}`;
      return `PDB · ${rule} · ${status.disruptionsAllowed ?? 0} allowed`;
    }
    case "NetworkPolicy":
      return `NetworkPolicy · ${(spec.policyTypes || ["Ingress"]).join(", ")}`;
    case "ServiceAccount":
      return "ServiceAccount";
    default:
      return node.kind;
  }
}

/** Short kind label for the card's top line. */
export function kindLabel(kind: string): string {
  return (
    {
      HorizontalPodAutoscaler: "HPA",
      PodDisruptionBudget: "PDB",
      PersistentVolumeClaim: "PVC",
      PersistentVolume: "PV",
    } as Record<string, string>
  )[kind] || kind;
}

export interface StripSegment {
  /** Pod (or Job) name. */
  name: string;
  status: string;
  tone: StatusTone;
}

/** Pod dots of a workload (or the recent runs of a CronJob), by name. */
export function healthStrip(node: TopoNode): StripSegment[] {
  if (node.kind === "CronJob") {
    return (node.jobs || [])
      .slice(0, 12)
      .reverse()
      .map((job) => {
        const failed = (job.status?.conditions || []).some(
          (c: any) => c.type === "Failed" && c.status === "True"
        );
        const active = (job.status?.active || 0) > 0;
        return {
          name: job.metadata.name || "",
          status: failed ? "Failed" : active ? "Running" : "Complete",
          tone: failed ? "destructive" : active ? "info" : "success",
        };
      });
  }
  return [...(node.pods || [])]
    .sort((a, b) =>
      String(a.metadata.name).localeCompare(String(b.metadata.name))
    )
    .map((pod) => {
      const status = getPodStatus(pod as any);
      const health =
        pod.status?.phase === "Succeeded" ? "neutral" : podHealth(pod).health;
      return { name: pod.metadata.name || "", status, tone: HEALTH_TONE[health] };
    });
}

/** Counts per tone for the compact (many pods) strip. */
export function stripCounts(segments: StripSegment[]) {
  const counts: Partial<Record<StatusTone, number>> = {};
  for (const segment of segments) {
    counts[segment.tone] = (counts[segment.tone] || 0) + 1;
  }
  return counts;
}

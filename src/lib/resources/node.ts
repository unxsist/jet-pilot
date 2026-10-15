/*
 * A node in words (pure, unit tested): health with only the problems
 * spelled out, roles, where it runs (zone, instance type) and how much of
 * it the pods on it have requested.
 */
import { parseCpu, parseMemory } from "@/components/tables/metrics";

export interface NodeProblem {
  type: string;
  label: string;
  message?: string;
  since?: string;
}

const CONDITION_WORDS: Record<string, string> = {
  MemoryPressure: "Memory pressure",
  DiskPressure: "Disk pressure",
  PIDPressure: "Too many processes",
  NetworkUnavailable: "Network unavailable",
};

const words = (type: string) =>
  CONDITION_WORDS[type] ?? type.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, (c) => c.toUpperCase());

/**
 * Ready ("True" / "False" / "Unknown") and the conditions that are wrong:
 * pressure, network, and the ones node-problem-detector adds (all of them
 * mean trouble when true).
 */
export function nodeHealth(node: any): { ready: string; readyMessage?: string; readySince?: string; problems: NodeProblem[] } {
  const conditions: any[] = node?.status?.conditions ?? [];
  const ready = conditions.find((c) => c.type === "Ready");
  const problems = conditions
    .filter((c) => c.type !== "Ready" && c.status === "True")
    .map((c) => ({ type: c.type, label: words(c.type), message: c.message, since: c.lastTransitionTime }));
  return {
    ready: ready?.status ?? "Unknown",
    readyMessage: ready?.message,
    readySince: ready?.lastTransitionTime,
    problems,
  };
}

/** Roles from `node-role.kubernetes.io/<role>` (and the old `kubernetes.io/role`). */
export function nodeRoles(labels: Record<string, string> | undefined): string[] {
  const roles = new Set<string>();
  for (const [key, value] of Object.entries(labels ?? {})) {
    if (key.startsWith("node-role.kubernetes.io/")) roles.add(key.slice("node-role.kubernetes.io/".length) || value);
    if (key === "kubernetes.io/role" && value) roles.add(value);
  }
  return [...roles].filter(Boolean).sort();
}

export interface NodePlacement {
  zone?: string;
  region?: string;
  instanceType?: string;
  /** "Spot" / "On demand". */
  capacityType?: string;
  /** Node pool / group it belongs to. */
  pool?: string;
}

const first = (labels: Record<string, string>, keys: string[]) => keys.map((k) => labels[k]).find(Boolean);

/** Zone, region, instance type, capacity type and pool from well-known labels. */
export function nodePlacement(labels: Record<string, string> | undefined): NodePlacement {
  const l = labels ?? {};
  const capacity = first(l, ["karpenter.sh/capacity-type", "eks.amazonaws.com/capacityType", "cloud.google.com/gke-provisioning", "kubernetes.azure.com/scalesetpriority"]);
  return {
    zone: first(l, ["topology.kubernetes.io/zone", "failure-domain.beta.kubernetes.io/zone"]),
    region: first(l, ["topology.kubernetes.io/region", "failure-domain.beta.kubernetes.io/region"]),
    instanceType: first(l, ["node.kubernetes.io/instance-type", "beta.kubernetes.io/instance-type"]),
    capacityType: capacity
      ? /spot/i.test(capacity)
        ? "Spot"
        : /on.?demand|standard|regular/i.test(capacity)
          ? "On demand"
          : capacity
      : undefined,
    pool: first(l, ["karpenter.sh/nodepool", "eks.amazonaws.com/nodegroup", "cloud.google.com/gke-nodepool", "kubernetes.azure.com/agentpool", "doks.digitalocean.com/node-pool"]),
  };
}

/* ------------------------------------------------------- allocation -- */

export interface Allocation {
  capacity: number;
  allocatable: number;
  requested: number;
  limits: number;
}

/** A pod still holds its node's resources (not finished). */
export const isActivePod = (pod: any) => pod?.status?.phase !== "Succeeded" && pod?.status?.phase !== "Failed";

/*
 * What a pod requests, like the scheduler counts it: the app containers
 * (and sidecars) together, or the largest init container if that is more,
 * plus the pod overhead.
 */
function podAmount(pod: any, kind: "requests" | "limits", resource: "cpu" | "memory"): number {
  const parse = resource === "cpu" ? parseCpu : parseMemory;
  const of = (c: any) => parse(c?.resources?.[kind]?.[resource] ?? (kind === "requests" ? c?.resources?.limits?.[resource] : undefined));
  const inits: any[] = pod?.spec?.initContainers ?? [];
  const sidecars = inits.filter((c) => c.restartPolicy === "Always");
  const app = [...(pod?.spec?.containers ?? []), ...sidecars].reduce((sum, c) => sum + of(c), 0);
  const init = Math.max(0, ...inits.filter((c) => c.restartPolicy !== "Always").map(of));
  return Math.max(app, init) + parse(pod?.spec?.overhead?.[resource]);
}

/** CPU (millicores), memory (bytes) and pods: capacity, allocatable and what the pods on it requested. */
export function nodeAllocation(node: any, pods: any[]): { cpu: Allocation; memory: Allocation; pods: Allocation } {
  const name = node?.metadata?.name;
  const onNode = pods.filter((pod) => pod?.spec?.nodeName === name && isActivePod(pod));
  const sum = (kind: "requests" | "limits", resource: "cpu" | "memory") =>
    onNode.reduce((total, pod) => total + podAmount(pod, kind, resource), 0);
  const status = node?.status ?? {};
  return {
    cpu: {
      capacity: parseCpu(status.capacity?.cpu),
      allocatable: parseCpu(status.allocatable?.cpu ?? status.capacity?.cpu),
      requested: sum("requests", "cpu"),
      limits: sum("limits", "cpu"),
    },
    memory: {
      capacity: parseMemory(status.capacity?.memory),
      allocatable: parseMemory(status.allocatable?.memory ?? status.capacity?.memory),
      requested: sum("requests", "memory"),
      limits: sum("limits", "memory"),
    },
    pods: {
      capacity: Number(status.capacity?.pods ?? 0),
      allocatable: Number(status.allocatable?.pods ?? status.capacity?.pods ?? 0),
      requested: onNode.length,
      limits: 0,
    },
  };
}

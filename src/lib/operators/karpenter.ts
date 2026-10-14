/*
 * Karpenter: node pool limits vs usage, disruption settings in words, and
 * node claims (instance type, spot / on-demand, zone, node). Pure, unit
 * tested.
 */
import { parseCpu, parseMemory, formatMemory } from "@/components/tables/metrics";
import {
  conditionOf,
  goDurationInWords,
  humanize,
  isFalse,
  isTrue,
  parseSimpleCron,
  type OperatorState,
} from "./format";

/* ---------------------------------------------------------- node pools -- */

export function nodePoolState(pool: any): OperatorState {
  const ready = conditionOf(pool, "Ready");
  if (isTrue(ready)) return { label: "Ready", tone: "success" };
  if (isFalse(ready)) {
    return { label: "Not ready", tone: "destructive", reason: ready!.reason, message: ready!.message };
  }
  return { label: "Pending", tone: "muted" };
}

export interface Usage {
  resource: "cpu" | "memory";
  label: string;
  used: number;
  limit?: number;
  /** "48 of 1000 cores", "192Gi of 1000Gi". */
  text: string;
  /** "48 / 1000". */
  short: string;
  percent?: number;
}

const cores = (millis: number) => {
  const value = millis / 1000;
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
};

/** CPU and memory in use against the pool's limits. */
export function nodePoolUsage(pool: any): Usage[] {
  const resources = pool?.status?.resources ?? {};
  const limits = pool?.spec?.limits ?? {};
  const usage: Usage[] = [];

  const cpuUsed = parseCpu(resources.cpu);
  const cpuLimit = limits.cpu !== undefined ? parseCpu(limits.cpu) : undefined;
  const memoryUsed = parseMemory(resources.memory);
  const memoryLimit = limits.memory !== undefined ? parseMemory(limits.memory) : undefined;

  const percent = (used: number, limit?: number) =>
    limit ? Math.min(100, Math.round((used / limit) * 100)) : undefined;

  usage.push({
    resource: "cpu",
    label: "CPU",
    used: cpuUsed,
    limit: cpuLimit,
    text:
      cpuLimit !== undefined
        ? `${cores(cpuUsed)} of ${cores(cpuLimit)} cores`
        : `${cores(cpuUsed)} cores`,
    short: cpuLimit !== undefined ? `${cores(cpuUsed)} / ${cores(cpuLimit)}` : cores(cpuUsed),
    percent: percent(cpuUsed, cpuLimit),
  });
  usage.push({
    resource: "memory",
    label: "Memory",
    used: memoryUsed,
    limit: memoryLimit,
    text:
      memoryLimit !== undefined
        ? `${formatMemory(memoryUsed)} of ${formatMemory(memoryLimit)}`
        : formatMemory(memoryUsed),
    short:
      memoryLimit !== undefined
        ? `${formatMemory(memoryUsed)} / ${formatMemory(memoryLimit)}`
        : formatMemory(memoryUsed),
    percent: percent(memoryUsed, memoryLimit),
  });
  return usage;
}

/* At its limits a pool gets no more nodes: amber from 85%, red at the limit. */
export const limitFillClass = (percent: number) =>
  percent >= 100 ? "bg-destructive" : percent >= 85 ? "bg-warning" : "bg-primary/70";

/** Nodes of the pool (status.resources.nodes), when reported. */
export const nodePoolNodes = (pool: any): number | undefined => {
  const nodes = pool?.status?.resources?.nodes;
  return nodes === undefined ? undefined : Number(nodes) || 0;
};

/* "Mon–Fri from 09:00", "daily from 22:00", or the expression. */
function scheduleInWords(cron: string): string {
  const parsed = parseSimpleCron(cron);
  if (!parsed) return `on schedule ${cron}`;
  return parsed.days ? `${parsed.days} from ${parsed.time}` : `daily from ${parsed.time}`;
}

function budgetInWords(budget: any): string {
  const nodes = String(budget?.nodes ?? "10%");
  const reasons: string[] = budget?.reasons ?? [];
  const what =
    nodes === "0"
      ? "No disruptions"
      : nodes.endsWith("%")
        ? `At most ${nodes} of nodes at a time`
        : `At most ${nodes} node${nodes === "1" ? "" : "s"} at a time`;
  const forReasons = reasons.length
    ? ` (${reasons.map((r) => humanize(r).toLowerCase()).join(", ")})`
    : "";
  if (!budget?.schedule) return `${what}${forReasons}`;
  const duration = goDurationInWords(budget.duration);
  return `${what}${forReasons}, ${scheduleInWords(budget.schedule)}${duration ? ` for ${duration}` : ""}`;
}

export interface Disruption {
  /** "Consolidates empty or underutilized nodes after 1 minute". */
  policy: string;
  /** "Replaces nodes after 30 days". */
  expiry?: string;
  budgets: string[];
}

export function disruptionInWords(pool: any): Disruption {
  const disruption = pool?.spec?.disruption ?? {};
  const after = disruption.consolidateAfter;
  const policy =
    after === "Never"
      ? "Never consolidates nodes"
      : `${disruption.consolidationPolicy === "WhenEmpty" ? "Consolidates empty nodes" : "Consolidates empty or underutilized nodes"}${
          after ? ` after ${goDurationInWords(after) ?? after}` : ""
        }`;
  // v1: spec.template.spec.expireAfter; v1beta1: spec.disruption.expireAfter.
  const expireAfter = pool?.spec?.template?.spec?.expireAfter ?? disruption.expireAfter;
  const expiry =
    expireAfter === undefined
      ? undefined
      : expireAfter === "Never"
        ? "Never replaces nodes for age"
        : `Replaces nodes after ${goDurationInWords(expireAfter) ?? expireAfter}`;
  const budgets = (disruption.budgets ?? []).map(budgetInWords);
  return { policy, expiry, budgets };
}

const REQUIREMENT_LABELS: Record<string, string> = {
  "karpenter.sh/capacity-type": "Capacity",
  "kubernetes.io/arch": "Architecture",
  "kubernetes.io/os": "OS",
  "node.kubernetes.io/instance-type": "Instance type",
  "topology.kubernetes.io/zone": "Zone",
  "karpenter.k8s.aws/instance-category": "Instance category",
  "karpenter.k8s.aws/instance-family": "Instance family",
  "karpenter.k8s.aws/instance-generation": "Generation",
  "karpenter.k8s.aws/instance-size": "Instance size",
  "karpenter.k8s.aws/instance-cpu": "vCPUs",
  "karpenter.k8s.aws/instance-hypervisor": "Hypervisor",
};

/** The node pool's requirements: [{ label: "Capacity", value: "spot, on-demand" }]. */
export function requirementsInWords(pool: any): { label: string; value: string }[] {
  return (pool?.spec?.template?.spec?.requirements ?? []).map((requirement: any) => {
    const values: string[] = (requirement?.values ?? []).map(String);
    const list = values.join(", ");
    let value: string;
    switch (requirement?.operator) {
      case "NotIn":
        value = `not ${list}`;
        break;
      case "Exists":
        value = "any";
        break;
      case "DoesNotExist":
        value = "none";
        break;
      case "Gt":
        value = `more than ${list}`;
        break;
      case "Lt":
        value = `less than ${list}`;
        break;
      default:
        value = list;
    }
    return { label: REQUIREMENT_LABELS[requirement?.key] ?? requirement?.key ?? "", value };
  });
}

/* --------------------------------------------------------- node claims -- */

const label = (object: any, key: string): string | undefined => object?.metadata?.labels?.[key];

export const instanceType = (claim: any) =>
  label(claim, "node.kubernetes.io/instance-type") ?? claim?.status?.instanceType;
export const zoneOf = (claim: any) => label(claim, "topology.kubernetes.io/zone");
export const nodePoolOf = (claim: any) => label(claim, "karpenter.sh/nodepool");

/** "Spot", "On-demand", "Reserved". */
export function capacityType(claim: any): string | undefined {
  const value = label(claim, "karpenter.sh/capacity-type");
  if (!value) return undefined;
  return value === "on-demand" ? "On-demand" : value.charAt(0).toUpperCase() + value.slice(1);
}

export function nodeClaimState(claim: any): OperatorState {
  if (claim?.metadata?.deletionTimestamp) return { label: "Terminating", tone: "warning", busy: true };
  const launched = conditionOf(claim, "Launched");
  const registered = conditionOf(claim, "Registered");
  const initialized = conditionOf(claim, "Initialized");
  const ready = conditionOf(claim, "Ready");
  const drifted = conditionOf(claim, "Drifted");

  if (isFalse(launched) && launched!.reason !== "Launching") {
    return { label: "Launch failed", tone: "destructive", reason: launched!.reason, message: launched!.message };
  }
  if (isTrue(ready)) {
    return isTrue(drifted)
      ? { label: "Drifted", tone: "info", reason: drifted!.reason, message: drifted!.message ?? "Karpenter will replace this node." }
      : { label: "Ready", tone: "success" };
  }
  if (!isTrue(launched)) return { label: "Launching", tone: "info", busy: true };
  if (!isTrue(registered)) return { label: "Registering", tone: "info", busy: true };
  if (!isTrue(initialized)) return { label: "Initializing", tone: "info", busy: true };
  return { label: "Not ready", tone: "warning", reason: ready?.reason, message: ready?.message };
}

/** "4 vCPU · 16Gi". */
export function claimCapacity(claim: any): string {
  const capacity = claim?.status?.capacity ?? {};
  const parts: string[] = [];
  if (capacity.cpu) parts.push(`${cores(parseCpu(capacity.cpu))} vCPU`);
  if (capacity.memory) parts.push(formatMemory(parseMemory(capacity.memory)));
  return parts.join(" · ");
}

/* ------------------------------------------------------ EC2 node class -- */

/** "AL2023 (latest)", "Bottlerocket", "ami-0abc…". */
export function amiInWords(nodeClass: any): string {
  const terms: any[] = nodeClass?.spec?.amiSelectorTerms ?? [];
  const alias = terms.find((t) => t?.alias)?.alias as string | undefined;
  if (alias) {
    const [family, version] = alias.split("@");
    const name = family.toLowerCase() === "bottlerocket" ? "Bottlerocket" : family.toUpperCase();
    return version ? `${name} (${version})` : name;
  }
  if (nodeClass?.spec?.amiFamily) return String(nodeClass.spec.amiFamily);
  const ids = terms.map((t) => t?.id).filter(Boolean);
  if (ids.length) return ids.join(", ");
  return terms.length ? "By selector" : "";
}

export const nodeClassRole = (nodeClass: any): string =>
  nodeClass?.spec?.role ?? nodeClass?.spec?.instanceProfile ?? "";

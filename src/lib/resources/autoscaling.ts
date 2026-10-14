/*
 * HorizontalPodAutoscalers in words (pure, unit tested): each metric as
 * current vs target ("CPU 72% of 80% target"), and the scaling conditions
 * as sentences.
 */
import { parseCpu, parseMemory } from "@/components/tables/metrics";
import { formatBytes, formatCores } from "@/lib/metrics/units";
import { sentence } from "./format";

export interface HpaMetric {
  label: string;
  /** In the target's unit: percent, millicores, bytes or a plain number. */
  current?: number;
  target: number;
  currentText: string;
  targetText: string;
  /** "average per pod", "total", ... */
  scope: string;
}

const RESOURCE_LABELS: Record<string, string> = { cpu: "CPU", memory: "Memory" };

/* Custom metric names in words: "http_requests_per_second" → "HTTP requests per second". */
const ACRONYMS = new Set(["http", "https", "grpc", "cpu", "gpu", "rps", "qps", "io", "api", "sqs"]);
const metricWords = (name: string) =>
  sentence(
    name
      .split(/[_\-.]+/)
      .map((word) => (ACRONYMS.has(word.toLowerCase()) ? word.toUpperCase() : word))
      .join(" ")
  );

/* A quantity in its natural unit: cores for CPU, bytes for memory, a number otherwise. */
function quantity(resource: string, value: unknown): { value: number; text: string } {
  if (resource === "cpu") {
    const m = parseCpu(value);
    return { value: m, text: formatCores(m) };
  }
  if (resource === "memory") {
    const b = parseMemory(value);
    return { value: b, text: formatBytes(b) };
  }
  // Custom metrics: Kubernetes quantities (`500m` = 0.5).
  const n = parseCpu(value) / 1000;
  const text = Number.isInteger(n) ? String(n) : n.toFixed(n < 10 ? 2 : 1).replace(/\.?0+$/, "");
  return { value: n, text };
}

/* The current value of a spec metric, matched by type and name. */
function currentOf(spec: any, current: any[]): any {
  return current.find((c) => {
    if (c.type !== spec.type) return false;
    const name = (m: any) =>
      m.resource?.name ?? m.containerResource?.name ?? m.pods?.metric?.name ?? m.object?.metric?.name ?? m.external?.metric?.name;
    return name(c) === name(spec) && (spec.type !== "ContainerResource" || c.containerResource?.container === spec.containerResource?.container);
  });
}

/** The autoscaler's metrics, current against target. */
export function hpaMetrics(hpa: any): HpaMetric[] {
  const specs: any[] = hpa?.spec?.metrics ?? [];
  const currents: any[] = hpa?.status?.currentMetrics ?? [];
  // autoscaling/v1: one CPU target.
  if (!specs.length && hpa?.spec?.targetCPUUtilizationPercentage !== undefined) {
    const current = hpa.status?.currentCPUUtilizationPercentage;
    return [
      {
        label: "CPU",
        current,
        target: hpa.spec.targetCPUUtilizationPercentage,
        currentText: current !== undefined ? `${current}%` : "–",
        targetText: `${hpa.spec.targetCPUUtilizationPercentage}%`,
        scope: "average across pods, as a share of their requests",
      },
    ];
  }
  return specs.map((spec) => {
    const current = currentOf(spec, currents);
    const source = spec.resource ?? spec.containerResource ?? spec.pods ?? spec.object ?? spec.external ?? {};
    const currentSource = current?.resource ?? current?.containerResource ?? current?.pods ?? current?.object ?? current?.external;
    const resourceName: string = spec.resource?.name ?? spec.containerResource?.name ?? "";
    const label =
      spec.type === "Resource" || spec.type === "ContainerResource"
        ? `${RESOURCE_LABELS[resourceName] ?? resourceName}${spec.containerResource ? ` (${spec.containerResource.container})` : ""}`
        : metricWords(String(source.metric?.name ?? spec.type));
    const target = source.target ?? {};
    if (target.type === "Utilization" || target.averageUtilization !== undefined) {
      const value = currentSource?.current?.averageUtilization;
      return {
        label,
        current: value,
        target: target.averageUtilization,
        currentText: value !== undefined ? `${value}%` : "–",
        targetText: `${target.averageUtilization}%`,
        scope: "average across pods, as a share of their requests",
      };
    }
    const averaged = target.type === "AverageValue" || target.averageValue !== undefined;
    const goal = quantity(resourceName, averaged ? target.averageValue : target.value);
    const raw = averaged ? currentSource?.current?.averageValue : currentSource?.current?.value;
    const now = raw !== undefined ? quantity(resourceName, raw) : undefined;
    return {
      label,
      current: now?.value,
      target: goal.value,
      currentText: now?.text ?? "–",
      targetText: goal.text,
      scope: spec.type === "Object" ? `of ${spec.object?.describedObject?.kind ?? "object"} ${spec.object?.describedObject?.name ?? ""}`.trim() : averaged ? "average across pods" : "total",
    };
  });
}

export interface ScalingCondition {
  type: string;
  ok: boolean;
  text: string;
  message?: string;
}

/** AbleToScale, ScalingActive and ScalingLimited as sentences. */
export function hpaConditionWords(hpa: any): ScalingCondition[] {
  const spec = hpa?.spec ?? {};
  return (hpa?.status?.conditions ?? []).map((c: any) => {
    const yes = c.status === "True";
    switch (c.type) {
      case "AbleToScale":
        return { type: c.type, ok: yes, text: yes ? "Can change the replicas" : "Can't change the replicas", message: c.message && sentence(c.message) };
      case "ScalingActive":
        return {
          type: c.type,
          ok: yes,
          text: yes ? "Reads its metrics" : c.reason === "ScalingDisabled" ? "Scaling is turned off" : "Can't read its metrics",
          message: c.message && sentence(c.message),
        };
      case "ScalingLimited":
        return {
          type: c.type,
          ok: !yes || c.reason === "TooFewReplicas",
          text: !yes
            ? "Within its range"
            : c.reason === "TooManyReplicas"
              ? `Held at its maximum of ${spec.maxReplicas}`
              : c.reason === "TooFewReplicas"
                ? `Held at its minimum of ${spec.minReplicas ?? 1}`
                : "Limited",
          message: c.message && sentence(c.message),
        };
      default:
        return { type: c.type, ok: yes, text: c.type, message: c.message };
    }
  });
}

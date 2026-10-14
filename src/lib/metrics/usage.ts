/*
 * The usage charts of an object (Pod, workload, Node, Namespace): which pods
 * or node it covers, the Prometheus queries for a time window, and the
 * charts built from their results, or from metrics-server's recent samples
 * when there is no Prometheus.
 */
import type { ChartMarker, ChartReference, ChartSeries, SeriesTone, Values } from "@/components/charts/types";
import { parseCpu, parseMemory, podResources } from "@/components/tables/metrics";
import type { KubeTarget } from "@/lib/kubeApi";
import {
  cpuQuery,
  memoryQuery,
  networkQuery,
  nodeCpuQuery,
  nodeMemoryQuery,
  podPattern,
  resourcesQuery,
  restartsQuery,
  terminationReasonsQuery,
  type Flavour,
  type NodeScope,
  type PodScope,
} from "./promql";
import { queryRange, sourceKey, type PromSource } from "./prometheus";
import { alignValues, bucketSamples, sumValues, type MatrixSeries, type Sample } from "./series";
import { rateWindow, windowTimes, type Window } from "./time";
import type { Unit } from "./units";

/** Kinds with a Usage section. */
export const USAGE_KINDS = ["Pod", "Deployment", "StatefulSet", "DaemonSet", "ReplicaSet", "Job", "Node", "Namespace"];

export const hasUsage = (kind: string | undefined) => !!kind && USAGE_KINDS.includes(kind);

/** The part of an object the charts look at. */
export interface Subject {
  kind: string;
  apiVersion?: string;
  metadata?: { name?: string; namespace?: string; context?: string; kubeConfig?: string };
  spec?: any;
  status?: any;
}

export interface UsageChart {
  id: "cpu" | "memory" | "network";
  title: string;
  unit: Unit;
  series: ChartSeries[];
  /** One line per pod (workloads, namespaces). */
  pods?: ChartSeries[];
  references: ChartReference[];
  markers: ChartMarker[];
}

export interface UsageData {
  /** Slot times, ms. */
  times: number[];
  charts: UsageChart[];
}

const isWorkload = (kind: string) => !["Pod", "Node", "Namespace"].includes(kind);

/** The pods (or node) an object covers. */
export function scopeOf(subject: Subject): PodScope | NodeScope {
  const name = subject.metadata?.name ?? "";
  if (subject.kind === "Node") {
    const addresses = (subject.status?.addresses ?? [])
      .filter((a: { type?: string }) => a.type === "InternalIP" || a.type === "ExternalIP" || a.type === "Hostname")
      .map((a: { address: string }) => a.address)
      .filter((a: string) => a && a !== name);
    return { type: "node", node: name, addresses };
  }
  if (subject.kind === "Namespace") return { type: "pods", namespace: name };
  return { type: "pods", namespace: subject.metadata?.namespace, pods: podPattern(subject.kind, name) ?? undefined };
}

/** Pods a workload runs now (the spec references are per pod × this). */
function replicaCount(subject: Subject): number {
  const { spec, status } = subject;
  switch (subject.kind) {
    case "DaemonSet":
      return status?.desiredNumberScheduled ?? status?.currentNumberScheduled ?? 0;
    case "Job":
      return status?.active ?? 0;
    default:
      return status?.replicas ?? spec?.replicas ?? 0;
  }
}

interface SpecReferences {
  cpu: ChartReference[];
  memory: ChartReference[];
}

/**
 * Requests / limits from the spec (a pod's containers, a workload's pod
 * template × its pods), a node's allocatable. Used without kube-state-metrics.
 */
export function specReferences(subject: Subject): SpecReferences {
  const refs: SpecReferences = { cpu: [], memory: [] };
  if (subject.kind === "Node") {
    const allocatable = subject.status?.allocatable ?? {};
    const cpu = parseCpu(allocatable.cpu);
    const memory = parseMemory(allocatable.memory);
    if (cpu) refs.cpu.push({ id: "allocatable", label: "Allocatable", values: cpu });
    if (memory) refs.memory.push({ id: "allocatable", label: "Allocatable", values: memory });
    return refs;
  }
  if (subject.kind === "Namespace") return refs;
  const podSpec = subject.kind === "Pod" ? subject.spec : subject.spec?.template?.spec;
  if (!podSpec) return refs;
  const times = subject.kind === "Pod" ? 1 : replicaCount(subject);
  if (!times) return refs;
  const { cpu, memory } = podResources({ spec: podSpec });
  const add = (list: ChartReference[], bounds: { request: number; limit: number }) => {
    if (bounds.request > 0) list.push({ id: "request", label: "Request", values: bounds.request * times });
    if (bounds.limit > 0) list.push({ id: "limit", label: "Limit", values: bounds.limit * times });
  };
  add(refs.cpu, cpu);
  add(refs.memory, memory);
  return refs;
}

const REASON_LABELS: Record<string, string> = {
  OOMKilled: "Out of memory",
  Error: "Exited with an error",
  Completed: "Exited",
};

/** A pod's last container stop from its status (when Prometheus can't say). */
export function statusRestartMarkers(subject: Subject, times: number[]): ChartMarker[] {
  if (subject.kind !== "Pod" || times.length < 2) return [];
  const step = times[1]! - times[0]!;
  const markers: ChartMarker[] = [];
  for (const status of subject.status?.containerStatuses ?? []) {
    // Stopped now (waiting to restart), or the run before this one.
    const terminated = status?.state?.terminated ?? status?.lastState?.terminated;
    if (!terminated || terminated.reason === "Completed") continue;
    const at = terminated.finishedAt ? Date.parse(terminated.finishedAt) : NaN;
    if (!Number.isFinite(at) || at < times[0]! || at > times[times.length - 1]! + step) continue;
    const reason = terminated.reason ? REASON_LABELS[terminated.reason] ?? terminated.reason : null;
    markers.push({
      index: Math.min(times.length - 1, Math.round((at - times[0]!) / step)),
      label: terminated.reason === "OOMKilled" ? REASON_LABELS.OOMKilled! : status?.state?.terminated ? "Stopped" : "Restarted",
      detail: [status.name, terminated.reason === "OOMKilled" ? null : reason].filter(Boolean).join(" · "),
    });
  }
  return markers;
}

/* Remembered per source: clusters that only have the legacy cAdvisor labels. */
const flavours = new Map<string, Flavour>();

interface Fetched {
  cpu: MatrixSeries[];
  memory: MatrixSeries[];
  flavour: Flavour;
}

/**
 * Usage of an object over a window from Prometheus. CPU and memory must
 * answer (their error is thrown); requests / limits, network and restarts
 * are extras that may be missing.
 */
export async function fetchUsage(
  target: KubeTarget,
  source: PromSource,
  subject: Subject,
  window: Window
): Promise<UsageData> {
  const times = windowTimes(window);
  const count = times.length;
  const rate = rateWindow(window.step);
  const scope = scopeOf(subject);
  const run = (query: string) => queryRange(target, source, query, window);
  const optional = (query: string) => run(query).catch(() => [] as MatrixSeries[]);
  const align = (series: MatrixSeries | undefined, scale = 1) =>
    series ? alignValues(series.values, window.start, window.step, count, scale) : (new Array(count).fill(null) as Values);
  const spec = specReferences(subject);

  if (scope.type === "node") {
    const [cpu, memory, resources] = await Promise.all([
      run(nodeCpuQuery(scope, rate)),
      run(nodeMemoryQuery(scope)),
      optional(resourcesQuery(scope)),
    ]);
    const requested = (resource: string) => {
      const series = resources.find((s) => s.metric.kind === "request" && s.metric.resource === resource);
      return series ? [{ id: "request" as const, label: "Requested", values: align(series, resource === "cpu" ? 1000 : 1) }] : [];
    };
    return {
      times,
      charts: [
        {
          id: "cpu",
          title: "CPU",
          unit: "cpu",
          series: [{ id: "cpu", label: "CPU", values: align(cpu[0], 1000), tone: "primary", fill: true }],
          references: [...spec.cpu, ...requested("cpu")],
          markers: [],
        },
        {
          id: "memory",
          title: "Memory",
          unit: "bytes",
          series: [{ id: "memory", label: "Memory", values: align(memory[0]), tone: "info", fill: true }],
          references: [...spec.memory, ...requested("memory")],
          markers: [],
        },
      ],
    };
  }

  const key = `${target.kubeConfig ?? ""}|${target.context}|${sourceKey(source)}`;
  const byPod = subject.kind !== "Pod";
  const fetchCore = async (flavour: Flavour): Promise<Fetched> => {
    const [cpu, memory] = await Promise.all([run(cpuQuery(scope, rate, byPod, flavour)), run(memoryQuery(scope, byPod, flavour))]);
    return { cpu, memory, flavour };
  };
  const known = flavours.get(key) ?? "modern";
  const isPod = subject.kind === "Pod";
  const [first, resources, restarts] = await Promise.all([
    fetchCore(known),
    optional(resourcesQuery(scope)),
    isPod || isWorkload(subject.kind) ? optional(restartsQuery(scope, rate)) : Promise.resolve([]),
  ]);
  let core = first;
  if (!core.cpu.length && !core.memory.length && known === "modern") {
    // Nothing with `pod` / `container`: maybe an old cAdvisor.
    const legacy = await fetchCore("legacy").catch(() => null);
    if (legacy && (legacy.cpu.length || legacy.memory.length)) {
      flavours.set(key, "legacy");
      core = legacy;
    }
  }
  const network = isPod ? await optional(networkQuery(scope, rate, core.flavour)) : [];
  const reasons = restarts.length ? await optional(terminationReasonsQuery(scope)) : [];

  const podLabel = core.flavour === "legacy" ? "pod_name" : "pod";
  const perPod = (list: MatrixSeries[], scale: number, tone: SeriesTone): ChartSeries[] =>
    list
      .map((s) => ({ id: s.metric[podLabel] ?? "", label: s.metric[podLabel] ?? "", values: align(s, scale), tone }))
      .sort((a, b) => a.label.localeCompare(b.label));
  const cpuPods = perPod(core.cpu, 1000, "primary");
  const memoryPods = perPod(core.memory, 1, "info");

  const references = (resource: "cpu" | "memory"): ChartReference[] => {
    const fromKsm = (["request", "limit"] as const).flatMap((kind) => {
      const series = resources.find((s) => s.metric.kind === kind && s.metric.resource === resource);
      return series ? [{ id: kind, label: kind === "request" ? "Request" : "Limit", values: align(series, resource === "cpu" ? 1000 : 1) }] : [];
    });
    return fromKsm.length ? fromKsm : spec[resource];
  };

  const markers: ChartMarker[] = restarts.length ? restartMarkers(restarts, reasons, align, isPod) : statusRestartMarkers(subject, times);

  const charts: UsageChart[] = [
    {
      id: "cpu",
      title: "CPU",
      unit: "cpu",
      series: [{ id: "cpu", label: "CPU", values: sumValues(cpuPods.map((p) => p.values), count), tone: "primary", fill: true }],
      ...(byPod ? { pods: cpuPods } : {}),
      references: references("cpu"),
      markers,
    },
    {
      id: "memory",
      title: "Memory",
      unit: "bytes",
      series: [{ id: "memory", label: "Memory", values: sumValues(memoryPods.map((p) => p.values), count), tone: "info", fill: true }],
      ...(byPod ? { pods: memoryPods } : {}),
      references: references("memory"),
      markers,
    },
  ];
  if (isPod && network.length) {
    const direction = (d: string) => align(network.find((s) => s.metric.direction === d));
    charts.push({
      id: "network",
      title: "Network",
      unit: "rate",
      series: [
        { id: "in", label: "In", values: direction("in"), tone: "primary", fill: true },
        { id: "out", label: "Out", values: direction("out"), tone: "neutral" },
      ],
      references: [],
      markers: [],
    });
  }
  return { times, charts };
}

/** Restart markers from `increase(restarts)` per pod, with the reason the container stopped. */
function restartMarkers(
  restarts: MatrixSeries[],
  reasons: MatrixSeries[],
  align: (series: MatrixSeries | undefined) => Values,
  isPod: boolean
): ChartMarker[] {
  const byIndex = new Map<number, { count: number; pods: Set<string>; reasons: Set<string> }>();
  for (const series of restarts) {
    const pod = series.metric.pod ?? "";
    const values = align(series);
    const podReasons = reasons.filter((r) => r.metric.pod === pod).map((r) => ({ reason: r.metric.reason ?? "", values: align(r) }));
    values.forEach((value, index) => {
      if (value === null || value < 0.5) return;
      const entry = byIndex.get(index) ?? { count: 0, pods: new Set(), reasons: new Set() };
      entry.count += Math.max(1, Math.round(value));
      entry.pods.add(pod);
      // The reason that became current at the restart (or right after it).
      const reason = podReasons.find((r) => r.values[index] === 1 || r.values[index + 1] === 1);
      if (reason?.reason) entry.reasons.add(reason.reason);
      byIndex.set(index, entry);
    });
  }
  return [...byIndex.entries()]
    .sort(([a], [b]) => a - b)
    .map(([index, entry]) => {
      const oom = entry.reasons.has("OOMKilled");
      const restarts = entry.count === 1 ? "Restarted" : `${entry.count} restarts`;
      const parts = [
        ...(oom && entry.count > 1 ? [restarts] : []),
        ...(isPod ? [] : [[...entry.pods].join(", ")]),
        ...[...entry.reasons].filter((r) => r !== "OOMKilled").map((r) => REASON_LABELS[r] ?? r),
      ];
      const label = oom ? REASON_LABELS.OOMKilled! : restarts;
      return { index, label, ...(parts.length ? { detail: parts.join(" · ") } : {}) };
    });
}

/* --------------------------------------------- metrics-server fallback -- */

/** metrics-server's samples of the pods (or node) of an object. */
export function fallbackUsage(subject: Subject, series: Sample[][]): UsageData {
  const timeline = bucketSamples(series);
  const spec = specReferences(subject);
  const markers = statusRestartMarkers(subject, timeline.times);
  return {
    times: timeline.times,
    charts: [
      {
        id: "cpu",
        title: "CPU",
        unit: "cpu",
        series: [{ id: "cpu", label: "CPU", values: timeline.cpu, tone: "primary", fill: true }],
        references: spec.cpu,
        markers,
      },
      {
        id: "memory",
        title: "Memory",
        unit: "bytes",
        series: [{ id: "memory", label: "Memory", values: timeline.memory, tone: "info", fill: true }],
        references: spec.memory,
        markers,
      },
    ],
  };
}

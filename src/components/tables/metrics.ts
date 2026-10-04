/*
 * Pod metrics for table cells: quantity parsing, requests / limits and the
 * usage history shown by the CPU / Memory sparkline columns.
 *
 * Data contract (provided by the data layer, optional):
 *
 *   row.metricsHistory: { ts: number; cpu: number; memory: number }[]
 *     ts      epoch milliseconds, oldest first
 *     cpu     pod CPU usage in millicores (sum of containers)
 *     memory  pod memory usage in bytes (sum of containers)
 *
 * The array must be replaced (not mutated) when a sample is appended, and
 * the row object with it, so the table re-renders the row. Without it the
 * columns fall back to `row.metrics` (PodMetric[], the latest sample only).
 */

export interface MetricsSample {
  ts: number;
  cpu: number;
  memory: number;
}

export interface ResourceBounds {
  request: number;
  limit: number;
}

const CPU_SUFFIX: Record<string, number> = {
  n: 1e-6,
  u: 1e-3,
  m: 1,
  "": 1000,
  k: 1e6,
};

/** CPU quantity (`250m`, `1`, `1500000n`) in millicores; NaN-safe (0). */
export function parseCpu(quantity: unknown): number {
  if (typeof quantity === "number") return quantity * 1000;
  if (typeof quantity !== "string") return 0;
  const match = /^([0-9.]+(?:e[0-9]+)?)([numk]?)$/.exec(quantity.trim());
  if (!match) return 0;
  const value = Number(match[1]) * CPU_SUFFIX[match[2]];
  return Number.isFinite(value) ? value : 0;
}

const MEMORY_SUFFIX: Record<string, number> = {
  "": 1,
  k: 1e3,
  M: 1e6,
  G: 1e9,
  T: 1e12,
  P: 1e15,
  E: 1e18,
  Ki: 1024,
  Mi: 1024 ** 2,
  Gi: 1024 ** 3,
  Ti: 1024 ** 4,
  Pi: 1024 ** 5,
  Ei: 1024 ** 6,
  m: 1e-3,
};

/** Memory quantity (`128Mi`, `1G`, `2048`, `1e9`) in bytes; NaN-safe (0). */
export function parseMemory(quantity: unknown): number {
  if (typeof quantity === "number") return quantity;
  if (typeof quantity !== "string") return 0;
  const match = /^([0-9.]+(?:e[0-9]+)?)([KMGTPE]i|[kMGTPEm]?)$/.exec(
    quantity.trim()
  );
  if (!match) return 0;
  const value = Number(match[1]) * MEMORY_SUFFIX[match[2]];
  return Number.isFinite(value) ? value : 0;
}

interface PodLike {
  spec?: {
    containers?: {
      resources?: {
        requests?: Record<string, string>;
        limits?: Record<string, string>;
      };
    }[];
  };
  metrics?: {
    timestamp?: string | Date;
    containers?: { usage?: { cpu?: string; memory?: string } }[];
  }[];
  metricsHistory?: Partial<MetricsSample>[];
}

/**
 * Pod requests / limits (sum of the app containers). A limit is only
 * reported when every container sets one (otherwise the pod is unbounded).
 */
export function podResources(pod: PodLike): {
  cpu: ResourceBounds;
  memory: ResourceBounds;
} {
  const containers = pod.spec?.containers || [];
  const sum = (
    kind: "requests" | "limits",
    resource: "cpu" | "memory",
    parse: (q: unknown) => number
  ) => {
    let total = 0;
    for (const container of containers) {
      const value = container.resources?.[kind]?.[resource];
      if (value === undefined) {
        if (kind === "limits") return 0;
        continue;
      }
      total += parse(value);
    }
    return total;
  };

  return {
    cpu: {
      request: sum("requests", "cpu", parseCpu),
      limit: sum("limits", "cpu", parseCpu),
    },
    memory: {
      request: sum("requests", "memory", parseMemory),
      limit: sum("limits", "memory", parseMemory),
    },
  };
}

const cache = new WeakMap<object, MetricsSample[]>();

/**
 * Usage samples of a pod row, oldest first: `metricsHistory` when the data
 * layer provides it, otherwise the PodMetric(s) in `metrics`. Cached per row
 * object (rows are replaced when their metrics change).
 */
export function podUsageSamples(pod: PodLike): MetricsSample[] {
  const cached = cache.get(pod);
  if (cached) return cached;

  let samples: MetricsSample[];
  if (Array.isArray(pod.metricsHistory) && pod.metricsHistory.length > 0) {
    samples = pod.metricsHistory
      .filter((s) => s && typeof s === "object")
      .map((s) => ({
        ts: Number(s.ts) || 0,
        cpu: Number(s.cpu) || 0,
        memory: Number(s.memory) || 0,
      }));
  } else {
    samples = (pod.metrics || []).map((metric) => {
      let cpu = 0;
      let memory = 0;
      for (const container of metric?.containers || []) {
        cpu += parseCpu(container.usage?.cpu);
        memory += parseMemory(container.usage?.memory);
      }
      const ts = metric?.timestamp ? new Date(metric.timestamp).getTime() : 0;
      return { ts: Number.isFinite(ts) ? ts : 0, cpu, memory };
    });
  }

  cache.set(pod, samples);
  return samples;
}

/** Latest sample value, or undefined without metrics (sorts last). */
export function latestUsage(
  pod: PodLike,
  resource: "cpu" | "memory"
): number | undefined {
  const samples = podUsageSamples(pod);
  return samples.length ? samples[samples.length - 1][resource] : undefined;
}

/** Millicores, like kubectl top (`250m`, `1200m`); cores from 100 cores. */
export function formatCpu(millicores: number): string {
  if (!Number.isFinite(millicores)) return "-";
  if (millicores >= 100000) return `${Math.round(millicores / 1000)}`;
  if (millicores > 0 && millicores < 1) return "<1m";
  return `${Math.round(millicores)}m`;
}

const BINARY_UNITS = ["", "Ki", "Mi", "Gi", "Ti", "Pi"];

export function formatMemory(bytes: number): string {
  if (!Number.isFinite(bytes)) return "-";
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < BINARY_UNITS.length - 1) {
    value /= 1024;
    unit++;
  }
  const digits = value >= 100 || unit === 0 ? 0 : value >= 10 ? 0 : 1;
  return `${value.toFixed(digits)}${BINARY_UNITS[unit]}`;
}

export interface UsageSummary {
  latest: number;
  min: number;
  max: number;
  avg: number;
}

export function summarize(values: number[]): UsageSummary | null {
  if (values.length === 0) return null;
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  for (const value of values) {
    if (value < min) min = value;
    if (value > max) max = value;
    sum += value;
  }
  return {
    latest: values[values.length - 1],
    min,
    max,
    avg: sum / values.length,
  };
}

/** Usage relative to the limit (or the request without limit), 0..∞. */
export function usageRatio(
  value: number,
  bounds: ResourceBounds
): number | null {
  const reference = bounds.limit || bounds.request;
  return reference > 0 ? value / reference : null;
}

export type UsageTone = "normal" | "warning" | "destructive";

/** Near / over the limit: warning from 75%, destructive from 90%. */
export function usageTone(value: number, bounds: ResourceBounds): UsageTone {
  if (!bounds.limit) return "normal";
  const ratio = value / bounds.limit;
  return ratio >= 0.9 ? "destructive" : ratio >= 0.75 ? "warning" : "normal";
}

/**
 * SVG path (`M x y L ...`) of the samples in a width × height box; y grows
 * downwards, `max` is the top of the scale. A single sample draws a flat line.
 */
export function sparklinePath(
  values: number[],
  width: number,
  height: number,
  max: number,
  inset = 1
): string {
  if (values.length === 0 || max <= 0) return "";
  const usable = height - inset * 2;
  const y = (v: number) =>
    (inset + usable - (Math.min(Math.max(v, 0), max) / max) * usable).toFixed(
      2
    );
  if (values.length === 1) {
    return `M0 ${y(values[0])} L${width} ${y(values[0])}`;
  }
  const step = width / (values.length - 1);
  return values
    .map((v, i) => `${i === 0 ? "M" : "L"}${(i * step).toFixed(2)} ${y(v)}`)
    .join(" ");
}

/*
 * Series of the usage charts: values on a shared timeline (one slot per
 * query step, `null` where there is no sample), built from Prometheus range
 * results or from metrics-server samples.
 */
import type { Values } from "@/components/charts/types";

export type { Values };

/** A Prometheus range-query series: labels and [seconds, "value"] pairs. */
export interface MatrixSeries {
  metric: Record<string, string>;
  values: [number, string][];
}

/** A sample value; Prometheus sends NaN / ±Inf as strings. */
const parseSample = (raw: string): number | null => {
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
};

/**
 * One series on the timeline `start + i × step` (seconds, `count` slots).
 * Samples off the grid (another step, a clock skew) land on the nearest slot.
 */
export function alignValues(
  values: [number, string][],
  start: number,
  step: number,
  count: number,
  scale = 1
): Values {
  const aligned: Values = new Array(count).fill(null);
  for (const [ts, raw] of values) {
    const index = Math.round((ts - start) / step);
    if (index < 0 || index >= count) continue;
    const value = parseSample(raw);
    if (value !== null) aligned[index] = value * scale;
  }
  return aligned;
}

/**
 * The sum of several series per slot: `null` only where none has a value
 * (a pod that didn't exist yet adds nothing, it isn't missing data).
 */
export function sumValues(list: Values[], count: number): Values {
  const sum: Values = new Array(count).fill(null);
  for (const values of list) {
    for (let i = 0; i < count; i++) {
      const value = values[i];
      if (value === null || value === undefined) continue;
      sum[i] = (sum[i] ?? 0) + value;
    }
  }
  return sum;
}

export interface Summary {
  latest: number | null;
  min: number;
  max: number;
  avg: number;
}

export function summarizeValues(values: Values): Summary | null {
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  let n = 0;
  let latest: number | null = null;
  for (const value of values) {
    if (value === null) continue;
    if (value < min) min = value;
    if (value > max) max = value;
    sum += value;
    n++;
    latest = value;
  }
  return n ? { latest, min, max, avg: sum / n } : null;
}

/** The newest value at or before slot `index` (a hover between gaps). */
export function valueAt(values: Values, index: number): number | null {
  for (let i = Math.min(index, values.length - 1); i >= 0 && i > index - 3; i--) {
    if (values[i] !== null && values[i] !== undefined) return values[i]!;
  }
  return null;
}

/** metrics-server: `[ms, cpuMillicores, memoryBytes]` per scrape. */
export type Sample = { ts: number; cpu: number; memory: number };

export interface SampleTimeline {
  times: number[];
  cpu: Values;
  memory: Values;
}

/**
 * metrics-server samples of several pods (each scraped at its own moment)
 * on one timeline of `stepMs` slots ending at the newest sample: the sum of
 * the pods per slot, each pod's newest sample in it.
 */
export function bucketSamples(series: Sample[][], stepMs = 15_000): SampleTimeline {
  let newest = -Infinity;
  let oldest = Infinity;
  for (const samples of series) {
    for (const s of samples) {
      if (s.ts > newest) newest = s.ts;
      if (s.ts < oldest) oldest = s.ts;
    }
  }
  if (!Number.isFinite(newest)) return { times: [], cpu: [], memory: [] };
  const end = newest;
  const count = Math.round((newest - oldest) / stepMs) + 1;
  const times = Array.from({ length: count }, (_, i) => end - (count - 1 - i) * stepMs);
  const cpuParts: Values[] = [];
  const memoryParts: Values[] = [];
  for (const samples of series) {
    const cpu: Values = new Array(count).fill(null);
    const memory: Values = new Array(count).fill(null);
    for (const s of samples) {
      const index = count - 1 - Math.round((end - s.ts) / stepMs);
      if (index < 0 || index >= count) continue;
      cpu[index] = s.cpu;
      memory[index] = s.memory;
    }
    // Scrape jitter can put two samples in one slot and none in the next:
    // carry the value over a one-slot gap so the sum doesn't dip.
    for (let i = 1; i < count - 1; i++) {
      if (cpu[i] === null && cpu[i - 1] !== null && cpu[i + 1] !== null) {
        cpu[i] = cpu[i - 1];
        memory[i] = memory[i - 1];
      }
    }
    cpuParts.push(cpu);
    memoryParts.push(memory);
  }
  return { times, cpu: sumValues(cpuParts, count), memory: sumValues(memoryParts, count) };
}

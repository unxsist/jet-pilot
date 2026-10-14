/*
 * Units of the usage charts: CPU in millicores, memory in bytes (binary),
 * network in bytes per second (decimal, like every network tool), and the
 * "nice" axis scales that go with them.
 */

export type Unit = "cpu" | "bytes" | "rate";

const trim = (value: number, digits: number) =>
  value.toFixed(digits).replace(/\.0+$|(\.\d*[1-9])0+$/, "$1");

/** `250m`, `1 core`, `2.5 cores`; tooltips and headers. */
export function formatCores(millicores: number): string {
  if (!Number.isFinite(millicores)) return "–";
  if (millicores <= 0) return "0";
  if (millicores < 1) return "<1m";
  if (millicores < 1000) return `${Math.round(millicores)}m`;
  const cores = millicores / 1000;
  const text = trim(cores, cores >= 10 ? 1 : 2);
  return `${text} ${text === "1" ? "core" : "cores"}`;
}

/** Axis ticks: Kubernetes quantities (`500m`, `1`, `1.5`). */
export function formatCoresTick(millicores: number): string {
  if (millicores <= 0) return "0";
  if (millicores < 1000) return `${trim(millicores, 0)}m`;
  return trim(millicores / 1000, 2);
}

const BINARY = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"];

/** `512 MiB`, `1.2 GiB`. */
export function formatBytes(bytes: number, digits?: number): string {
  if (!Number.isFinite(bytes)) return "–";
  if (bytes <= 0) return "0 B";
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < BINARY.length - 1) {
    value /= 1024;
    unit++;
  }
  const places = digits ?? (unit === 0 || value >= 100 ? 0 : value >= 10 ? 1 : 2);
  return `${trim(value, places)} ${BINARY[unit]}`;
}

const DECIMAL = ["B/s", "kB/s", "MB/s", "GB/s", "TB/s"];

/** `1.2 MB/s`, `340 kB/s`. */
export function formatRate(bytesPerSecond: number, digits?: number): string {
  if (!Number.isFinite(bytesPerSecond)) return "–";
  if (bytesPerSecond <= 0) return "0 B/s";
  let value = bytesPerSecond;
  let unit = 0;
  while (value >= 1000 && unit < DECIMAL.length - 1) {
    value /= 1000;
    unit++;
  }
  const places = digits ?? (unit === 0 || value >= 100 ? 0 : value >= 10 ? 1 : 2);
  return `${trim(value, places)} ${DECIMAL[unit]}`;
}

export function formatValue(unit: Unit, value: number): string {
  return unit === "cpu" ? formatCores(value) : unit === "bytes" ? formatBytes(value) : formatRate(value);
}

export function formatTick(unit: Unit, value: number): string {
  if (unit === "cpu") return formatCoresTick(value);
  return unit === "bytes" ? formatBytes(value, 1) : formatRate(value, 1);
}

/** `41%` of a reference (limit, allocatable); null without one. */
export function percentOf(value: number, reference: number | undefined): string | null {
  if (!reference || reference <= 0 || !Number.isFinite(value)) return null;
  const percent = (value / reference) * 100;
  return `${percent > 0 && percent < 1 ? "<1" : Math.round(percent)}%`;
}

export interface Scale {
  /** Top of the axis (a multiple of `step`). */
  max: number;
  step: number;
  /** 0, step, 2 × step, ... up to max. */
  ticks: number[];
}

const DECIMAL_STEPS = [1, 2, 2.5, 5];

function decimalStep(raw: number): number {
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  for (const multiple of DECIMAL_STEPS) {
    if (multiple * magnitude >= raw) return multiple * magnitude;
  }
  return 10 * magnitude;
}

/* Memory reads best in powers of two (256 MiB, 512 MiB, 1 GiB). */
function binaryStep(raw: number): number {
  return raw <= 1 ? 1 : 2 ** Math.ceil(Math.log2(raw));
}

/**
 * An axis from 0 to at least `max` with at most `maxTicks` steps: decimal
 * steps (1, 2, 2.5, 5 × 10ⁿ) or binary ones for bytes.
 */
export function niceScale(max: number, unit: Unit, maxTicks = 3): Scale {
  const top = Number.isFinite(max) && max > 0 ? max : unit === "cpu" ? 100 : unit === "bytes" ? 64 * 1024 ** 2 : 1000;
  const raw = top / maxTicks;
  const step = unit === "bytes" ? binaryStep(raw) : decimalStep(raw);
  const count = Math.max(1, Math.ceil(top / step - 1e-9));
  const ticks = Array.from({ length: count + 1 }, (_, i) => i * step);
  return { max: count * step, step, ticks };
}

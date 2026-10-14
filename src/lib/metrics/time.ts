/*
 * Time math of the usage charts: the ranges people pick, the query step
 * that fits the chart's width, the rate window that goes with it, and the
 * few time labels under a chart.
 */

export type RangeId = "1h" | "6h" | "24h" | "7d";

export const RANGES: { id: RangeId; label: string; seconds: number }[] = [
  { id: "1h", label: "1h", seconds: 3600 },
  { id: "6h", label: "6h", seconds: 6 * 3600 },
  { id: "24h", label: "24h", seconds: 86400 },
  { id: "7d", label: "7d", seconds: 7 * 86400 },
];

export const rangeSeconds = (id: RangeId) => RANGES.find((r) => r.id === id)!.seconds;

/** Query steps, in seconds: round numbers on the clock. */
const STEPS = [15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 10800, 21600, 43200, 86400];

/** About one point per 3 px, but never finer than a 15 s scrape. */
export function stepFor(rangeSecs: number, widthPx: number): number {
  const points = Math.min(240, Math.max(60, Math.floor(widthPx / 3)));
  const raw = rangeSecs / points;
  return STEPS.find((step) => step >= raw) ?? STEPS[STEPS.length - 1]!;
}

/**
 * The window of `rate()` / `increase()` at a step: at least two minutes (a
 * few scrapes, even at a 30 s or 60 s interval) and at least the step, so
 * consecutive points cover every sample once.
 */
export function rateWindow(step: number): string {
  return `${Math.max(120, step)}s`;
}

export interface Window {
  /** Seconds since the epoch. */
  start: number;
  end: number;
  step: number;
  /** Number of points: (end - start) / step + 1. */
  count: number;
}

/**
 * The query window ending now: whole steps back from `now` (rounded down to
 * 15 s, so refreshes line up), the newest point included.
 */
export function queryWindow(nowMs: number, rangeSecs: number, step: number): Window {
  const end = Math.floor(nowMs / 1000 / 15) * 15;
  const steps = Math.ceil(rangeSecs / step);
  return { start: end - steps * step, end, step, count: steps + 1 };
}

/** Timestamps (ms) of every point of a window. */
export function windowTimes(window: Window): number[] {
  return Array.from({ length: window.count }, (_, i) => (window.start + i * window.step) * 1000);
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const TICK_INTERVALS = [
  5 * MINUTE,
  10 * MINUTE,
  15 * MINUTE,
  30 * MINUTE,
  HOUR,
  2 * HOUR,
  3 * HOUR,
  6 * HOUR,
  12 * HOUR,
  DAY,
  2 * DAY,
];

/**
 * At most `max` time labels between `from` and `to` (ms), on round local
 * times (every 15 minutes, every 6 hours, every midnight, ...).
 */
export function timeTicks(from: number, to: number, max = 4): number[] {
  const span = to - from;
  if (!(span > 0)) return [];
  const interval = TICK_INTERVALS.find((i) => span / i <= max) ?? 7 * DAY;
  // Round in local time: offset the epoch by the zone's offset at `from`.
  const offset = new Date(from).getTimezoneOffset() * MINUTE;
  const ticks: number[] = [];
  let t = Math.ceil((from - offset) / interval) * interval + offset;
  for (; t <= to; t += interval) ticks.push(t);
  return ticks;
}

const pad = (n: number) => String(n).padStart(2, "0");
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export const clockTime = (ms: number) => {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

/** An axis label: `14:30`, or the day for labels at midnight (`Tue 14`). */
export function tickLabel(ms: number, spanMs: number): string {
  const d = new Date(ms);
  const midnight = d.getHours() === 0 && d.getMinutes() === 0;
  if (spanMs > 2 * DAY || (midnight && spanMs > 6 * HOUR)) return `${DAYS[d.getDay()]} ${d.getDate()}`;
  return clockTime(ms);
}

/** The time in a tooltip: `14:35`, with the day once the chart spans days. */
export function pointLabel(ms: number, spanMs: number): string {
  const d = new Date(ms);
  if (spanMs <= 12 * HOUR) return clockTime(ms);
  return `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}, ${clockTime(ms)}`;
}

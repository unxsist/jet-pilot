/**
 * Startup performance marks.
 *
 * Every mark is a `performance.mark("jet:<name>")` (visible in the webview
 * devtools Performance panel and readable from tests / the harness via
 * `performance.getEntriesByType("mark")`), recorded once per page load.
 * Times are relative to the webview's navigation start (`performance.now()`).
 *
 *   app:boot          main.ts starts executing (JS downloaded + parsed)
 *   app:mounted       Vue mounted the root component (skeleton visible)
 *   app:first-paint   first frame after mount was painted
 *   settings:loaded   settings.json read, real shell rendered
 *   nav:ready         navigation has API resources (cache or network)
 *   data:first        first resource list rows rendered (see markFirstData)
 *
 * When `data:first` is recorded (or after 15s) the timeline is logged once at
 * debug level.
 */
import { debug } from "@/lib/logger";

export type PerfMark =
  | "app:boot"
  | "app:mounted"
  | "app:first-paint"
  | "settings:loaded"
  | "nav:ready"
  | "data:first";

const PREFIX = "jet:";
const REPORT_TIMEOUT_MS = 15_000;

const recorded = new Map<PerfMark, number>();
let reported = false;
let reportTimer: ReturnType<typeof setTimeout> | null = null;

const now = () =>
  typeof performance !== "undefined" ? performance.now() : Date.now();

/** Records `name` once; later calls are ignored. Returns the time (ms). */
export function perfMark(name: PerfMark): number {
  const existing = recorded.get(name);
  if (existing !== undefined) {
    return existing;
  }

  const time = now();
  recorded.set(name, time);
  try {
    performance.mark(PREFIX + name);
  } catch {
    // performance.mark is unavailable (very old webviews / tests): ignore.
  }

  if (name === "app:boot" && reportTimer === null) {
    reportTimer = setTimeout(reportStartup, REPORT_TIMEOUT_MS);
  }
  if (name === "data:first") {
    reportStartup();
  }

  return time;
}

/** Marks `app:first-paint` on the frame after the current one is painted. */
export function markFirstPaint() {
  if (typeof requestAnimationFrame === "undefined") {
    perfMark("app:first-paint");
    return;
  }
  requestAnimationFrame(() =>
    setTimeout(() => perfMark("app:first-paint"), 0)
  );
}

/**
 * Data-layer hook: call when a list view rendered its first rows (the first
 * call per page load wins). Safe to call on every successful load.
 */
export function markFirstData() {
  if (!recorded.has("data:first")) {
    perfMark("data:first");
  }
}

/** The recorded marks, in ms since navigation start. */
export function perfMarks(): Partial<Record<PerfMark, number>> {
  return Object.fromEntries(recorded) as Partial<Record<PerfMark, number>>;
}

/** One-line summary of the startup timeline. */
export function formatStartup(marks = perfMarks()): string {
  const order: PerfMark[] = [
    "app:boot",
    "app:mounted",
    "app:first-paint",
    "settings:loaded",
    "nav:ready",
    "data:first",
  ];
  return order
    .filter((name) => marks[name] !== undefined)
    .map((name) => `${name}=${Math.round(marks[name]!)}ms`)
    .join(" ");
}

function reportStartup() {
  if (reported) {
    return;
  }
  reported = true;
  if (reportTimer !== null) {
    clearTimeout(reportTimer);
    reportTimer = null;
  }
  debug(`startup timeline: ${formatStartup()}`);
}

/**
 * Runs `callback` when the main thread is idle (at the latest after
 * `timeout` ms): for work that must not compete with the first frames.
 */
export function whenIdle(callback: () => void, timeout = 2000) {
  const ric = (globalThis as any).requestIdleCallback as
    | ((cb: () => void, opts?: { timeout: number }) => number)
    | undefined;
  if (ric) {
    ric(callback, { timeout });
  } else {
    setTimeout(callback, Math.min(timeout, 300));
  }
}

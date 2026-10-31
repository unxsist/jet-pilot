/*
 * Log volume over time, for the histogram above the structured log viewer
 * (pure, unit tested).
 *
 * The timeline mirrors the viewer's rows (time ordered) as parsed times and
 * running level counts. Updates are incremental: rows the timeline already
 * knows keep their parsed values, so following a stream only parses the new
 * lines, and dropping the oldest lines at the cap costs nothing. A bucket's
 * counts are differences of the running counts at its (binary searched)
 * edges, so drawing costs O(buckets · log lines) however long the buffer is.
 */
import { ERROR_LEVELS, WARN_LEVELS, logLevelOf, type LogRow } from "./logViewer";

/* What the bars tint: errors, warnings, and everything else. */
const OTHER = 0;
const WARN = 1;
const ERROR = 2;

const toneOf = (level: string): number =>
  ERROR_LEVELS.has(level) ? ERROR : WARN_LEVELS.has(level) ? WARN : OTHER;

export interface TimeBucket {
  /** ms since the epoch, `end` exclusive. */
  start: number;
  end: number;
  total: number;
  error: number;
  warn: number;
}

export interface Buckets {
  step: number;
  buckets: TimeBucket[];
  /** The largest bucket total (the bars' scale). */
  max: number;
}

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

/** Bucket widths: round numbers on the clock. */
export const BUCKET_STEPS = [
  1, 2, 5, 10, 20, 50, 100, 200, 500,
  SECOND, 2 * SECOND, 5 * SECOND, 10 * SECOND, 15 * SECOND, 30 * SECOND,
  MINUTE, 2 * MINUTE, 5 * MINUTE, 10 * MINUTE, 15 * MINUTE, 30 * MINUTE,
  HOUR, 2 * HOUR, 3 * HOUR, 6 * HOUR, 12 * HOUR, 24 * HOUR,
];

/** The finest round step that covers `span` ms in at most `maxBuckets` buckets. */
export function bucketStep(span: number, maxBuckets: number): number {
  const raw = span / Math.max(1, maxBuckets);
  return BUCKET_STEPS.find((step) => step >= raw) ?? Math.ceil(raw / (24 * HOUR)) * 24 * HOUR;
}

/*
 * Bucket edges are multiples of the step in local time, so hour buckets
 * start on the hour where the user is (half-hour time zones included).
 */
const alignDown = (time: number, step: number, offset: number) =>
  Math.floor((time + offset) / step) * step - offset;

export const localOffset = (time: number) => -new Date(time).getTimezoneOffset() * MINUTE;

export class LogTimeline {
  private rows: readonly LogRow[] = [];
  /* Parallel to `rows`: time (ms), level, and the errors / warnings before it. */
  private times: number[] = [];
  private levels: number[] = [];
  private errorsBefore: number[] = [];
  private warnsBefore: number[] = [];
  /** Whether any row has a parsed level (the bars are tinted by level). */
  hasLevels = false;

  get length(): number {
    return this.times.length;
  }

  /** Follows the viewer's (new) rows array. */
  update(rows: readonly LogRow[]): void {
    const previous = this.rows;
    if (rows === previous) return;
    this.rows = rows;

    // Rows dropped at the start (the cap) are where the old rows continue.
    const dropped = rows.length > 0 && previous.length > 0 ? previous.indexOf(rows[0]) : -1;
    let kept = 0;
    if (dropped >= 0) {
      // Late lines are merged in by time: only the rows after the first
      // difference need parsing again.
      const max = Math.min(previous.length - dropped, rows.length);
      while (kept < max && rows[kept] === previous[dropped + kept]) kept++;
      if (dropped > 0) {
        this.times.splice(0, dropped);
        this.levels.splice(0, dropped);
        this.errorsBefore.splice(0, dropped);
        this.warnsBefore.splice(0, dropped);
      }
    }
    this.times.length = kept;
    this.levels.length = kept;
    this.errorsBefore.length = kept;
    this.warnsBefore.length = kept;
    if (kept === 0) this.hasLevels = false;

    for (let i = kept; i < rows.length; i++) {
      const row = rows[i];
      const parsed = Date.parse(row.timestamp);
      // Unparseable timestamps take their neighbour's time: the rows stay
      // ordered, so the binary searches stay valid.
      const time = Number.isNaN(parsed) ? (i > 0 ? this.times[i - 1] : NaN) : parsed;
      const name = logLevelOf(row.data);
      if (name) this.hasLevels = true;
      this.times.push(time);
      this.levels.push(toneOf(name));
      this.errorsBefore.push(i > 0 ? this.errorsBefore[i - 1] + Number(this.levels[i - 1] === ERROR) : 0);
      this.warnsBefore.push(i > 0 ? this.warnsBefore[i - 1] + Number(this.levels[i - 1] === WARN) : 0);
    }
  }

  /** First and last time, or null without a time span to draw. */
  span(): { start: number; end: number } | null {
    const n = this.times.length;
    if (n < 2) return null;
    let first = 0;
    while (first < n && Number.isNaN(this.times[first])) first++;
    if (first >= n - 1) return null;
    const start = this.times[first];
    const end = this.times[n - 1];
    return end > start ? { start, end } : null;
  }

  /** Index of the first row at or after `time`. */
  lowerBound(time: number): number {
    let lo = 0;
    let hi = this.times.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      // NaN only leads the array (rows before the first parseable time).
      if (Number.isNaN(this.times[mid]) || this.times[mid] < time) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /** Row indexes [from, to) of the lines in the time range [start, end). */
  indexRange(start: number, end: number): [number, number] {
    return [this.lowerBound(start), this.lowerBound(end)];
  }

  private countBefore(counts: number[], level: number, index: number): number {
    const n = counts.length;
    if (n === 0) return 0;
    if (index < n) return counts[index];
    return counts[n - 1] + Number(this.levels[n - 1] === level);
  }

  /** Line counts of the rows [from, to). */
  counts(from: number, to: number): { total: number; error: number; warn: number } {
    return {
      total: to - from,
      error:
        this.countBefore(this.errorsBefore, ERROR, to) -
        this.countBefore(this.errorsBefore, ERROR, from),
      warn:
        this.countBefore(this.warnsBefore, WARN, to) -
        this.countBefore(this.warnsBefore, WARN, from),
    };
  }

  /**
   * Buckets over the whole span: the finest round step with at most
   * `maxBuckets` buckets, edges aligned to it (in local time).
   */
  buckets(maxBuckets: number, offset = localOffset(Date.now())): Buckets | null {
    const span = this.span();
    if (!span) return null;
    // Aligning the first edge can add a bucket: then take the next step.
    let step = bucketStep(span.end - span.start + 1, maxBuckets);
    let first = alignDown(span.start, step, offset);
    while (Math.floor((span.end - first) / step) + 1 > maxBuckets) {
      step = bucketStep(step + 1, 1);
      first = alignDown(span.start, step, offset);
    }
    const buckets: TimeBucket[] = [];
    let max = 0;
    let from = this.lowerBound(first);
    for (let start = first; start <= span.end; start += step) {
      const end = start + step;
      const to = this.lowerBound(end);
      const counts = this.counts(from, to);
      buckets.push({ start, end, ...counts });
      if (counts.total > max) max = counts.total;
      from = to;
    }
    return { step, buckets, max };
  }
}

/**
 * A brushed pixel range [x0, x1] snapped to whole buckets: the time range
 * [start, end) from the first to the last bucket it touches.
 */
export function snapRange(
  buckets: TimeBucket[],
  width: number,
  x0: number,
  x1: number
): [number, number] | null {
  if (buckets.length === 0 || width <= 0) return null;
  const index = (x: number) =>
    Math.min(buckets.length - 1, Math.max(0, Math.floor((x / width) * buckets.length)));
  const a = index(Math.min(x0, x1));
  const b = index(Math.max(x0, x1));
  return [buckets[a].start, buckets[b].end];
}

const pad = (n: number, width = 2) => String(n).padStart(width, "0");

/**
 * A time for the histogram's labels, as precise as its buckets: `14:03`,
 * `14:03:07`, or `14:03:07.250` for sub-second buckets. Ranges over several
 * days start with the date.
 */
export function formatBucketTime(time: number, step: number, withDate = false): string {
  const date = new Date(time);
  let text = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  if (step < MINUTE) text += `:${pad(date.getSeconds())}`;
  if (step < SECOND) text += `.${pad(date.getMilliseconds(), 3)}`;
  if (withDate) {
    const day = date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
    text = `${day} ${text}`;
  }
  return text;
}

/** "14:03:05–14:03:10", with the dates when the range crosses midnight. */
export function formatTimeRange(start: number, end: number, step: number): string {
  const days = new Date(start).toDateString() !== new Date(end - 1).toDateString();
  return `${formatBucketTime(start, step, days)}–${formatBucketTime(end, step, days)}`;
}

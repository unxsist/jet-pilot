/*
 * Pure helpers for the structured log viewer: source colours, short pod
 * names, search highlighting and timestamp ordering. Unit tested.
 */

export interface LogRow {
  id: string;
  seq: number;
  content: string;
  /* RFC3339, normalized by the backend to 9 fractional digits. */
  timestamp: string;
  data: unknown;
  pod?: string | null;
  container?: string | null;
}

/* ------------------------------------------------------------ colours -- */

/*
 * Categorical hues for pod prefixes, ordered so neighbours differ a lot.
 * Rendered as hsl(var(--pod-h) ...) with theme specific lightness, the
 * same recipe ContextAvatar uses.
 */
export const POD_HUES = [210, 150, 275, 35, 330, 185, 95, 15, 245, 55];

/**
 * Assigns each source (pod) a hue in order of first appearance, so the
 * first ten pods are guaranteed distinct colours; after that hues repeat.
 */
export class SourceColors {
  private assigned = new Map<string, number>();

  hue(source: string): number {
    let index = this.assigned.get(source);
    if (index === undefined) {
      index = this.assigned.size;
      this.assigned.set(source, index);
    }
    return POD_HUES[index % POD_HUES.length];
  }

  reset() {
    this.assigned.clear();
  }
}

/* --------------------------------------------------------- pod names -- */

/**
 * Shortest unambiguous display names for pods of one workload: the shared
 * dash separated prefix is dropped (`web-7d9f8b6c4-x2klq` ->
 * `7d9f8b6c4-x2klq`, or `x2klq` when all pods share the ReplicaSet hash).
 * A single pod keeps its full name.
 */
export function shortPodNames(names: string[]): Map<string, string> {
  const result = new Map<string, string>();
  const unique = [...new Set(names)];
  if (unique.length <= 1) {
    unique.forEach((name) => result.set(name, name));
    return result;
  }

  const split = unique.map((name) => name.split("-"));
  let common = 0;
  const shortest = Math.min(...split.map((parts) => parts.length));
  // Keep at least the last segment of every name.
  while (
    common < shortest - 1 &&
    split.every((parts) => parts[common] === split[0][common])
  ) {
    common++;
  }

  const short = split.map((parts) => parts.slice(common).join("-"));
  // StatefulSet ordinals alone (`0`, `1`) say too little: keep full names.
  const useFull = short.some((name) => !name || /^\d+$/.test(name));
  unique.forEach((name, i) => {
    result.set(name, useFull ? name : short[i]);
  });
  return result;
}

/* ------------------------------------------------------------ search -- */

export interface TextSegment {
  text: string;
  match: boolean;
}

/** Splits `text` into matching / non-matching segments (case-insensitive). */
export function highlightSegments(text: string, query: string): TextSegment[] {
  if (!query) return [{ text, match: false }];

  const haystack = text.toLowerCase();
  const needle = query.toLowerCase();
  const segments: TextSegment[] = [];
  let from = 0;
  let index = haystack.indexOf(needle, from);
  while (index !== -1) {
    if (index > from) segments.push({ text: text.slice(from, index), match: false });
    segments.push({ text: text.slice(index, index + needle.length), match: true });
    from = index + needle.length;
    index = haystack.indexOf(needle, from);
  }
  if (from < text.length) segments.push({ text: text.slice(from), match: false });
  return segments.length > 0 ? segments : [{ text, match: false }];
}

/** Indexes of the rows whose content or pod contains `query`. */
export function matchingRowIndexes(rows: LogRow[], query: string): number[] {
  if (!query) return [];
  const needle = query.toLowerCase();
  const matches: number[] = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (
      row.content.toLowerCase().includes(needle) ||
      (row.pod && row.pod.toLowerCase().includes(needle))
    ) {
      matches.push(i);
    }
  }
  return matches;
}

/**
 * Next (or previous) match relative to the current one, wrapping around.
 * `current` is an index into `matches` (-1: none yet).
 */
export function stepMatch(
  matchCount: number,
  current: number,
  direction: 1 | -1
): number {
  if (matchCount === 0) return -1;
  if (current < 0) return direction === 1 ? 0 : matchCount - 1;
  return (current + direction + matchCount) % matchCount;
}

/* ---------------------------------------------------------- ordering -- */

const compareRows = (a: LogRow, b: LogRow) =>
  a.timestamp < b.timestamp
    ? -1
    : a.timestamp > b.timestamp
      ? 1
      : a.seq - b.seq;

/**
 * Merges newly fetched rows into the (timestamp ordered) rows. Lines of
 * different pods arrive out of order, especially the initial tails. The
 * common case, everything newer than the last row, is a plain append.
 * Returns a new array; inputs are not modified.
 */
export function mergeByTimestamp(existing: LogRow[], incoming: LogRow[]): LogRow[] {
  if (incoming.length === 0) return existing;

  const sortedIncoming = isSorted(incoming)
    ? incoming
    : [...incoming].sort(compareRows);

  if (
    existing.length === 0 ||
    compareRows(existing[existing.length - 1], sortedIncoming[0]) <= 0
  ) {
    return existing.concat(sortedIncoming);
  }

  const merged: LogRow[] = new Array(existing.length + sortedIncoming.length);
  let i = 0;
  let j = 0;
  let k = 0;
  while (i < existing.length && j < sortedIncoming.length) {
    merged[k++] =
      compareRows(existing[i], sortedIncoming[j]) <= 0
        ? existing[i++]
        : sortedIncoming[j++];
  }
  while (i < existing.length) merged[k++] = existing[i++];
  while (j < sortedIncoming.length) merged[k++] = sortedIncoming[j++];
  return merged;
}

function isSorted(rows: LogRow[]): boolean {
  for (let i = 1; i < rows.length; i++) {
    if (compareRows(rows[i - 1], rows[i]) > 0) return false;
  }
  return true;
}

/**
 * Keeps at most `max` rows (the newest) and drops rows the backend has
 * evicted (`seq < oldestSeq`).
 */
export function capRows(rows: LogRow[], max: number, oldestSeq: number): LogRow[] {
  let result = rows;
  if (oldestSeq > 0 && rows.some((row) => row.seq < oldestSeq)) {
    result = rows.filter((row) => row.seq >= oldestSeq);
  }
  return result.length > max ? result.slice(result.length - max) : result;
}

/* -------------------------------------------------------- formatting -- */

/**
 * Time of day with milliseconds in local time (`14:03:07.123`) for the
 * timestamp column; the raw value is used when it isn't a timestamp.
 */
export function formatLogTime(timestamp: string): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return timestamp;
  const pad = (n: number, width = 2) => String(n).padStart(width, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(
    date.getSeconds()
  )}.${pad(date.getMilliseconds(), 3)}`;
}

/** Log level of a parsed (JSON) line, if it has one. */
export function logLevelOf(data: unknown): string {
  const record = data as Record<string, unknown> | null;
  const level = record?.level ?? record?.severity ?? record?.lvl;
  return typeof level === "string" ? level.toLowerCase() : "";
}

export function levelClass(level: string): string {
  if (["error", "err", "fatal", "critical", "panic"].includes(level)) {
    return "text-destructive";
  }
  if (["warn", "warning"].includes(level)) return "text-warning";
  if (["debug", "trace"].includes(level)) return "text-muted-foreground";
  return "text-foreground";
}

/** Facet values are JSON-serialized by the backend (`"web-1"`). */
export function facetDisplayValue(value: string): string {
  try {
    const parsed = JSON.parse(value);
    return typeof parsed === "string" ? parsed : value;
  } catch {
    return value;
  }
}

/** Default export file name: `<object>-<yyyymmdd-hhmm>.log`. */
export function exportFileName(object: string, now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(
    now.getDate()
  )}-${pad(now.getHours())}${pad(now.getMinutes())}`;
  const base = object.replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "") || "logs";
  return `${base}-${stamp}.log`;
}

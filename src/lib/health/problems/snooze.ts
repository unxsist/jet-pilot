/*
 * Snoozed and acknowledged problems (pure, unit tested), kept locally in
 * state.json by fingerprint. A snooze hides a problem for a while; an
 * acknowledgement hides it until it is resolved, so it shows again when it
 * comes back.
 */
import type { Problem } from "./model";

export interface Snooze {
  fingerprint: string;
  /** When it was snoozed (epoch ms). */
  at: number;
  /** Hidden until then (epoch ms); unset: until the problem is resolved. */
  until?: number;
}

export const SNOOZES = [
  { id: "hour", label: "For an hour", ms: 3600_000 },
  { id: "day", label: "For a day", ms: 24 * 3600_000 },
  { id: "week", label: "For a week", ms: 7 * 24 * 3600_000 },
] as const;

export const isActive = (snooze: Snooze, now: number) => snooze.until === undefined || snooze.until > now;

/** Open problems, and the snoozed ones with their snooze. */
export function partition(problems: Problem[], snoozes: Snooze[], now: number) {
  const active = new Map(snoozes.filter((s) => isActive(s, now)).map((s) => [s.fingerprint, s]));
  const open: Problem[] = [];
  const snoozed: { problem: Problem; snooze: Snooze }[] = [];
  for (const problem of problems) {
    const snooze = active.get(problem.fingerprint);
    if (snooze) snoozed.push({ problem, snooze });
    else open.push(problem);
  }
  return { open, snoozed };
}

/** Adds or replaces the snooze of a fingerprint; `ms` unset acknowledges it. */
export function snooze(snoozes: Snooze[], fingerprint: string, now: number, ms?: number): Snooze[] {
  return [...snoozes.filter((s) => s.fingerprint !== fingerprint), { fingerprint, at: now, ...(ms !== undefined ? { until: now + ms } : {}) }];
}

export const unsnooze = (snoozes: Snooze[], fingerprint: string): Snooze[] =>
  snoozes.filter((s) => s.fingerprint !== fingerprint);

/**
 * Drops expired snoozes, and acknowledgements of problems that are gone.
 * Only where the problem would be visible (`watched`: its cluster is loaded
 * and its namespace selected): a deactivated cluster keeps its snoozes.
 */
export function prune(snoozes: Snooze[], live: Set<string>, watched: (fingerprint: string) => boolean, now: number): Snooze[] {
  const kept = snoozes.filter((s) =>
    s.until !== undefined ? s.until > now : live.has(s.fingerprint) || !watched(s.fingerprint)
  );
  return kept.length === snoozes.length ? snoozes : kept;
}

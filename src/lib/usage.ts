/*
 * Anonymous usage counts. The update check on startup tells the update
 * server (updates.jet-pilot.app, jet-pilot-docs workers/updates) the version,
 * the platform, and whether it is this install's first check today, this ISO
 * week or this month. Counting those flags gives daily, weekly and monthly
 * active installs without any identifier: the server keeps only daily totals.
 * Turned off by `updates.countInstall`; then the check sends none of this.
 */

export interface CountedPeriods {
  /** UTC day of the last counted check, e.g. "2026-10-08". */
  day: string | null;
  /** ISO week, e.g. "2026-W41". */
  week: string | null;
  /** Month, e.g. "2026-10". */
  month: string | null;
}

export const noCountedPeriods = (): CountedPeriods => ({ day: null, week: null, month: null });

/** The UTC day, ISO week and month `date` falls in. */
export function periodsOf(date: Date): { day: string; week: string; month: string } {
  const day = date.toISOString().slice(0, 10);
  // ISO week: the week (Monday first) holding the year's first Thursday is week 1.
  const thursday = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  thursday.setUTCDate(thursday.getUTCDate() + 3 - ((thursday.getUTCDay() + 6) % 7));
  const yearStart = Date.UTC(thursday.getUTCFullYear(), 0, 1);
  const week = Math.floor((thursday.getTime() - yearStart) / 86_400_000 / 7) + 1;
  return {
    day,
    week: `${thursday.getUTCFullYear()}-W${String(week).padStart(2, "0")}`,
    month: day.slice(0, 7),
  };
}

/**
 * The headers for a counted update check, and the periods to remember once
 * the check succeeded. `X-JetPilot-Count` lists the periods this check is the
 * first of ("day,week,month", or "none").
 */
export function countHeaders(
  now: Date,
  counted: CountedPeriods,
  app: { version: string; os: string; arch: string }
): { headers: Record<string, string>; counted: CountedPeriods } {
  const current = periodsOf(now);
  const first = (["day", "week", "month"] as const).filter((p) => counted[p] !== current[p]);
  return {
    headers: {
      "X-JetPilot-Count": first.join(",") || "none",
      "X-JetPilot-Version": app.version,
      "X-JetPilot-OS": app.os,
      "X-JetPilot-Arch": app.arch,
    },
    counted: current,
  };
}

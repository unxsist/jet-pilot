/*
 * Dates and day counts in words, for expiry and end-of-support lines:
 * "Expires in 12 days", "Out of support since Jul 15, 2025". Pure.
 */
export const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

const DATE = new Intl.DateTimeFormat("en", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

/** "Jul 15, 2025". */
export const dayText = (at: number) => DATE.format(new Date(at));

/** "1 day", "12 days". */
export const daysWords = (days: number) => `${days} ${days === 1 ? "day" : "days"}`;

/** "in 12 days", "in 7 hours", "2 days ago" (rounded to whole days past a day). */
export function relativeDays(at: number, now: number): string {
  const ms = at - now;
  const abs = Math.abs(ms);
  if (abs < DAY_MS) {
    const hours = Math.max(1, Math.round(abs / HOUR_MS));
    const words = `${hours} ${hours === 1 ? "hour" : "hours"}`;
    return ms >= 0 ? `in ${words}` : `${words} ago`;
  }
  const words = daysWords(Math.round(abs / DAY_MS));
  return ms >= 0 ? `in ${words}` : `${words} ago`;
}

/** ISO date ("2026-11-26") → epoch ms at the start of that day (UTC); null for null. */
export const dateMs = (iso: string | null | undefined) => (iso ? Date.parse(`${iso}T00:00:00Z`) : null);

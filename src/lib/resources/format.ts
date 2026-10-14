/*
 * Small wording helpers shared by the side panels and the native describe
 * (pure): durations, relative times and plurals in plain English.
 */

/** Epoch ms of a timestamp (string, Date or number); null when missing / invalid. */
export const toMs = (value: unknown): number | null => {
  if (value === null || value === undefined || value === "") return null;
  const ms = value instanceof Date ? value.getTime() : typeof value === "number" ? value : Date.parse(String(value));
  return Number.isFinite(ms) ? ms : null;
};

/** "40s", "3m", "1h 20m", "2d 4h". */
export function durationWords(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 ? `${hours}h ${minutes % 60}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  return hours % 24 && days < 7 ? `${days}d ${hours % 24}h` : `${days}d`;
}

/** "just now", "3m ago", "2d ago"; "" without a time. */
export function ago(value: unknown, now = Date.now()): string {
  const at = toMs(value);
  if (at === null) return "";
  const ms = now - at;
  return ms < 45_000 ? "just now" : `${durationWords(ms)} ago`;
}

/** "in 1h 20m", "in a moment". */
export function fromNow(value: unknown, now = Date.now()): string {
  const at = toMs(value);
  if (at === null) return "";
  const ms = at - now;
  return ms < 45_000 ? "in a moment" : `in ${durationWords(ms)}`;
}

/** The time between two instants, or "" when one is missing. */
export function between(from: unknown, to: unknown): string {
  const a = toMs(from);
  const b = toMs(to);
  return a === null || b === null ? "" : durationWords(b - a);
}

/** "1 pod", "3 pods"; irregular plurals passed in. */
export const plural = (count: number, word: string, many = `${word}s`) =>
  `${count} ${count === 1 ? word : many}`;

/** "a, b and c". */
export const listWords = (items: string[]) =>
  items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;

/** First letter upper case, for messages that start lower case. */
export const sentence = (text: string) => {
  const trimmed = text.trim();
  return trimmed ? trimmed.charAt(0).toUpperCase() + trimmed.slice(1) : "";
};

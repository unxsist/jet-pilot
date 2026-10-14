/*
 * Shared helpers of the operator views (cert-manager, Gateway API,
 * Karpenter, KEDA, External Secrets, Prometheus Operator): conditions,
 * states and durations in words. Pure, unit tested.
 */
import type { StatusTone } from "@/components/ui/status/tones";

/** A state in words: the label of a status cell or a panel's headline. */
export interface OperatorState {
  label: string;
  tone: StatusTone;
  /** Machine reason (e.g. "SecretSyncedError"). */
  reason?: string;
  /** What the controller said, in its own words. */
  message?: string;
  /** In progress (a soft pulse on the dot). */
  busy?: boolean;
}

export interface Condition {
  type: string;
  status: string;
  reason?: string;
  message?: string;
  lastTransitionTime?: string;
  observedGeneration?: number;
}

export function conditionOf(object: any, type: string): Condition | undefined {
  const list = object?.status?.conditions;
  return Array.isArray(list) ? list.find((c: Condition) => c?.type === type) : undefined;
}

export const isTrue = (condition?: Condition) => condition?.status === "True";
export const isFalse = (condition?: Condition) => condition?.status === "False";

/** The Ready condition in words (issuers, node classes, ...). */
export function readyState(object: any): OperatorState {
  const ready = conditionOf(object, "Ready");
  if (isTrue(ready)) return { label: "Ready", tone: "success" };
  if (isFalse(ready)) {
    return { label: "Not ready", tone: "destructive", reason: ready!.reason, message: ready!.message };
  }
  return { label: "Pending", tone: "muted", message: ready?.message };
}

/** "apps/v1" → "apps", "v1" → "". */
export const groupOf = (apiVersion?: string) =>
  apiVersion?.includes("/") ? apiVersion.split("/")[0] : "";

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const unit = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** A span in words: "23 days", "5 hours", "12 minutes", "a few seconds". */
export function spanInWords(ms: number): string {
  const abs = Math.abs(ms);
  // Below two days, hours say more than "1 day".
  if (abs >= 365 * DAY) return unit(Math.floor(abs / (365 * DAY)), "year");
  if (abs >= 2 * DAY) return unit(Math.floor(abs / DAY), "day");
  if (abs >= HOUR) return unit(Math.floor(abs / HOUR), "hour");
  if (abs >= MINUTE) return unit(Math.floor(abs / MINUTE), "minute");
  return "a few seconds";
}

/** "in 23 days" / "2 days ago". */
export function relativeInWords(at: number, now: number): string {
  const delta = at - now;
  return delta >= 0 ? `in ${spanInWords(delta)}` : `${spanInWords(delta)} ago`;
}

export const toTime = (value: unknown): number | null => {
  if (!value) return null;
  const time = new Date(String(value)).getTime();
  return Number.isNaN(time) ? null : time;
};

/** Go durations ("1h30m", "720h", "30s", "0") in milliseconds. */
export function parseGoDuration(value: unknown): number | null {
  if (value === undefined || value === null || value === "") return null;
  const text = String(value).trim();
  if (text === "0") return 0;
  const units: Record<string, number> = { ns: 1e-6, us: 1e-3, "µs": 1e-3, ms: 1, s: SECOND, m: MINUTE, h: HOUR };
  let total = 0;
  let rest = text;
  while (rest) {
    const match = rest.match(/^(\d+(?:\.\d+)?)(ns|us|µs|ms|s|m|h)/);
    if (!match) return null;
    total += Number(match[1]) * units[match[2]];
    rest = rest.slice(match[0].length);
  }
  return total;
}

/** "every hour", "every 15 minutes", "every 2 days". */
export function everyInWords(ms: number): string {
  if (ms % DAY === 0 && ms >= DAY) return ms === DAY ? "every day" : `every ${ms / DAY} days`;
  if (ms % HOUR === 0 && ms >= HOUR) return ms === HOUR ? "every hour" : `every ${ms / HOUR} hours`;
  if (ms % MINUTE === 0 && ms >= MINUTE)
    return ms === MINUTE ? "every minute" : `every ${ms / MINUTE} minutes`;
  return `every ${Math.max(1, Math.round(ms / SECOND))} seconds`;
}

/** A Go duration as a span: "1h" → "1 hour", "720h" → "30 days". */
export function goDurationInWords(value: unknown): string | null {
  const ms = parseGoDuration(value);
  if (ms === null) return null;
  if (ms === 0) return "0 seconds";
  if (ms % DAY === 0) return unit(ms / DAY, "day");
  if (ms % HOUR === 0) return unit(ms / HOUR, "hour");
  if (ms % MINUTE === 0) return unit(ms / MINUTE, "minute");
  return unit(Math.round(ms / SECOND), "second");
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/**
 * A daily / weekly cron expression ("0 9 * * mon-fri") as a time and days:
 * { time: "09:00", days: "Mon–Fri" } (days null: every day). Other shapes:
 * null.
 */
export function parseSimpleCron(cron: string): { time: string; days: string | null } | null {
  const fields = String(cron ?? "").trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const [minute, hour, dom, month, dow] = fields;
  if (!/^\d+$/.test(minute) || !/^\d+$/.test(hour) || dom !== "*" || month !== "*") return null;
  const time = `${hour.padStart(2, "0")}:${minute.padStart(2, "0")}`;
  if (dow === "*") return { time, days: null };
  const day = (d: string) => {
    if (/^\d$/.test(d)) return WEEKDAYS[Number(d) % 7];
    const name = d.slice(0, 3).toLowerCase();
    return name.charAt(0).toUpperCase() + name.slice(1);
  };
  const days = dow
    .split(",")
    .map((part) => part.split("-").map(day).join("–"))
    .join(", ");
  return { time, days };
}

/** "a, b +3". */
export function listInWords(items: string[], max = 2): string {
  if (items.length <= max) return items.join(", ");
  return `${items.slice(0, max).join(", ")} +${items.length - max}`;
}

/** A label selector in words: "app=web, tier in (api, worker)", "everything". */
export function selectorInWords(selector: any): string {
  if (!selector || typeof selector !== "object") return "everything";
  const parts: string[] = Object.entries(selector.matchLabels ?? {}).map(
    ([key, value]) => `${key}=${value}`
  );
  for (const expression of selector.matchExpressions ?? []) {
    const values = (expression.values ?? []).join(", ");
    switch (expression.operator) {
      case "In":
        parts.push(`${expression.key} in (${values})`);
        break;
      case "NotIn":
        parts.push(`${expression.key} not in (${values})`);
        break;
      case "Exists":
        parts.push(`has ${expression.key}`);
        break;
      case "DoesNotExist":
        parts.push(`no ${expression.key}`);
        break;
    }
  }
  return parts.length ? parts.join(", ") : "everything";
}

/** Sentence case for machine words: "SecretSynced" → "Secret synced". */
export function humanize(word: string | undefined): string {
  if (!word) return "";
  const spaced = word
    .replace(/[_-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .trim();
  const lower = spaced.replace(/\b([A-Z])([a-z]+)\b/g, (_, a, b) => a.toLowerCase() + b);
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

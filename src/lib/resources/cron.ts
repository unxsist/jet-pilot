/*
 * CronJob schedules (pure, unit tested): the standard five fields plus the
 * macros Kubernetes accepts, in words ("Every day at 02:00") and the next
 * run in the CronJob's time zone (the controller's own, usually UTC, when it
 * sets none).
 */

export interface CronSchedule {
  minutes: number[];
  hours: number[];
  days: number[];
  months: number[];
  weekdays: number[];
  /** The field was `*` (or `?`): it doesn't restrict the day. */
  anyDay: boolean;
  anyWeekday: boolean;
}

const MACROS: Record<string, string> = {
  "@yearly": "0 0 1 1 *",
  "@annually": "0 0 1 1 *",
  "@monthly": "0 0 1 * *",
  "@weekly": "0 0 * * 0",
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@hourly": "0 * * * *",
};

const MONTH_NAMES = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
const DAY_NAMES = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];

const range = (from: number, to: number, step = 1) => {
  const values: number[] = [];
  for (let value = from; value <= to; value += step) values.push(value);
  return values;
};

function parseField(field: string, min: number, max: number, names?: string[], nameBase = 0): number[] | null {
  const value = (token: string) => {
    const index = names?.indexOf(token.toUpperCase()) ?? -1;
    if (index >= 0) return index + nameBase;
    return /^\d+$/.test(token) ? Number(token) : NaN;
  };
  const values = new Set<number>();
  for (const part of field.split(",")) {
    const [base, stepText] = part.split("/");
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step < 1 || base === undefined) return null;
    let from: number;
    let to: number;
    if (base === "*" || base === "?") {
      [from, to] = [min, max];
    } else if (base.includes("-")) {
      const [a, b] = base.split("-");
      [from, to] = [value(a ?? ""), value(b ?? "")];
    } else {
      from = value(base);
      // "5/15" runs from 5 to the end, like robfig/cron.
      to = stepText === undefined ? from : max;
    }
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < min || to > max || from > to) return null;
    for (const v of range(from, to, step)) values.add(v);
  }
  return [...values].sort((a, b) => a - b);
}

/** Parses a schedule; null when it isn't one Kubernetes would accept. */
export function parseCron(expression: string): CronSchedule | null {
  const text = MACROS[expression.trim().toLowerCase()] ?? expression.trim();
  const fields = text.split(/\s+/);
  if (fields.length !== 5) return null;
  const [m, h, dom, mon, dow] = fields as [string, string, string, string, string];
  const minutes = parseField(m, 0, 59);
  const hours = parseField(h, 0, 23);
  const days = parseField(dom, 1, 31);
  const months = parseField(mon, 1, 12, MONTH_NAMES, 1);
  // 7 is Sunday too.
  const weekdays = parseField(dow, 0, 7, DAY_NAMES)?.map((d) => d % 7);
  if (!minutes || !hours || !days || !months || !weekdays) return null;
  return {
    minutes,
    hours,
    days,
    months,
    weekdays: [...new Set(weekdays)].sort((a, b) => a - b),
    anyDay: dom === "*" || dom === "?",
    anyWeekday: dow === "*" || dow === "?",
  };
}

/* ------------------------------------------------------------ words -- */

const pad = (n: number) => String(n).padStart(2, "0");
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

const list = (items: string[]) =>
  items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;

const ordinal = (n: number) => {
  const suffix = n % 10 === 1 && n !== 11 ? "st" : n % 10 === 2 && n !== 12 ? "nd" : n % 10 === 3 && n !== 13 ? "rd" : "th";
  return `${n}${suffix}`;
};

/* A field that is one step over its whole range, e.g. every 5 minutes. */
const stepOf = (values: number[], min: number, max: number): number | null => {
  if (values.length < 2 || values[0] !== min) return null;
  const step = values[1]! - values[0]!;
  const expected = range(min, max, step);
  return expected.length === values.length && expected.every((v, i) => v === values[i]) ? step : null;
};

const isAll = (values: number[], min: number, max: number) => values.length === max - min + 1;

/* Contiguous run like 9-17. */
const span = (values: number[]): [number, number] | null => {
  const first = values[0];
  const last = values[values.length - 1];
  if (first === undefined || last === undefined || values.length < 3) return null;
  return last - first + 1 === values.length ? [first, last] : null;
};

/*
 * The days a schedule runs on, as a sentence start ("Every Monday", for
 * fixed times) and as a tail ("on Monday", after "Every 5 minutes").
 */
function dayWords(s: CronSchedule): { lead: string; tail: string } | null {
  const restrictsWeekday = !s.anyWeekday && s.weekdays.length < 7;
  const restrictsDay = !s.anyDay && s.days.length < 31;
  const restrictsMonth = s.months.length < 12;
  // Either matches when both are set: no short way to say that.
  if (restrictsWeekday && restrictsDay) return null;
  const months = list(s.months.map((m) => MONTHS[m - 1]!));

  if (restrictsDay) {
    const days = list(s.days.map(ordinal));
    if (!restrictsMonth) return { lead: `On the ${days} of every month`, tail: `on the ${days} of every month` };
    if (s.days.length === 1 && s.months.length === 1) {
      return { lead: `Every year on ${s.days[0]} ${months}`, tail: `on ${s.days[0]} ${months}` };
    }
    return { lead: `On the ${days} of ${months}`, tail: `on the ${days} of ${months}` };
  }
  const inMonths = restrictsMonth ? ` in ${months}` : "";
  if (restrictsWeekday) {
    const key = s.weekdays.join();
    if (key === "1,2,3,4,5") return { lead: `Weekdays${inMonths}`, tail: `on weekdays${inMonths}` };
    if (key === "0,6") return { lead: `Weekends${inMonths}`, tail: `on weekends${inMonths}` };
    const names = list(s.weekdays.map((d) => WEEKDAYS[d]!));
    return { lead: `Every ${names}${inMonths}`, tail: `on ${names}${inMonths}` };
  }
  return { lead: `Every day${inMonths}`, tail: inMonths.trim() };
}

/**
 * The schedule in words: "Every 5 minutes", "Every day at 02:00",
 * "Weekdays at 09:00", "Every Monday and Thursday at 18:30",
 * "Every 15 minutes from 09:00 to 17:59 on weekdays". Null when there is
 * no short way to say it (the expression then speaks for itself).
 */
export function describeCron(expression: string): string | null {
  const s = parseCron(expression);
  if (!s) return null;
  const days = dayWords(s);
  if (!days) return null;
  const withDays = (text: string) => (days.tail ? `${text} ${days.tail}` : text);
  const minuteStep = stepOf(s.minutes, 0, 59);
  const hourStep = stepOf(s.hours, 0, 23);
  const allMinutes = isAll(s.minutes, 0, 59);
  const allHours = isAll(s.hours, 0, 23);

  // Several times an hour.
  if (allMinutes || minuteStep) {
    const every = allMinutes ? "Every minute" : `Every ${minuteStep} minutes`;
    if (allHours) return withDays(every);
    const hours = span(s.hours);
    if (hours) return withDays(`${every} from ${pad(hours[0])}:00 to ${pad(hours[1])}:59`);
    return null;
  }
  // Once an hour (or every few hours).
  if (s.minutes.length === 1 && (allHours || hourStep)) {
    const minute = s.minutes[0]!;
    const every = allHours ? "Every hour" : `Every ${hourStep} hours`;
    return withDays(minute === 0 ? every : `${every} at :${pad(minute)}`);
  }
  // At a few fixed times of day.
  if (s.minutes.length * s.hours.length <= 4) {
    const times = s.hours.flatMap((h) => s.minutes.map((m) => `${pad(h)}:${pad(m)}`));
    return `${days.lead} at ${list(times)}`;
  }
  return null;
}

/* -------------------------------------------------------- next run -- */

/* The wall-clock fields of an instant in a time zone. */
function wallClock(at: number, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  }).formatToParts(new Date(at));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
}

/* The instant at which the wall clock of `timeZone` shows `wall` (as UTC fields). */
function fromWallClock(wall: number, timeZone: string): number {
  let at = wall;
  // Two rounds settle the offset, also right after a DST change.
  for (let i = 0; i < 2; i++) at = wall - (wallClock(at, timeZone) - at);
  return at;
}

/** A valid IANA time zone name (what `spec.timeZone` takes). */
export function isTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

const MINUTE = 60_000;
const DAY_MS = 86_400_000;

/**
 * The next run after `from` (epoch ms) in `timeZone` (default UTC), or null
 * for an invalid schedule / time zone or one that never runs (e.g. 31
 * February).
 */
export function nextCronRun(expression: string, from: number, timeZone = "UTC"): number | null {
  const s = parseCron(expression);
  if (!s || !isTimeZone(timeZone)) return null;
  const minutes = new Set(s.minutes);
  const hours = new Set(s.hours);
  const days = new Set(s.days);
  const months = new Set(s.months);
  const weekdays = new Set(s.weekdays);
  // Day of month and day of week: either matches when both are restricted.
  const dayMatches = (date: Date) => {
    const dom = days.has(date.getUTCDate());
    const dow = weekdays.has(date.getUTCDay());
    if (!s.anyDay && !s.anyWeekday) return dom || dow;
    return dom && dow;
  };

  // Walk the wall clock (UTC fields stand for the zone's local time).
  let wall = Math.floor(wallClock(from, timeZone) / MINUTE) * MINUTE + MINUTE;
  const limit = wall + 5 * 366 * DAY_MS;
  while (wall < limit) {
    const date = new Date(wall);
    if (!months.has(date.getUTCMonth() + 1)) {
      wall = Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
      continue;
    }
    if (!dayMatches(date)) {
      wall = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1);
      continue;
    }
    if (!hours.has(date.getUTCHours())) {
      wall = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), date.getUTCHours() + 1);
      continue;
    }
    if (!minutes.has(date.getUTCMinutes())) {
      wall += MINUTE;
      continue;
    }
    const at = fromWallClock(wall, timeZone);
    // A time skipped by a DST change doesn't run.
    if (wallClock(at, timeZone) === wall && at > from) return at;
    wall += MINUTE;
  }
  return null;
}

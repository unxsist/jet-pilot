/*
 * Per resource kind table preferences, persisted in localStorage under
 * `jet.table.<kind>`: column order, widths, user visibility overrides and
 * the group-by key.
 *
 * (Kept local to the table: the settings provider lives elsewhere. A view
 * can still opt out by not passing / deriving a persist key.)
 */

export interface TablePrefs {
  /** Column ids in display order (unknown / new columns are appended). */
  order?: string[];
  /** User set widths in px. */
  sizes?: Record<string, number>;
  /** Explicit show / hide choices; win over automatic visibility. */
  visibility?: Record<string, boolean>;
  /** Group-by key (see ./grouping.ts), null / absent: not grouped. */
  groupBy?: string | null;
}

export const PREFS_PREFIX = "jet.table.";

const storage = (): Storage | null => {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
};

export const prefsKey = (kind: string) =>
  `${PREFS_PREFIX}${kind.trim().toLowerCase().replace(/\s+/g, "-")}`;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

/** Reads and validates stored prefs; anything malformed is dropped. */
export function loadTablePrefs(kind: string): TablePrefs {
  const raw = storage()?.getItem(prefsKey(kind));
  if (!raw) return {};

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) return {};

    const prefs: TablePrefs = {};
    if (Array.isArray(parsed.order)) {
      prefs.order = parsed.order.filter(
        (id): id is string => typeof id === "string"
      );
    }
    if (isRecord(parsed.sizes)) {
      prefs.sizes = Object.fromEntries(
        Object.entries(parsed.sizes).filter(
          ([, v]) => typeof v === "number" && Number.isFinite(v) && v > 0
        )
      ) as Record<string, number>;
    }
    if (isRecord(parsed.visibility)) {
      prefs.visibility = Object.fromEntries(
        Object.entries(parsed.visibility).filter(
          ([, v]) => typeof v === "boolean"
        )
      ) as Record<string, boolean>;
    }
    if (typeof parsed.groupBy === "string" || parsed.groupBy === null) {
      prefs.groupBy = parsed.groupBy;
    }
    return prefs;
  } catch {
    return {};
  }
}

export function saveTablePrefs(kind: string, prefs: TablePrefs) {
  const store = storage();
  if (!store) return;

  const compact: TablePrefs = {};
  if (prefs.order?.length) compact.order = prefs.order;
  if (prefs.sizes && Object.keys(prefs.sizes).length)
    compact.sizes = prefs.sizes;
  if (prefs.visibility && Object.keys(prefs.visibility).length) {
    compact.visibility = prefs.visibility;
  }
  if (prefs.groupBy) compact.groupBy = prefs.groupBy;

  try {
    if (Object.keys(compact).length === 0) {
      store.removeItem(prefsKey(kind));
    } else {
      store.setItem(prefsKey(kind), JSON.stringify(compact));
    }
  } catch {
    /* quota / private mode: preferences are best effort */
  }
}

/** Column ids that never move: selection first, row actions last. */
const PINNED_START = ["select"];
const PINNED_END = ["actions"];

/**
 * Full display order: the stored order for known columns, then columns the
 * stored order does not know (new columns, printer columns) at their
 * natural position relative to their predecessor. Pinned columns stay put.
 */
export function resolveColumnOrder(
  columnIds: readonly string[],
  stored: readonly string[] | undefined
): string[] {
  const movable = columnIds.filter(
    (id) => !PINNED_START.includes(id) && !PINNED_END.includes(id)
  );
  const known = new Set(movable);
  const order = (stored || []).filter((id) => known.has(id));
  const placed = new Set(order);

  movable.forEach((id, index) => {
    if (placed.has(id)) return;
    // after the closest preceding column that is already placed
    let insertAt = 0;
    for (let i = index - 1; i >= 0; i--) {
      const position = order.indexOf(movable[i]);
      if (position >= 0) {
        insertAt = position + 1;
        break;
      }
    }
    order.splice(insertAt, 0, id);
    placed.add(id);
  });

  return [
    ...PINNED_START.filter((id) => columnIds.includes(id)),
    ...order,
    ...PINNED_END.filter((id) => columnIds.includes(id)),
  ];
}

/** Moves `id` to sit before `beforeId` (null: to the end of the movable columns). */
export function moveColumn(
  order: readonly string[],
  id: string,
  beforeId: string | null
): string[] {
  if (PINNED_START.includes(id) || PINNED_END.includes(id) || id === beforeId) {
    return [...order];
  }
  const without = order.filter((c) => c !== id);
  let index = beforeId === null ? -1 : without.indexOf(beforeId);
  if (index < 0) {
    const firstPinnedEnd = without.findIndex((c) => PINNED_END.includes(c));
    index = firstPinnedEnd < 0 ? without.length : firstPinnedEnd;
  }
  const minIndex = without.filter((c) => PINNED_START.includes(c)).length;
  index = Math.max(index, minIndex);
  return [...without.slice(0, index), id, ...without.slice(index)];
}

export const MIN_COLUMN_WIDTH = 48;
export const MAX_COLUMN_WIDTH = 1200;

export const clampWidth = (px: number) =>
  Math.round(Math.min(MAX_COLUMN_WIDTH, Math.max(MIN_COLUMN_WIDTH, px)));

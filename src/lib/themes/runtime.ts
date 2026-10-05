/*
 * Pure decisions of the theme runtime (src/providers/ThemeRuntime.ts): no
 * culori, no Vue. Which theme and appearance to paint, theme ids of user
 * files and installs, and the first-paint cache read by public/boot.js.
 */
import type { BootCache, BootCacheEntry, ThemeChoice } from "./scheme";
import type { ThemeAppearance, ThemeEntry, ThemeFile, ThemeSettings } from "./types";

export {
  COLOR_SCHEME_KEY,
  THEME_CACHE_KEY,
  wantedAppearance,
  type BootCache,
  type BootCacheEntry,
  type ThemeChoice,
} from "./scheme";

/*
 * Which appearances a theme has and which one it paints: shared by the
 * runtime, the settings UI and the culori chunk (resolve, serialize).
 */

/** Appearances a file can render (base + variants), light first. */
export function themeAppearances(
  file: Pick<ThemeFile, "appearance" | "variants">
): ThemeAppearance[] {
  return (["light", "dark"] as const).filter(
    (appearance) => appearance === file.appearance || !!file.variants?.[appearance]
  );
}

/**
 * The appearance a theme is painted in: the wanted one when it has it,
 * otherwise its own (T3: a dark-only theme chosen for light mode paints
 * dark, the `.dark` class included).
 */
export function paintedAppearance(
  appearances: readonly ThemeAppearance[],
  wanted: ThemeAppearance
): ThemeAppearance {
  return appearances.length === 0 || appearances.includes(wanted) ? wanted : appearances[0]!;
}

/** The themes folder below $APPCONFIG, and T3's limits for it. */
export const THEMES_DIR = "themes";
export const MAX_THEME_FILES = 64;
export const MAX_THEME_FILE_BYTES = 256 * 1024;

export const THEME_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,47})$/;

/** Ids a user theme may not take: the appearance keywords and JET's default. */
export const RESERVED_THEME_IDS: ReadonlySet<string> = new Set([
  "system",
  "light",
  "dark",
  "jet",
]);

/** "Tokyo Night Storm" → "tokyo-night-storm" (T3's rule). */
export function themeIdFromName(name: string): string {
  const normalized = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/, "");
  return normalized || "custom-theme";
}

/** "nightfall.json" → "nightfall": the file name is the id (T3's rule), slugged when it isn't one. */
export function themeIdFromFileName(fileName: string): string {
  const stem = fileName.replace(/\.json$/i, "");
  return THEME_ID_PATTERN.test(stem) ? stem : themeIdFromName(stem);
}

/**
 * The id of a file of the themes folder, and why it can't have it (null
 * when it can). A file whose id is a built-in's, reserved or another
 * file's gets a distinct id (`<id>~<file name>`, like duplicates) and is
 * listed as broken, so it can be opened and fixed in the editor.
 */
export function userFileId(
  fileName: string,
  isBuiltin: (id: string) => boolean,
  isSeen: (id: string) => boolean
): { id: string; conflict: string | null } {
  const id = themeIdFromFileName(fileName);
  let conflict: string | null = null;
  if (isBuiltin(id)) conflict = `"${id}" is the id of a built-in theme: rename the file.`;
  else if (RESERVED_THEME_IDS.has(id)) conflict = `The theme id "${id}" is reserved: rename the file.`;
  else if (isSeen(id)) conflict = `Another theme file already uses the id "${id}": rename this one.`;
  return conflict ? { id: `${id}~${fileName}`, conflict } : { id, conflict };
}

/** Where saving a user theme writes. */
export interface SavePlan {
  /** The theme's id once saved. */
  id: string;
  /** The file written. */
  fileName: string;
  /** The file removed afterwards (a rename); null when none. */
  remove: string | null;
}

/**
 * Saving a user theme. The file name is the id, so a save renames the file
 * only when the JSON has an explicit `id` other than the current one; a
 * changed name never renames. File names that differ only in case are the
 * same file on APFS / NTFS: the existing file is overwritten, never removed.
 */
export function planThemeSave(
  current: { id: string; fileName: string },
  explicitId: string | undefined
): SavePlan {
  const keep: SavePlan = { id: current.id, fileName: current.fileName, remove: null };
  if (explicitId === undefined || explicitId === current.id) return keep;
  const fileName = `${explicitId}.json`;
  if (fileName.toLowerCase() === current.fileName.toLowerCase()) return keep;
  return { id: explicitId, fileName, remove: current.fileName };
}

/**
 * The saved theme for the wanted appearance. `lookup` returns a known
 * theme's appearances (undefined when unknown, null when the theme is
 * broken); unknown and broken themes fall back to `fallbackId` (JET).
 */
export function pickTheme(
  settings: Pick<ThemeSettings, "lightTheme" | "darkTheme">,
  wanted: ThemeAppearance,
  lookup: (id: string) => readonly ThemeAppearance[] | null | undefined,
  fallbackId: string
): ThemeChoice {
  let id = wanted === "light" ? settings.lightTheme : settings.darkTheme;
  let appearances = lookup(id);
  if (!appearances) {
    id = fallbackId;
    appearances = lookup(fallbackId) ?? ["light", "dark"];
  }
  return { id, appearance: paintedAppearance(appearances, wanted) };
}

/** `base`, or `base-2`, `base-3`... (at most 48 characters) when taken. */
export function uniqueThemeId(base: string, taken: (id: string) => boolean): string {
  if (!taken(base)) return base;
  for (let n = 2; ; n++) {
    const suffix = `-${n}`;
    const candidate = `${base.slice(0, 48 - suffix.length).replace(/-+$/, "")}${suffix}`;
    if (!taken(candidate)) return candidate;
  }
}

/**
 * What picking a theme (a card, a palette option) does, T3 Code's rule: a
 * theme with both appearances is used for both; a single-appearance theme
 * claims its own half only (Dracula becomes the dark theme).
 */
export function clickMode(entry: Pick<ThemeEntry, "appearances">): ThemeAppearance | "both" {
  return entry.appearances.length === 1 ? entry.appearances[0]! : "both";
}

/** Palette / settings groups. */
export type ThemeGroup = "Built-in" | "T3 Code" | "Yours" | "Open VSX";

export function themeGroup(entry: Pick<ThemeEntry, "source" | "origin">): ThemeGroup {
  if (entry.source === "openvsx") return "Open VSX";
  if (entry.source === "user") return "Yours";
  return entry.origin?.label === "T3 Code" ? "T3 Code" : "Built-in";
}

/** Source of a user theme file: Open VSX installs carry `origin.label = "Open VSX"`. */
export const OPEN_VSX_LABEL = "Open VSX";

/* ------------------------------------------------------- boot cache -- */

/** One appearance of the cache (BootCacheEntry in ./scheme.ts). */
export function bootCacheEntry(
  choice: ThemeChoice,
  vars: Record<string, string> | null
): BootCacheEntry {
  return { id: choice.id, dark: choice.appearance === "dark", ...(vars ? { vars } : {}) };
}

const isEntry = (value: unknown): value is BootCacheEntry =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as BootCacheEntry).id === "string" &&
  typeof (value as BootCacheEntry).dark === "boolean" &&
  ((value as BootCacheEntry).vars === undefined ||
    (typeof (value as BootCacheEntry).vars === "object" && (value as BootCacheEntry).vars !== null));

/** Tolerant: anything unexpected reads as an empty cache. */
export function parseBootCache(raw: string | null): BootCache {
  try {
    const value = raw ? JSON.parse(raw) : null;
    if (!value || value.v !== 1) return { v: 1 };
    return {
      v: 1,
      ...(isEntry(value.light) ? { light: value.light } : {}),
      ...(isEntry(value.dark) ? { dark: value.dark } : {}),
    };
  } catch {
    return { v: 1 };
  }
}

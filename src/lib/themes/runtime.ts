/*
 * Pure decisions of the theme runtime (src/providers/ThemeRuntime.ts): no
 * culori, no Vue. Which theme and appearance to paint, theme ids of user
 * files and installs, and the first-paint cache read by public/boot.js.
 */
import type {
  ThemeAppearance,
  ThemeEntry,
  ThemeFile,
  ThemeSettings,
} from "./types";

export { COLOR_SCHEME_KEY, THEME_CACHE_KEY, wantedAppearance } from "./scheme";

/** The themes folder below $APPCONFIG, and T3's limits for it. */
export const THEMES_DIR = "themes";
export const MAX_THEME_FILES = 64;
export const MAX_THEME_FILE_BYTES = 256 * 1024;

export const THEME_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,47})$/;

/** "Tokyo Night Storm" → "tokyo-night-storm" (T3's rule). */
export function themeIdFromName(name: string): string {
  const normalized = name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
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

/** Appearances a file can render (base + variants), light first. */
export function fileAppearances(file: ThemeFile): ThemeAppearance[] {
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
  return appearances.length === 0 || appearances.includes(wanted) ? wanted : appearances[0];
}

export interface ThemeChoice {
  id: string;
  /** The appearance painted (see paintedAppearance). */
  appearance: ThemeAppearance;
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

/**
 * What public/boot.js paints for one wanted appearance: the `.dark` class
 * and, for themes other than JET, the token triplets (JET's live in
 * main.postcss). Both appearances are cached so a system light/dark flip
 * between runs doesn't flash either.
 */
export interface BootCacheEntry {
  id: string;
  dark: boolean;
  /** CSS custom properties without "--" (absent for JET). */
  vars?: Record<string, string>;
}

export interface BootCache {
  v: 1;
  light?: BootCacheEntry;
  dark?: BootCacheEntry;
}

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

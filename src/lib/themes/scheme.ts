/*
 * The part of the theme runtime in the startup bundle (ThemeProvider):
 * the colour scheme, the localStorage keys public/boot.js reads and the
 * shape of its first-paint cache (written by the lazy runtime; no cache
 * paints JET).
 */
import type { ColorScheme, ThemeAppearance } from "./types";

/** localStorage: what public/boot.js paints before the app bundle runs (see BootCache). */
export const THEME_CACHE_KEY = "jet-theme-cache";
/** localStorage: the colour scheme (auto / light / dark), also read by boot.js. */
export const COLOR_SCHEME_KEY = "vueuse-color-scheme";

/** The appearance the colour scheme asks for. */
export function wantedAppearance(scheme: ColorScheme, systemDark: boolean): ThemeAppearance {
  if (scheme === "light" || scheme === "dark") return scheme;
  return systemDark ? "dark" : "light";
}

export interface ThemeChoice {
  id: string;
  /** The appearance painted (see paintedAppearance). */
  appearance: ThemeAppearance;
}

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

/*
 * The part of the theme runtime in the startup bundle (ThemeProvider):
 * the colour scheme and the localStorage keys public/boot.js reads.
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

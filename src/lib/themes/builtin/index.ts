/*
 * The built-in themes. Only this list (the small manifest) is part of the
 * startup bundle: every file is loaded on demand. JET (the default) is
 * built from ./jet.ts, which needs the colour maths (culori); the runtime
 * doesn't need its file to paint it (the stylesheet does). The others are
 * JSON files under ./themes, generated once by scripts/convert-themes.mjs
 * (T3 Code's palettes and curated VS Code themes). Licences:
 * THIRD_PARTY_THEMES.md.
 */
import type { ThemeAppearance, ThemeFile, ThemeOrigin } from "../types";
import manifest from "./manifest.json";

export interface BuiltinTheme {
  id: string;
  name: string;
  origin?: ThemeOrigin;
  appearances: ThemeAppearance[];
  load: () => Promise<ThemeFile>;
}

/** The built-in JET theme (src/assets/main.postcss); also the fallback. */
export const DEFAULT_THEME_ID = "jet";

const files = import.meta.glob<ThemeFile>("./themes/*.json", { import: "default" });

export const BUILTIN_THEMES: BuiltinTheme[] = [
  {
    id: DEFAULT_THEME_ID,
    name: "JET",
    origin: { label: "JET Pilot" },
    appearances: ["light", "dark"],
    load: () => import("./jet").then((module) => module.JET_THEME),
  },
  ...(manifest as Omit<BuiltinTheme, "load">[]).map((entry) => ({
    ...entry,
    load: () => {
      const load = files[`./themes/${entry.id}.json`];
      if (!load) return Promise.reject(new Error(`Built-in theme "${entry.id}" is missing.`));
      return load();
    },
  })),
];

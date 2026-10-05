/*
 * The built-in themes: a small manifest, loaded with the lazy theme runtime
 * (src/providers/ThemeRuntime.ts), not at start-up. Every file is loaded on
 * demand. JET (the default) is built from ./jet.ts, which needs the colour
 * maths (culori); the runtime doesn't need its file to paint it (the
 * stylesheet does). The others are JSON files under ./themes, listed by
 * scripts/convert-themes.mjs (curated VS Code themes, converted, and the
 * built-in palettes). Licences: THIRD_PARTY_THEMES.md.
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

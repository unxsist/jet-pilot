/*
 * The built-in themes. JET (the default) is bundled eagerly; every other
 * built-in is a JSON file under ./themes, generated once by
 * scripts/convert-themes.mjs (T3 Code's palettes and curated VS Code
 * themes) and loaded on demand, so the startup bundle only carries the
 * small manifest. Licences: THIRD_PARTY_THEMES.md.
 */
import type { ThemeAppearance, ThemeFile, ThemeOrigin } from "../types";
import { JET_THEME, JET_THEME_ID } from "./jet";
import manifest from "./manifest.json";

export interface BuiltinTheme {
  id: string;
  name: string;
  origin?: ThemeOrigin;
  appearances: ThemeAppearance[];
  load: () => Promise<ThemeFile>;
}

export const DEFAULT_THEME_ID = JET_THEME_ID;

const files = import.meta.glob<ThemeFile>("./themes/*.json", { import: "default" });

export const BUILTIN_THEMES: BuiltinTheme[] = [
  {
    id: JET_THEME_ID,
    name: JET_THEME.name,
    origin: { label: "JET Pilot" },
    appearances: ["light", "dark"],
    load: () => Promise.resolve(JET_THEME),
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

export { JET_THEME, JET_THEME_ID };

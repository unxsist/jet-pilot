/*
 * Theme files → text. The default keeps the file as authored (seeds,
 * overrides, jetPilot block) in a stable key order. `forT3` writes what
 * T3 Code's strict importer wants: version 1, all 57 roles resolved as hex
 * for the base and every variant (flat, T3's variant shape), no jetPilot
 * block, and an id T3 doesn't reserve.
 */
import { resolveTheme, themeAppearances } from "./resolve";
import { type ThemeColors, type ThemeFile, THEME_COLOR_ROLES } from "./types";
import { RESERVED_THEME_IDS, themeIdFromName } from "./validate";

/** Ids T3 Code refuses for imported themes (its built-ins and aliases). */
export const T3_RESERVED_THEME_IDS: ReadonlySet<string> = new Set([
  "system",
  "light",
  "dark",
  "t3-chat",
  "grove",
  "ocean",
  "ember",
  "iris",
  "t3-chat-dark",
  "t3-grove",
  "t3-ocean",
  "t3-ember",
  "t3-iris",
]);

const KEY_ORDER = [
  "$schema",
  "version",
  "id",
  "name",
  "appearance",
  "canvas",
  "accent",
  "colors",
  "variants",
  "jetPilot",
  "collection",
  "managed",
  "origin",
];

function ordered(file: ThemeFile): Record<string, unknown> {
  const source = file as unknown as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const key of KEY_ORDER) if (source[key] !== undefined) result[key] = source[key];
  for (const [key, value] of Object.entries(source)) {
    if (!(key in result) && value !== undefined) result[key] = value;
  }
  return result;
}

function t3Roles(file: ThemeFile, appearance: ThemeFile["appearance"]): ThemeColors {
  const { roles } = resolveTheme(file, appearance);
  return Object.fromEntries(THEME_COLOR_ROLES.map((role) => [role, roles[role]]));
}

function t3File(file: ThemeFile): Record<string, unknown> {
  let id = file.id ?? themeIdFromName(file.name);
  if (T3_RESERVED_THEME_IDS.has(id) || RESERVED_THEME_IDS.has(id)) id = `${id}-theme`;
  const variants = Object.fromEntries(
    themeAppearances(file)
      .filter((appearance) => appearance !== file.appearance)
      .map((appearance) => [appearance, t3Roles(file, appearance)])
  );
  return {
    version: 1,
    id,
    name: file.name.trim().slice(0, 48),
    appearance: file.appearance,
    colors: t3Roles(file, file.appearance),
    ...(Object.keys(variants).length > 0 ? { variants } : {}),
    ...(file.collection ? { collection: file.collection } : {}),
    ...(file.managed ? { managed: true } : {}),
  };
}

/** 2-space JSON with a trailing newline. */
export function serializeTheme(file: ThemeFile, opts: { forT3?: boolean } = {}): string {
  const value = opts.forT3 ? t3File(file) : ordered(file);
  return `${JSON.stringify(value, null, 2)}\n`;
}

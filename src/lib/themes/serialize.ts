/*
 * Theme files → text. The default keeps the file as authored (seeds,
 * overrides, jetPilot block) in a stable key order. `portable` writes a
 * standard theme file any strict reader of the format accepts: version 1,
 * all 57 roles resolved as hex for the base and every variant (flat
 * variant shape), no jetPilot block, and an id that is neither reserved
 * nor a built-in theme's.
 */
import builtinManifest from "./builtin/manifest.json";
import { canonicalThemeId, themeAppearances } from "./runtime";
import { resolveTheme } from "./resolve";
import { type ThemeColors, type ThemeFile, THEME_COLOR_ROLES } from "./types";
import { RESERVED_THEME_IDS, themeIdFromName } from "./validate";

/** Built-in ids (current and former): a portable export doesn't take them. */
const BUILTIN_IDS: ReadonlySet<string> = new Set([
  "jet",
  ...builtinManifest.map((theme) => theme.id),
]);
const isTakenId = (id: string) =>
  RESERVED_THEME_IDS.has(id) || BUILTIN_IDS.has(id) || canonicalThemeId(id) !== id;

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

function resolvedRoles(file: ThemeFile, appearance: ThemeFile["appearance"]): ThemeColors {
  const { roles } = resolveTheme(file, appearance);
  return Object.fromEntries(THEME_COLOR_ROLES.map((role) => [role, roles[role]]));
}

function portableFile(file: ThemeFile): Record<string, unknown> {
  let id = file.id ?? themeIdFromName(file.name);
  if (isTakenId(id)) id = `${id}-theme`;
  const variants = Object.fromEntries(
    themeAppearances(file)
      .filter((appearance) => appearance !== file.appearance)
      .map((appearance) => [appearance, resolvedRoles(file, appearance)])
  );
  return {
    version: 1,
    id,
    name: file.name.trim().slice(0, 48),
    appearance: file.appearance,
    colors: resolvedRoles(file, file.appearance),
    ...(Object.keys(variants).length > 0 ? { variants } : {}),
    ...(file.collection ? { collection: file.collection } : {}),
    ...(file.managed ? { managed: true } : {}),
  };
}

/** 2-space JSON with a trailing newline. */
export function serializeTheme(file: ThemeFile, opts: { portable?: boolean } = {}): string {
  const value = opts.portable ? portableFile(file) : ordered(file);
  return `${JSON.stringify(value, null, 2)}\n`;
}

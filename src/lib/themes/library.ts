/*
 * Pure helpers of the theme settings UI (Settings › Appearance, the theme
 * editor and the Open VSX gallery): grouping and badges of theme cards,
 * which halves a theme is used for, drop-file classification, gallery
 * formatting and the "New theme" template. No culori, no Vue: cheap to
 * import and unit-tested in Node.
 */
import { themeGroup } from "./runtime";

export { clickMode } from "./runtime";
import type {
  ImportFormat,
  ThemeAppearance,
  ThemeEntry,
  ThemeFile,
  ThemeSettings,
} from "./types";

/* ------------------------------------------------------------ groups -- */

export type LibraryGroupId = "builtin" | "yours";

export interface LibraryGroup {
  id: LibraryGroupId;
  label: string;
  entries: ThemeEntry[];
}

const GROUP_LABELS: Record<LibraryGroupId, string> = {
  builtin: "Built-in",
  yours: "Your themes",
};

/**
 * Theme cards in two groups: Built-in (JET, the curated themes and the
 * built-in palettes) and Your themes (files of the themes folder, Open VSX
 * installs included; broken files too, so they can be fixed). Built-ins keep the
 * manifest order; your themes are sorted by name. The Your themes group is
 * always present (it carries the empty state).
 */
export function groupThemes(entries: readonly ThemeEntry[]): LibraryGroup[] {
  const groups: Record<LibraryGroupId, ThemeEntry[]> = { builtin: [], yours: [] };
  for (const entry of entries) {
    if (entry.source !== "builtin") groups.yours.push(entry);
    else groups.builtin.push(entry);
  }
  groups.yours.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  return (Object.keys(groups) as LibraryGroupId[])
    .filter((id) => id === "yours" || groups[id].length > 0)
    .map((id) => ({ id, label: GROUP_LABELS[id], entries: groups[id] }));
}

export type BadgeTone = "muted" | "accent" | "info" | "outline" | "destructive";

/** The origin badge of a theme card. */
export function themeBadge(entry: Pick<ThemeEntry, "source" | "error">): {
  label: string;
  tone: BadgeTone;
} {
  if (entry.error) return { label: "Broken", tone: "destructive" };
  switch (themeGroup(entry)) {
    case "Open VSX":
      return { label: "Open VSX", tone: "info" };
    case "Yours":
      return { label: "Yours", tone: "accent" };
    default:
      return { label: "Built-in", tone: "muted" };
  }
}

/* ------------------------------------------------------------- usage -- */

export type ThemeUsage = ThemeAppearance | "both" | null;

/** Which halves of the appearance settings use `id`. */
export function themeUsage(
  id: string,
  settings: Pick<ThemeSettings, "lightTheme" | "darkTheme">
): ThemeUsage {
  const light = settings.lightTheme === id;
  const dark = settings.darkTheme === id;
  if (light && dark) return "both";
  if (light) return "light";
  if (dark) return "dark";
  return null;
}

/**
 * The appearance chips of a card: the appearances the theme has, plus a
 * half it is used for without having it (a dark-only theme picked for
 * light mode paints dark). `used` marks the halves that use it.
 */
export function appearanceChips(
  entry: Pick<ThemeEntry, "id" | "appearances">,
  settings: Pick<ThemeSettings, "lightTheme" | "darkTheme">
): { appearance: ThemeAppearance; used: boolean; native: boolean }[] {
  const usedFor = (appearance: ThemeAppearance) =>
    (appearance === "light" ? settings.lightTheme : settings.darkTheme) === entry.id;
  return (["light", "dark"] as const)
    .filter((appearance) => entry.appearances.includes(appearance) || usedFor(appearance))
    .map((appearance) => ({
      appearance,
      used: usedFor(appearance),
      native: entry.appearances.includes(appearance),
    }));
}

export interface UseOption {
  mode: ThemeAppearance | "both";
  label: string;
}

/** The "Use for…" menu items: only the halves the theme can paint. */
export function useOptions(entry: Pick<ThemeEntry, "appearances">): UseOption[] {
  if (entry.appearances.length === 1) {
    const only = entry.appearances[0]!;
    return [{ mode: only, label: `Use for ${only} mode` }];
  }
  return [
    { mode: "light", label: "Use for light mode" },
    { mode: "dark", label: "Use for dark mode" },
    { mode: "both", label: "Use for both" },
  ];
}

/* --------------------------------------------------------- duplicate -- */

/** "Duplicate & edit": a user copy `<id>-custom` named "<name> (custom)". */
export function duplicateTheme(file: ThemeFile, id: string): ThemeFile {
  const suffix = "-custom";
  const base = id.replace(/~.*$/, "");
  const copyId = `${base.slice(0, 48 - suffix.length).replace(/-+$/, "")}${suffix}`;
  const name = `${file.name} (custom)`.slice(0, 48);
  // A copy is the user's own: not managed by whoever shipped the original.
  const rest: ThemeFile = { ...file };
  delete rest.managed;
  return { ...rest, id: copyId, name };
}

/* ---------------------------------------------------------- importing -- */

export type ThemeFileKind = "json" | "sublime" | "tmtheme";

/** Extensions the importer reads (dialog filters and dropped files). */
export const THEME_FILE_EXTENSIONS = ["json", "jsonc", "sublime-color-scheme", "tmTheme"] as const;

/** Larger files are not themes (the importer caps text at 512 KB). */
export const MAX_IMPORT_BYTES = 512 * 1024;

/** The kind of a dropped / picked file by its name; null when it can't be a theme. */
export function classifyThemeFile(name: string): ThemeFileKind | null {
  const lower = name.toLowerCase();
  if (lower.endsWith(".sublime-color-scheme")) return "sublime";
  if (lower.endsWith(".tmtheme")) return "tmtheme";
  if (lower.endsWith(".json") || lower.endsWith(".jsonc")) return "json";
  return null;
}

/** The base name of a path (either separator). */
export const fileNameOf = (path: string) => path.split(/[\\/]/).pop() || path;

/** `origin.label` of themes imported from a file of this format. */
export function originLabel(format: ImportFormat): string | null {
  switch (format) {
    case "vscode":
      return "VS Code";
    case "sublime":
      return "Sublime Text";
    case "tmtheme":
      return "TextMate";
    default:
      return null;
  }
}

/** Human name of an import format. */
export function formatLabel(format: ImportFormat): string {
  if (format === "jet") return "JET Pilot";
  if (format === "portable") return "JSON theme";
  return originLabel(format)!;
}

/* ----------------------------------------------------------- Open VSX -- */

export const openVsxUrl = (namespace: string, name: string) =>
  `https://open-vsx.org/extension/${namespace}/${name}`;

/** True when a theme of that extension is installed (by `origin.url`). */
export function isExtensionInstalled(
  entries: readonly Pick<ThemeEntry, "origin">[],
  namespace: string,
  name: string
): boolean {
  const url = openVsxUrl(namespace, name);
  return entries.some((entry) => entry.origin?.url === url);
}

/** 1284301 → "1.3M", 412877 → "413K", 5402 → "5.4K", 312 → "312". */
export function formatCount(value: number): string {
  if (!Number.isFinite(value) || value < 0) return "0";
  const scaled = (n: number, unit: string) => {
    const digits = n < 10 ? 1 : 0;
    return `${n.toFixed(digits).replace(/\.0$/, "")}${unit}`;
  };
  if (value >= 999_950) return scaled(value / 1_000_000, "M");
  if (value >= 1_000) return scaled(value / 1_000, "K");
  return String(Math.round(value));
}

/* ------------------------------------------------------------ editor -- */

export const NEW_THEME_SEED = {
  version: 1,
  name: "My theme",
  appearance: "dark",
  canvas: "#16161e",
  accent: "#7aa2f7",
  colors: {},
} as const;

/** The JSON of a new theme, with `$schema` first (completion and swatches). */
export function newThemeText(schemaUri: string): string {
  return `${JSON.stringify({ $schema: schemaUri, ...NEW_THEME_SEED }, null, 2)}\n`;
}

/**
 * The line of a theme file a validation message is about: the first
 * property named in the message ("colors": "…"), else the section it names
 * ("variants.dark: …", "jetPilot: …"). Null when nothing matches.
 */
export function errorLine(text: string, message: string): number | null {
  const candidates = [
    ...[...message.matchAll(/"([^"\n]{1,64})"/g)].map((match) => match[1]!),
    ...(/^variants\.(light|dark)/.exec(message)?.slice(1) ?? []),
    ...(/jetPilot/.test(message) ? ["jetPilot"] : []),
  ];
  for (const key of candidates) {
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = new RegExp(`"${escaped}"\\s*:`).exec(text);
    if (match) return text.slice(0, match.index).split("\n").length;
  }
  return null;
}

const JET_ROLE_NAMES: ReadonlySet<string> = new Set([
  "success",
  "successForeground",
  "info",
  "infoForeground",
]);
const STRUCTURED_KEYS: ReadonlySet<string> = new Set(["canvas", "accent", "colors", "jetPilot"]);

/**
 * JSON paths where a role of `appearance` lives in a raw theme file, best
 * first: the variant body for the non-base appearance (the flat variant
 * form included), the base otherwise; JET roles under jetPilot.colors;
 * canvas / accent also as seeds. The first path is where a new value goes.
 */
export function rolePaths(raw: unknown, role: string, appearance: ThemeAppearance): string[][] {
  const file = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const variants = (typeof file.variants === "object" && file.variants !== null
    ? file.variants
    : {}) as Record<string, unknown>;
  const variant = file.appearance !== appearance ? variants[appearance] : undefined;
  const isVariant = typeof variant === "object" && variant !== null;
  const base: string[] = isVariant ? ["variants", appearance] : [];
  if (JET_ROLE_NAMES.has(role)) return [[...base, "jetPilot", "colors", role]];
  const flat = isVariant && Object.keys(variant).some((key) => !STRUCTURED_KEYS.has(key));
  const paths: string[][] = flat ? [[...base, role]] : [[...base, "colors", role]];
  if (role === "canvas" || role === "accent") paths.push([...base, role]);
  return paths;
}

/** Parse errors as "Line 3, column 5: …" from a JSON.parse message and the text. */
export function jsonErrorLocation(text: string, message: string): { line: number; column: number } | null {
  const position = /position (\d+)/i.exec(message);
  const lineColumn = /line (\d+) column (\d+)/i.exec(message);
  if (lineColumn) return { line: Number(lineColumn[1]), column: Number(lineColumn[2]) };
  if (!position) return null;
  const offset = Math.min(Number(position[1]), text.length);
  const before = text.slice(0, offset).split("\n");
  return { line: before.length, column: before[before.length - 1]!.length + 1 };
}

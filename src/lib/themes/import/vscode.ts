/*
 * Import of VS Code colour themes (`*-color-theme.json`, JSONC).
 *
 * VS Code themes describe editor chrome, not an app palette: a few hundred
 * workbench keys, most unset, freely using 8-digit hex with alpha. The
 * conversion derives a complete palette from a visible accent and the
 * editor background, then lays the usable workbench colours on top:
 * foregrounds only win when they stay readable (4.5:1) on the surface they
 * land on, translucent colours are composited onto that surface. That
 * part, the detection and the light/dark pairing are ported from T3 Code
 * (MIT, github.com/pingdotgg/t3code, apps/web/src/vscodeThemeImport.ts).
 *
 * Beyond T3, the parts JET Pilot can paint are kept in `jetPilot`:
 * tokenColors → syntax (TextMate scope matching, ./scopes.ts),
 * terminal.ansi* → terminal, editor / widget / scrollbar keys → editor, and
 * success / info from the git decoration / info colours.
 */
import { parse as parseJsonc, type ParseError, printParseErrorCode } from "jsonc-parser";
import { parse as parsePlist } from "fast-plist";
import {
  type Rgb,
  type Rgba,
  contrastRgb,
  flattenOver,
  isDarkRgb,
  parseColor,
  rgbOf,
  rgbToHex,
  toHexAlpha,
} from "../contrast";
import { createVividThemeColors, DEFAULT_SEEDS, pickActionColor } from "../derive";
import { themeAppearances } from "../runtime";
import {
  type AnsiColor,
  type JetPilotThemeExtensions,
  type ThemeAppearance,
  type ThemeColorRole,
  type ThemeFile,
  type ThemeVariant,
  ANSI_COLORS,
} from "../types";
import { isRecord, RESERVED_THEME_IDS, themeIdFromName } from "../validate";
import { readTokenRules, syntaxFromRules } from "./scopes";

export interface VsCodeImportOptions {
  /** Reads an `include`d theme (or a tokenColors .tmTheme path). */
  resolveInclude?: (path: string) => string | undefined;
  /** contributes.themes[].uiTheme, for files without a `type`. */
  uiTheme?: string;
  /** contributes.themes[].label: VS Code shows this, and an extension's files often share one `name`. */
  label?: string;
  filename?: string;
}

const MAX_INCLUDE_DEPTH = 8;

/** Workbench keys tried, in order, for the hairline border. */
const BORDER_KEYS = [
  "panel.border",
  "editorGroup.border",
  "contrastBorder",
  "sideBar.border",
  "tab.border",
  "editorWidget.border",
] as const;
/** Contrast range (on the canvas) of a border that reads as a hairline. */
const BORDER_CONTRAST = { min: 1.1, max: 3.2 } as const;

/** Contrast range (on the canvas) of a list colour usable as the hover surface. */
const ACCENT_SURFACE_CONTRAST = { min: 1.05, max: 2.2 } as const;

/** Workbench keys tried, in order, for the primary action colour. */
const ACTION_KEYS = [
  "button.background",
  "statusBarItem.remoteBackground",
  "activityBarBadge.background",
  "progressBar.background",
  "focusBorder",
  "textLink.foreground",
  "list.highlightForeground",
] as const;

/** Keys copied into `jetPilot.editor` (Monaco, plus the terminal keys xterm reads). */
export const EDITOR_KEYS: ReadonlySet<string> = new Set([
  "editor.background",
  "editor.foreground",
  "editor.lineHighlightBackground",
  "editor.lineHighlightBorder",
  "editor.selectionBackground",
  "editor.selectionForeground",
  "editor.inactiveSelectionBackground",
  "editor.selectionHighlightBackground",
  "editor.wordHighlightBackground",
  "editor.wordHighlightStrongBackground",
  "editor.findMatchBackground",
  "editor.findMatchHighlightBackground",
  "editor.rangeHighlightBackground",
  "editor.foldBackground",
  "editorCursor.foreground",
  "editorCursor.background",
  "editorLineNumber.foreground",
  "editorLineNumber.activeForeground",
  "editorIndentGuide.background1",
  "editorIndentGuide.activeBackground1",
  "editorWhitespace.foreground",
  "editorBracketMatch.background",
  "editorBracketMatch.border",
  "editorGutter.background",
  "editorWidget.background",
  "editorWidget.foreground",
  "editorWidget.border",
  "editorSuggestWidget.background",
  "editorSuggestWidget.foreground",
  "editorSuggestWidget.border",
  "editorSuggestWidget.selectedBackground",
  "editorSuggestWidget.highlightForeground",
  "editorHoverWidget.background",
  "editorHoverWidget.border",
  "editorError.foreground",
  "editorWarning.foreground",
  "editorInfo.foreground",
  "editorOverviewRuler.border",
  "input.background",
  "input.border",
  "focusBorder",
  "scrollbar.shadow",
  "scrollbarSlider.background",
  "scrollbarSlider.hoverBackground",
  "scrollbarSlider.activeBackground",
  "terminal.selectionBackground",
  "terminalCursor.foreground",
  "terminalCursor.background",
]);

/** Deprecated names some themes still use → the ones Monaco reads. */
const EDITOR_KEY_ALIASES: Record<string, string> = {
  "editorIndentGuide.background": "editorIndentGuide.background1",
  "editorIndentGuide.activeBackground": "editorIndentGuide.activeBackground1",
};

/** Workbench keys the role mapping reads. */
const MAPPED_KEYS: ReadonlySet<string> = new Set([
  "editor.background",
  "editorPane.background",
  "editorWidget.background",
  "dropdown.background",
  "focusBorder",
  "button.background",
  "button.foreground",
  "textLink.foreground",
  "activityBarBadge.background",
  "progressBar.background",
  "badge.background",
  "sideBar.background",
  "activityBar.background",
  "terminal.background",
  "panel.background",
  "input.background",
  "input.border",
  "editor.foreground",
  "foreground",
  "descriptionForeground",
  "disabledForeground",
  "menu.background",
  "quickInput.background",
  "panel.border",
  "editorGroup.border",
  "contrastBorder",
  "input.placeholderForeground",
  "editorError.foreground",
  "errorForeground",
  "editorWarning.foreground",
  "list.activeSelectionBackground",
  "list.hoverBackground",
  "list.inactiveSelectionBackground",
  "textCodeBlock.background",
  "sideBar.foreground",
  "sideBar.border",
  "terminal.foreground",
  "terminalCursor.foreground",
  "editorCursor.foreground",
  "terminal.selectionBackground",
  "editor.selectionBackground",
  "scrollbarSlider.background",
  "gitDecoration.addedResourceForeground",
  "editorInfo.foreground",
]);

// T3 Code's stock accent / input, the fallbacks when a theme has none that stand apart.
const STANDARD_INPUT: Record<ThemeAppearance, string> = { light: "#d4d4d8", dark: "#1e1e1e" };

/* ---- detection, JSONC, includes ---- */

/** A VS Code theme: dotted workbench keys (`editor.background`) or a tokenColors array. */
export function isVsCodeThemeFile(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value) || value.version === 1) return false;
  const workbench =
    isRecord(value.colors) && Object.keys(value.colors).some((key) => key.includes("."));
  return workbench || Array.isArray(value.tokenColors);
}

/** Parses JSON with comments and trailing commas; throws a readable error. */
export function parseJsoncText(text: string, what = "The file"): unknown {
  const errors: ParseError[] = [];
  const value: unknown = parseJsonc(text, errors, {
    allowTrailingComma: true,
    disallowComments: false,
  });
  if (errors.length > 0) {
    const first = errors[0]!;
    const before = text.slice(0, first.offset);
    const line = before.split("\n").length;
    const column = first.offset - before.lastIndexOf("\n");
    throw new Error(
      `${what} is not valid JSON: ${printParseErrorCode(first.error)} at line ${line}, column ${column}.`
    );
  }
  return value;
}

/** Follows `include` chains (child overrides parent) up to depth 8. */
function resolveIncludes(
  value: Record<string, unknown>,
  options: VsCodeImportOptions,
  warnings: string[],
  ancestors: string[] = []
): Record<string, unknown> {
  const include = value.include;
  if (typeof include !== "string") return value;
  if (!options.resolveInclude) {
    warnings.push(`Ignored include "${include}" (no way to read it).`);
    return value;
  }
  if (ancestors.includes(include)) throw new Error("Theme includes contain a cycle.");
  if (ancestors.length >= MAX_INCLUDE_DEPTH) throw new Error("Theme includes are nested too deeply.");
  const text = options.resolveInclude(include);
  if (text === undefined) {
    warnings.push(`Ignored include "${include}" (file not found).`);
    return value;
  }
  const parsed = parseJsoncText(text, `The included theme "${include}"`);
  if (!isRecord(parsed)) throw new Error(`The included theme "${include}" is not a JSON object.`);
  const parent = resolveIncludes(parsed, options, warnings, [...ancestors, include]);
  const child = { ...value };
  delete child.include;
  return {
    ...parent,
    ...child,
    colors: {
      ...(isRecord(parent.colors) ? parent.colors : {}),
      ...(isRecord(child.colors) ? child.colors : {}),
    },
    tokenColors: [
      ...tokenColorList(parent.tokenColors, options, warnings),
      ...tokenColorList(child.tokenColors, options, warnings),
    ],
  };
}

/** tokenColors is an array, or the path of a .tmTheme whose settings are the rules. */
function tokenColorList(
  value: unknown,
  options: VsCodeImportOptions,
  warnings: string[]
): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string") return [];
  const text = options.resolveInclude?.(value);
  if (text === undefined) {
    warnings.push(`Ignored tokenColors "${value}" (file not found).`);
    return [];
  }
  try {
    const plist: unknown = parsePlist(text);
    return isRecord(plist) && Array.isArray(plist.settings) ? plist.settings : [];
  } catch {
    warnings.push(`Ignored tokenColors "${value}" (not a .tmTheme file).`);
    return [];
  }
}

/* ---- names ---- */

/** Extension `name` fields are often package slugs; read them as words. */
export function humanizeThemeName(raw: string): string {
  const trimmed = raw.trim();
  if (/\s/.test(trimmed) || !/[-_.]/.test(trimmed)) return trimmed;
  return trimmed
    .split(/[-_.]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

export function resolveThemeName(
  candidates: unknown[],
  filename: string | undefined,
  fallback: string
): string {
  const stem = filename
    ?.split(/[\\/]/)
    .pop()
    ?.replace(/\.(json|jsonc|sublime-color-scheme|tmtheme|plist)$/i, "")
    .replace(/-color-theme$/i, "");
  const fromFile = stem ? humanizeThemeName(stem) : undefined;
  for (const candidate of [
    ...candidates,
    fromFile && fromFile.charAt(0).toUpperCase() + fromFile.slice(1),
  ]) {
    if (typeof candidate !== "string") continue;
    // A displayName of "---" humanizes to nothing and falls through.
    const humanized = humanizeThemeName(candidate);
    if (/[\p{L}\p{N}]/u.test(humanized)) return humanized.slice(0, 48).trim();
  }
  return fallback;
}

export function themeIdFor(name: string): string {
  const id = themeIdFromName(name);
  return RESERVED_THEME_IDS.has(id) ? `${id}-theme` : id;
}

/* ---- conversion ---- */

/** A parsed VS Code-shaped theme (Sublime and tmTheme are converted to this). */
export interface VsCodeThemeObject {
  name: string;
  type?: unknown;
  colors: Record<string, unknown>;
  tokenColors: unknown[];
}

const hexOf = (color: Rgb) => rgbToHex(color);
const rgb = (hex: string): Rgb => parseColor(hex) ?? { r: 0, g: 0, b: 0 };

function appearanceOf(type: unknown, uiTheme: string | undefined, canvas: Rgb): ThemeAppearance {
  // VS Code itself goes by the extension's uiTheme; a file's own `type` can
  // be stale (Tokyo Night Light says "dark").
  for (const value of [uiTheme, type]) {
    const kind = typeof value === "string" ? value.toLowerCase() : null;
    if (kind === "light" || kind === "vs" || kind === "hc-light") return "light";
    if (kind === "dark" || kind === "vs-dark" || kind === "hc-black") return "dark";
  }
  // Unlabelled themes follow the editor surface.
  return isDarkRgb(canvas) ? "dark" : "light";
}

/** Converts a VS Code-shaped theme object; `warnings` collects what was dropped. */
export function convertVsCodeTheme(
  theme: VsCodeThemeObject,
  options: Pick<VsCodeImportOptions, "uiTheme"> = {},
  warnings: string[] = []
): ThemeFile {
  const colors = theme.colors;
  /** First key that carries a usable colour, in priority order. */
  const pick = (...keys: string[]): Rgba | null => {
    for (const key of keys) {
      const parsed = parseColor(colors[key]);
      if (parsed) return parsed;
    }
    return null;
  };
  const solidOver = (base: Rgb, ...keys: string[]): string | null => {
    const parsed = pick(...keys);
    return parsed ? hexOf(flattenOver(parsed, base)) : null;
  };

  const canvasColor = pick("editor.background", "editorPane.background");
  if (!canvasColor) {
    throw new Error(
      'That theme has no "editor.background" colour, so there is nothing to build a palette from.'
    );
  }
  const appearance = appearanceOf(theme.type, options.uiTheme, canvasColor);
  const canvas = flattenOver(canvasColor, appearance === "dark" ? { r: 0, g: 0, b: 0 } : { r: 255, g: 255, b: 255 });
  const canvasHex = hexOf(canvas);
  const raisedCandidate = solidOver(canvas, "editorWidget.background", "dropdown.background");

  // Accent and control candidates must stand apart (1.1:1) from adjacent surfaces.
  const standsApart = (first: string, second: string) => contrastRgb(rgb(first), rgb(second)) >= 1.1;

  let accentColor: Rgba | null = null;
  let accentHex: string | null = null;
  for (const key of [
    "focusBorder",
    "button.background",
    "textLink.foreground",
    "activityBarBadge.background",
    "progressBar.background",
    "badge.background",
  ]) {
    const candidate = parseColor(colors[key]);
    if (!candidate) continue;
    const candidateHex = hexOf(flattenOver(candidate, canvas));
    if (
      !standsApart(candidateHex, canvasHex) ||
      (raisedCandidate !== null && !standsApart(candidateHex, raisedCandidate))
    ) {
      continue;
    }
    accentColor = candidate;
    accentHex = candidateHex;
    break;
  }
  if (!accentColor || !accentHex) {
    const standard = DEFAULT_SEEDS[appearance].accent;
    accentHex =
      [standard, "#ffffff", "#000000"].find(
        (candidate) =>
          standsApart(candidate, canvasHex) &&
          (raisedCandidate === null || standsApart(candidate, raisedCandidate))
      ) ?? standard;
    accentColor = { ...rgb(accentHex), a: 1 };
  }

  // The derived palette is the floor, derived from a muted accent: the
  // vivid engine carries the accent hue into every surface, which would
  // wash an imported neutral palette in its focus colour.
  const mutedAccentHex = hexOf(flattenOver({ ...accentColor, a: 0.2 }, canvas));
  const derived = createVividThemeColors(canvasHex, mutedAccentHex);
  const sidebarHex = solidOver(canvas, "sideBar.background", "activityBar.background") ?? derived.sidebar;
  const sidebar = rgb(sidebarHex);
  const terminalHex = solidOver(canvas, "terminal.background", "panel.background") ?? derived.terminalBackground;
  const terminal = rgb(terminalHex);

  /** Foregrounds only win when readable on the surface they land on. */
  const readableOn = (surface: string, fallback: string, ...keys: string[]): string => {
    const surfaceRgb = rgb(surface);
    const isReadable = (candidate: string) => contrastRgb(rgb(candidate), surfaceRgb) >= 4.5;
    const specified = solidOver(surfaceRgb, ...keys);
    if (specified && isReadable(specified)) return specified;
    if (isReadable(fallback)) return fallback;
    return isDarkRgb(surfaceRgb) ? "#ffffff" : "#000000";
  };

  const surfaceRaisedHex = raisedCandidate ?? derived.surfaceRaised;
  // JET's accent surface is the neutral hover / highlighted row: a list
  // colour only wins when it reads as a quiet surface. Nord's bright
  // #88c0d0 selection would light up every hovered row and swallow the
  // primary indicator on the active nav item.
  const accentSurfaceHex =
    ["list.activeSelectionBackground", "list.hoverBackground", "list.inactiveSelectionBackground"]
      .map((key) => solidOver(canvas, key))
      .find((candidate) => {
        if (!candidate) return false;
        const ratio = contrastRgb(rgb(candidate), canvas);
        return ratio >= ACCENT_SURFACE_CONTRAST.min && ratio <= ACCENT_SURFACE_CONTRAST.max;
      }) ?? derived.accentSurface;
  // The primary button maps to messageAction; resolve it before the input
  // role. It must be a vivid action colour (≥ 3:1 on the canvas, apart from
  // the selection surface): many themes give their buttons the selection
  // grey (Dracula: #44475a), so the theme's brand colours are tried next.
  const actionHex = pickActionColor(
    [
      ...ACTION_KEYS.map((key) => solidOver(canvas, key)),
      accentHex,
    ].filter((candidate) => candidate === null || standsApart(candidate, surfaceRaisedHex)),
    canvasHex,
    accentSurfaceHex
  );
  let inputHex =
    [derived.input, derived.surfaceRaised, STANDARD_INPUT[appearance], "#000000", "#ffffff", "#808080"].find(
      (candidate) => standsApart(candidate, canvasHex) && standsApart(candidate, actionHex)
    ) ?? "#808080";
  for (const key of ["input.background", "input.border"]) {
    const candidate = solidOver(canvas, key);
    if (candidate && standsApart(candidate, canvasHex) && standsApart(candidate, actionHex)) {
      inputHex = candidate;
      break;
    }
  }

  // JET's borders are hairlines on every panel, row and control: a border
  // key only wins when it reads like one (visible, yet quiet). Dracula's
  // purple panel.border would outline everything; Rosé Pine's transparent
  // ones would vanish.
  const borderHex =
    BORDER_KEYS.map((key) => solidOver(canvas, key)).find((candidate) => {
      if (!candidate) return false;
      const ratio = contrastRgb(rgb(candidate), canvas);
      return ratio >= BORDER_CONTRAST.min && ratio <= BORDER_CONTRAST.max;
    }) ?? derived.border;

  const overrides: Partial<Record<ThemeColorRole, string>> = {
    canvas: canvasHex,
    text: readableOn(canvasHex, derived.text, "editor.foreground", "foreground"),
    textMuted: readableOn(canvasHex, derived.textMuted, "descriptionForeground", "disabledForeground"),
    surface: solidOver(canvas, "editorWidget.background") ?? derived.surface,
    surfaceRaised: surfaceRaisedHex,
    surfaceOverlay:
      solidOver(canvas, "menu.background", "quickInput.background", "dropdown.background") ??
      derived.surfaceOverlay,
    border: borderHex,
    input: inputHex,
    placeholder: readableOn(surfaceRaisedHex, derived.placeholder, "input.placeholderForeground"),
    error: readableOn(canvasHex, derived.error, "editorError.foreground", "errorForeground"),
    warning: readableOn(canvasHex, derived.warning, "editorWarning.foreground"),
    accentSurface: accentSurfaceHex,
    codeBackground: solidOver(canvas, "textCodeBlock.background") ?? derived.codeBackground,
    sidebar: sidebarHex,
    sidebarForeground: readableOn(sidebarHex, derived.sidebarForeground, "sideBar.foreground"),
    sidebarBorder: solidOver(sidebar, "sideBar.border") ?? derived.sidebarBorder,
    sidebarRowHover: solidOver(sidebar, "list.hoverBackground") ?? derived.sidebarRowHover,
    sidebarRowActive:
      solidOver(sidebar, "list.inactiveSelectionBackground", "list.hoverBackground") ??
      derived.sidebarRowActive,
    sidebarRowSelected: solidOver(sidebar, "list.activeSelectionBackground") ?? derived.sidebarRowSelected,
    terminalBackground: terminalHex,
    terminalForeground: readableOn(terminalHex, derived.terminalForeground, "terminal.foreground"),
    terminalCursor:
      solidOver(terminal, "terminalCursor.foreground", "editorCursor.foreground") ?? derived.terminalCursor,
    terminalSelection:
      solidOver(terminal, "terminal.selectionBackground", "editor.selectionBackground") ??
      derived.terminalSelection,
    terminalScrollbar: solidOver(terminal, "scrollbarSlider.background") ?? derived.terminalScrollbar,
    accent: accentHex,
    focus: accentHex,
    messageAction: actionHex,
    messageActionForeground: readableOn(actionHex, derived.messageActionForeground, "button.foreground"),
    accentForeground: readableOn(accentHex, derived.accentForeground, "button.foreground"),
  };

  /* -- JET extensions -- */
  const jetPilot: JetPilotThemeExtensions = {};
  // Some themes use their foreground for git decorations (Gruvbox): only a
  // colour of the right hue counts as success / info.
  const withHue = (from: number, to: number, ...keys: string[]) => {
    for (const key of keys) {
      const color = solidOver(canvas, key);
      if (color && hasHue(color, from, to)) return color;
    }
    return undefined;
  };
  const success = withHue(55, 175, "gitDecoration.addedResourceForeground", "terminal.ansiGreen", "terminal.ansiBrightGreen");
  const info = withHue(176, 265, "editorInfo.foreground", "terminal.ansiBlue", "terminal.ansiBrightBlue");
  if (success || info) {
    jetPilot.colors = { ...(success ? { success } : {}), ...(info ? { info } : {}) };
  }

  const terminalColors: Partial<Record<AnsiColor, string>> = {};
  for (const color of ANSI_COLORS) {
    const value = solidOver(terminal, `terminal.ansi${color.charAt(0).toUpperCase()}${color.slice(1)}`);
    if (value) terminalColors[color] = value;
  }
  if (Object.keys(terminalColors).length > 0) jetPilot.terminal = terminalColors;

  const tokenRules = readTokenRules(theme.tokenColors, canvas);
  const editorForeground = solidOver(canvas, "editor.foreground") ?? undefined;
  const syntax = syntaxFromRules(tokenRules, editorForeground);
  if (Object.keys(syntax).length > 0) jetPilot.syntax = syntax;

  const editor: Record<string, string> = {};
  let ignored = 0;
  let invalid = 0;
  for (const [rawKey, value] of Object.entries(colors)) {
    const key = EDITOR_KEY_ALIASES[rawKey] ?? rawKey;
    const isAnsi = /^terminal\.ansi/.test(key);
    if (!EDITOR_KEYS.has(key)) {
      if (!MAPPED_KEYS.has(key) && !isAnsi) ignored += 1;
      continue;
    }
    if (value === null || value === undefined) continue;
    if (!parseColor(value)) {
      invalid += 1;
      continue;
    }
    if (key in editor && rawKey !== key) continue; // the current name wins over an alias
    editor[key] = toHexAlpha(value as string);
  }
  if (Object.keys(editor).length > 0) jetPilot.editor = editor;
  if (ignored > 0) warnings.push(`Ignored ${ignored} unsupported workbench colour key${ignored === 1 ? "" : "s"}.`);
  if (invalid > 0) warnings.push(`Ignored ${invalid} invalid colour value${invalid === 1 ? "" : "s"}.`);
  if (!jetPilot.syntax?.key && !jetPilot.syntax?.string) {
    warnings.push("No syntax colours found; the editor uses colours derived from the palette.");
  }

  const name = theme.name;
  return {
    version: 1,
    id: themeIdFor(name),
    name,
    appearance,
    colors: { ...derived, ...overrides },
    ...(Object.keys(jetPilot).length > 0 ? { jetPilot } : {}),
  };
}

/** Imports a parsed VS Code theme object (includes resolved through `options`). */
export function importVsCodeTheme(
  value: Record<string, unknown>,
  options: VsCodeImportOptions = {}
): { theme: ThemeFile; warnings: string[] } {
  const warnings: string[] = [];
  const resolved = resolveIncludes(value, options, warnings);
  const theme = convertVsCodeTheme(
    {
      name: resolveThemeName([options.label, resolved.displayName, resolved.name], options.filename, "VS Code theme"),
      type: resolved.type,
      colors: isRecord(resolved.colors) ? resolved.colors : {},
      tokenColors: tokenColorList(resolved.tokenColors, options, warnings),
    },
    options,
    warnings
  );
  return { theme, warnings };
}

/** Whether `hex` is a saturated colour with an HSL hue in [from, to]. */
function hasHue(hex: string, from: number, to: number): boolean {
  const { r: red, g: green, b: blue } = rgbOf(hex);
  const [r, g, b] = [red / 255, green / 255, blue / 255];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  const lightness = (max + min) / 2;
  const saturation = delta === 0 ? 0 : delta / (1 - Math.abs(2 * lightness - 1));
  if (saturation < 0.2 || delta < 0.08) return false;
  const hue =
    max === r ? 60 * (((g - b) / delta + 6) % 6) : max === g ? 60 * ((b - r) / delta + 2) : 60 * ((r - g) / delta + 4);
  return hue >= from && hue <= to;
}

/* ---- pairing ---- */

const variantOf = (file: ThemeFile): ThemeVariant => ({
  ...(file.canvas ? { canvas: file.canvas } : {}),
  ...(file.accent ? { accent: file.accent } : {}),
  ...(file.colors ? { colors: file.colors } : {}),
  ...(file.jetPilot ? { jetPilot: file.jetPilot } : {}),
});

/** One theme with `light` as the base and `dark` as its variant. */
export function mergeVariants(
  light: ThemeFile,
  dark: ThemeFile,
  name: string,
  id = themeIdFor(name)
): ThemeFile {
  return {
    version: 1,
    id,
    name,
    appearance: "light",
    ...variantOf(light),
    variants: { dark: variantOf(dark) },
    ...(light.collection ? { collection: light.collection } : {}),
  };
}

/**
 * Extensions ship families (GitHub: dark, light, dark-dimmed, ...). A light
 * and a dark theme whose names differ only by the appearance word become
 * one theme with a variant; everything else stays as it is.
 */
export function pairVariants(files: ThemeFile[]): ThemeFile[] {
  const stripAppearance = (label: string) =>
    label
      .replace(/\b(?:light|dark)\b/gi, " ")
      .replace(/\s+/g, " ")
      .trim();

  type Group = { light: ThemeFile[]; dark: ThemeFile[]; order: number };
  const groups = new Map<string, Group>();
  const entries: { file: ThemeFile; order: number }[] = [];
  files.forEach((file, order) => {
    // Only single-appearance themes with an appearance word whose remaining
    // name still identifies the pair ("Dark+" / "Light+" would pair as "+").
    const key = stripAppearance(file.name);
    if (themeAppearances(file).length !== 1 || key === file.name || !/[\p{L}\p{N}]/u.test(key)) {
      entries.push({ file, order });
      return;
    }
    const group = groups.get(key) ?? { light: [], dark: [], order };
    group[file.appearance].push(file);
    groups.set(key, group);
  });

  for (const [key, group] of groups) {
    // Ambiguity (two darks for one light) is not guessed at.
    const id = themeIdFor(key);
    if (group.light.length === 1 && group.dark.length === 1) {
      entries.push({ file: mergeVariants(group.light[0]!, group.dark[0]!, key, id), order: group.order });
      continue;
    }
    for (const file of [...group.light, ...group.dark]) entries.push({ file, order: group.order });
  }
  return entries.sort((a, b) => a.order - b.order).map((entry) => entry.file);
}

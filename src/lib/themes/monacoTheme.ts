/*
 * Monaco editor themes built from theme roles. The workbench colours mirror
 * the design tokens (canvas = --background, widgets = --surface-3, accent =
 * --primary); a theme's raw `jetPilot.editor` keys (VS Code names) are laid
 * on top. Syntax colours fill the seven slots of `rules()` — from
 * `jetPilot.syntax` (VS Code tokenColors / Sublime rules on import) or, when
 * missing, from the status / link hues so YAML reads like the rest of the
 * app (keys = link, strings = success, numbers = warning, constants = info).
 */
import { mix, parseColor, toHex, toHexAlpha, withAlpha } from "./contrast";
import { ensureContrast, type ThemeRoles } from "./derive";
import type {
  JetPilotThemeExtensions,
  MonacoThemeData,
  SyntaxSlot,
  ThemeAppearance,
} from "./types";

type ThemeRule = MonacoThemeData["rules"][number];
/** Syntax colours as Monaco wants them: hex without the leading "#". */
export type SyntaxPalette = Record<SyntaxSlot, string>;

export const rules = (palette: SyntaxPalette): ThemeRule[] => [
  { token: "", foreground: palette.text },
  { token: "type", foreground: palette.key },
  { token: "type.yaml", foreground: palette.key },
  { token: "key", foreground: palette.key },
  { token: "attribute.name", foreground: palette.key },
  { token: "string", foreground: palette.string },
  { token: "string.yaml", foreground: palette.string },
  { token: "string.value.json", foreground: palette.string },
  { token: "string.key.json", foreground: palette.key },
  { token: "number", foreground: palette.number },
  { token: "number.yaml", foreground: palette.number },
  { token: "keyword", foreground: palette.constant },
  { token: "constant", foreground: palette.constant },
  { token: "tag", foreground: palette.constant },
  { token: "comment", foreground: palette.comment, fontStyle: "italic" },
  { token: "operators", foreground: palette.punctuation },
  { token: "delimiter", foreground: palette.punctuation },
];

/** JET's syntax palettes (also the built-in JET theme's `jetPilot.syntax`). */
export const JET_SYNTAX: Record<ThemeAppearance, SyntaxPalette> = {
  dark: {
    key: "a5a8fb",
    string: "7fd8ad",
    number: "f3b65a",
    constant: "6cb0fb",
    comment: "6e6e78",
    punctuation: "8b8b94",
    text: "e4e4e8",
  },
  light: {
    key: "3f37c9",
    string: "117948",
    number: "aa5409",
    constant: "1160d0",
    comment: "8a8a93",
    punctuation: "71717a",
    text: "17171c",
  },
};

/** JET's editor colours (also the built-in JET theme's `jetPilot.editor`). */
export const JET_EDITOR_COLORS: Record<ThemeAppearance, Record<string, string>> = {
  dark: {
    "editor.background": "#101011",
    "editor.foreground": "#e4e4e8",
    "editorLineNumber.foreground": "#4a4a52",
    "editorLineNumber.activeForeground": "#a1a1aa",
    "editorCursor.foreground": "#a5a8fb",
    "editor.lineHighlightBackground": "#18181b",
    "editor.lineHighlightBorder": "#00000000",
    "editor.selectionBackground": "#615aed4d",
    "editor.inactiveSelectionBackground": "#615aed26",
    "editor.selectionHighlightBackground": "#615aed1f",
    "editor.wordHighlightBackground": "#615aed1f",
    "editor.findMatchBackground": "#f6ae3155",
    "editor.findMatchHighlightBackground": "#f6ae3126",
    "editorIndentGuide.background1": "#1f1f23",
    "editorIndentGuide.activeBackground1": "#34343a",
    "editorWhitespace.foreground": "#2a2a30",
    "editorBracketMatch.background": "#615aed26",
    "editorBracketMatch.border": "#615aed80",
    "editorGutter.background": "#101011",
    "editorWidget.background": "#1c1c1f",
    "editorWidget.border": "#2b2b30",
    "editorSuggestWidget.background": "#1c1c1f",
    "editorSuggestWidget.border": "#2b2b30",
    "editorSuggestWidget.selectedBackground": "#252528",
    "editorHoverWidget.background": "#1c1c1f",
    "editorHoverWidget.border": "#2b2b30",
    "input.background": "#151517",
    "input.border": "#2b2b30",
    focusBorder: "#7b75f2",
    "scrollbar.shadow": "#00000000",
    "scrollbarSlider.background": "#3a3a4066",
    "scrollbarSlider.hoverBackground": "#52525a88",
    "scrollbarSlider.activeBackground": "#615aed88",
    "editorOverviewRuler.border": "#00000000",
  },
  light: {
    "editor.background": "#ffffff",
    "editor.foreground": "#17171c",
    "editorLineNumber.foreground": "#b4b4bb",
    "editorLineNumber.activeForeground": "#52525b",
    "editorCursor.foreground": "#5048e5",
    "editor.lineHighlightBackground": "#f6f6f7",
    "editor.lineHighlightBorder": "#00000000",
    "editor.selectionBackground": "#5048e533",
    "editor.inactiveSelectionBackground": "#5048e51a",
    "editor.selectionHighlightBackground": "#5048e514",
    "editor.wordHighlightBackground": "#5048e514",
    "editor.findMatchBackground": "#f6ae3166",
    "editor.findMatchHighlightBackground": "#f6ae3133",
    "editorIndentGuide.background1": "#eeeef0",
    "editorIndentGuide.activeBackground1": "#d4d4d8",
    "editorWhitespace.foreground": "#e4e4e7",
    "editorBracketMatch.background": "#5048e51a",
    "editorBracketMatch.border": "#5048e566",
    "editorGutter.background": "#ffffff",
    "editorWidget.background": "#ffffff",
    "editorWidget.border": "#e4e4e7",
    "editorSuggestWidget.background": "#ffffff",
    "editorSuggestWidget.border": "#e4e4e7",
    "editorSuggestWidget.selectedBackground": "#efeff1",
    "editorHoverWidget.background": "#ffffff",
    "editorHoverWidget.border": "#e4e4e7",
    "input.background": "#ffffff",
    "input.border": "#dcdce0",
    focusBorder: "#5048e5",
    "scrollbar.shadow": "#00000000",
    "scrollbarSlider.background": "#c8c8cf66",
    "scrollbarSlider.hoverBackground": "#a1a1aa88",
    "scrollbarSlider.activeBackground": "#5048e566",
    "editorOverviewRuler.border": "#00000000",
  },
};

/** Editor keys that belong to the terminal (xtermTheme.ts), not Monaco. */
export const isTerminalKey = (key: string) => /^terminal(?:Cursor)?\./.test(key);

const bare = (color: string) => toHex(color).slice(1);

/** The syntax palette: `jetPilot.syntax` where set, otherwise from the roles. */
export function syntaxPalette(
  roles: ThemeRoles,
  syntax: JetPilotThemeExtensions["syntax"]
): SyntaxPalette {
  const readable = (color: string) => ensureContrast(color, roles.canvas, 4.5);
  const derived: SyntaxPalette = {
    key: bare(readable(roles.accent)),
    string: bare(roles.success),
    number: bare(readable(roles.warningForeground)),
    constant: bare(roles.info),
    comment: bare(mix(roles.textMuted, roles.canvas, 0.25)),
    punctuation: bare(roles.textMuted),
    text: bare(roles.text),
  };
  for (const slot of Object.keys(derived) as SyntaxSlot[]) {
    const value = syntax?.[slot];
    if (value && parseColor(value)) derived[slot] = bare(value);
  }
  return derived;
}

export function buildMonacoTheme(
  roles: ThemeRoles,
  appearance: ThemeAppearance,
  extensions: JetPilotThemeExtensions = {}
): MonacoThemeData {
  const dark = appearance === "dark";
  const accent = (light: number, darkAlpha: number) =>
    withAlpha(roles.accent, dark ? darkAlpha : light);
  const warning = (light: number, darkAlpha: number) =>
    withAlpha(roles.warning, dark ? darkAlpha : light);
  const lineTo = (amount: number) => mix(roles.canvas, roles.text, amount);

  const colors: Record<string, string> = {
    "editor.background": roles.canvas,
    "editor.foreground": roles.text,
    "editorLineNumber.foreground": mix(roles.textMuted, roles.canvas, 0.45),
    "editorLineNumber.activeForeground": roles.textMuted,
    "editorCursor.foreground": roles.terminalCursor,
    "editor.lineHighlightBackground": lineTo(dark ? 0.04 : 0.03),
    "editor.lineHighlightBorder": "#00000000",
    "editor.selectionBackground": accent(0.2, 0.3),
    "editor.inactiveSelectionBackground": accent(0.1, 0.15),
    "editor.selectionHighlightBackground": accent(0.08, 0.12),
    "editor.wordHighlightBackground": accent(0.08, 0.12),
    "editor.findMatchBackground": warning(0.4, 0.33),
    "editor.findMatchHighlightBackground": warning(0.2, 0.15),
    "editorIndentGuide.background1": lineTo(0.07),
    "editorIndentGuide.activeBackground1": lineTo(0.15),
    "editorWhitespace.foreground": lineTo(0.1),
    "editorBracketMatch.background": accent(0.1, 0.15),
    "editorBracketMatch.border": accent(0.4, 0.5),
    "editorGutter.background": roles.canvas,
    "editorWidget.background": roles.surfaceOverlay,
    "editorWidget.border": roles.border,
    "editorSuggestWidget.background": roles.surfaceOverlay,
    "editorSuggestWidget.border": roles.border,
    "editorSuggestWidget.selectedBackground": roles.accentSurface,
    "editorHoverWidget.background": roles.surfaceOverlay,
    "editorHoverWidget.border": roles.border,
    "input.background": roles.surface,
    "input.border": roles.input,
    focusBorder: roles.focus,
    "scrollbar.shadow": "#00000000",
    "scrollbarSlider.background": withAlpha(roles.terminalScrollbar, 0.4),
    "scrollbarSlider.hoverBackground": withAlpha(roles.terminalScrollbarHover, 0.53),
    "scrollbarSlider.activeBackground": accent(0.4, 0.53),
    "editorOverviewRuler.border": "#00000000",
  };
  for (const [key, value] of Object.entries(extensions.editor ?? {})) {
    if (isTerminalKey(key) || !parseColor(value)) continue;
    colors[key] = toHexAlpha(value);
  }

  return {
    base: dark ? "vs-dark" : "vs",
    inherit: true,
    rules: rules(syntaxPalette(roles, extensions.syntax)),
    colors,
  };
}

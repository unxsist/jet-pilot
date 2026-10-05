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
import { rules, type SyntaxPalette } from "./jetEditor";
import type { JetPilotThemeExtensions, MonacoThemeData, SyntaxSlot, ThemeAppearance } from "./types";

export { JET_EDITOR_COLORS, JET_SYNTAX, rules, type SyntaxPalette } from "./jetEditor";

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

/*
 * Import of TextMate themes (.tmTheme, an XML plist). The first `settings`
 * entry without a scope carries the globals (background, foreground, caret,
 * selection, lineHighlight, ...), the rest are scope rules. Both are mapped
 * onto a VS Code-shaped theme and converted like one, so the palette, the
 * contrast guards and the syntax slots behave the same for every format.
 * Sublime colour schemes (./sublime.ts) reuse `convertTextMateTheme`.
 */
import { parse as parsePlist } from "fast-plist";
import { parseColor, rgbToHex } from "../contrast";
import type { ThemeFile } from "../types";
import { isRecord } from "../validate";
import { matchSlot, readTokenRules } from "./scopes";
import { convertVsCodeTheme, resolveThemeName } from "./vscode";

/** Global setting → VS Code workbench key (camelCase tmTheme and snake_case Sublime names). */
const GLOBAL_KEYS: Record<string, string> = {
  background: "editor.background",
  foreground: "editor.foreground",
  caret: "editorCursor.foreground",
  selection: "editor.selectionBackground",
  lineHighlight: "editor.lineHighlightBackground",
  line_highlight: "editor.lineHighlightBackground",
  invisibles: "editorWhitespace.foreground",
  gutter: "editorGutter.background",
  gutterForeground: "editorLineNumber.foreground",
  gutter_foreground: "editorLineNumber.foreground",
  gutter_foreground_highlight: "editorLineNumber.activeForeground",
  findHighlight: "editor.findMatchBackground",
  find_highlight: "editor.findMatchBackground",
  accent: "focusBorder",
};

/** Targets whose colour makes a good accent when the theme names none. */
const ACCENT_TARGETS = ["keyword", "storage", "entity.name.function", "entity.name.tag"];

/**
 * Converts TextMate-style globals + scope rules ({ scope, settings: { foreground } }).
 * Colours must already be plain CSS colours (Sublime variables resolved).
 */
export function convertTextMateTheme(
  name: string,
  globals: Record<string, string>,
  rules: unknown[],
  warnings: string[]
): ThemeFile {
  const colors: Record<string, string> = {};
  let ignored = 0;
  for (const [key, value] of Object.entries(globals)) {
    const target = GLOBAL_KEYS[key];
    if (!target) {
      ignored += 1;
      continue;
    }
    if (parseColor(value)) colors[target] = value;
  }
  if (ignored > 0) warnings.push(`Ignored ${ignored} unsupported global setting${ignored === 1 ? "" : "s"}.`);
  if (!colors["editor.background"]) {
    throw new Error('That theme has no global "background" colour, so there is nothing to build a palette from.');
  }

  // No accent in the theme: borrow the keyword colour (caret as a last resort).
  if (!colors.focusBorder) {
    const canvas = parseColor(colors["editor.background"])!;
    const accent =
      matchSlot(readTokenRules(rules, canvas).rules, ACCENT_TARGETS) ?? colors["editorCursor.foreground"];
    if (accent) colors.focusBorder = accent;
  }
  // The caret colours the terminal cursor too.
  if (colors["editorCursor.foreground"]) colors["terminalCursor.foreground"] = colors["editorCursor.foreground"];

  return convertVsCodeTheme({ name, colors, tokenColors: rules }, {}, warnings);
}

/** Imports a .tmTheme document. */
export function importTmTheme(text: string, filename?: string): { theme: ThemeFile; warnings: string[] } {
  let plist: unknown;
  try {
    plist = parsePlist(text);
  } catch (error) {
    throw new Error(`That .tmTheme file is not a valid plist: ${error instanceof Error ? error.message : error}`);
  }
  if (!isRecord(plist) || !Array.isArray(plist.settings)) {
    throw new Error('That .tmTheme file has no "settings" array.');
  }
  const [first, ...rest] = plist.settings as unknown[];
  const hasGlobals = isRecord(first) && first.scope === undefined && isRecord(first.settings);
  const globals: Record<string, string> = {};
  if (hasGlobals) {
    for (const [key, value] of Object.entries(first.settings as Record<string, unknown>)) {
      if (typeof value === "string") globals[key] = value;
    }
  }
  const warnings: string[] = [];
  const name = resolveThemeName([plist.name], filename, "TextMate theme");
  const theme = convertTextMateTheme(name, globals, hasGlobals ? rest : plist.settings, warnings);
  return { theme, warnings };
}

/** "#rrggbb" / "#rrggbbaa" of a colour (keeps the alpha for later compositing). */
export const hexWithAlpha = (color: { r: number; g: number; b: number; a: number }) =>
  color.a >= 1
    ? rgbToHex(color)
    : `${rgbToHex(color)}${Math.round(color.a * 255)
        .toString(16)
        .padStart(2, "0")}`;

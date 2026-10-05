/*
 * importTheme: one entry point for every theme format. The format is
 * sniffed from the content (the file name only breaks ties):
 *   plist XML                      → TextMate (.tmTheme)
 *   `globals` / `rules`            → Sublime (.sublime-color-scheme)
 *   dotted `colors` / tokenColors  → VS Code (unless version: 1)
 *   anything else                  → JSON theme file (JET Pilot / portable)
 * Errors never throw: they come back as { ok: false, error } with a
 * message fit for the UI.
 */
import type { ImportResult } from "../types";
import { isRecord } from "../validate";
import { importSublimeColorScheme, isSublimeColorScheme } from "./sublime";
import { importThemeFile } from "./themeFile";
import { importTmTheme } from "./tmtheme";
import { importVsCodeTheme, isVsCodeThemeFile, parseJsoncText } from "./vscode";

export interface ImportOptions {
  /** Reads a VS Code `include` (relative path as written in the file). */
  resolveInclude?: (path: string) => string | undefined;
  /** Open VSX contributes.themes[].uiTheme ("vs", "vs-dark", "hc-black", "hc-light"). */
  uiTheme?: string;
  /** Open VSX contributes.themes[].label (preferred over the file's own name). */
  label?: string;
}

/** Larger files are not themes (Open VSX caps theme files at 512 KB too). */
const MAX_THEME_TEXT = 512 * 1024;

const looksLikePlist = (text: string, filename?: string) =>
  /^(?:<\?xml|<!DOCTYPE plist|<plist)/i.test(text) || /\.(tmtheme|plist)$/i.test(filename ?? "");

export function importTheme(text: string, filename?: string, opts: ImportOptions = {}): ImportResult {
  try {
    const source = text.replace(/^﻿/, "").trim();
    if (!source) return { ok: false, error: "The file is empty." };
    if (source.length > MAX_THEME_TEXT) return { ok: false, error: "The file is too large for a theme (512 KB max)." };

    if (looksLikePlist(source, filename)) {
      const { theme, warnings } = importTmTheme(source, filename);
      return { ok: true, format: "tmtheme", themes: [theme], warnings };
    }

    const value = parseJsoncText(source);
    if (!isRecord(value)) return { ok: false, error: "Theme files must contain a JSON object." };

    if (isSublimeColorScheme(value) && !isVsCodeThemeFile(value)) {
      const { theme, warnings } = importSublimeColorScheme(value, filename);
      return { ok: true, format: "sublime", themes: [theme], warnings };
    }
    if (isVsCodeThemeFile(value)) {
      const { theme, warnings } = importVsCodeTheme(value, { ...opts, filename });
      return { ok: true, format: "vscode", themes: [theme], warnings };
    }
    const { theme, format } = importThemeFile(value);
    return { ok: true, format, themes: [theme], warnings: [] };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

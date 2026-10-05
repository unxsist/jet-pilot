/*
 * Theme engine: T3 Code-compatible theme files, importers (VS Code,
 * Sublime, TextMate, T3), derivation and resolution to CSS tokens, Monaco
 * and xterm themes. Pure TypeScript (no DOM / Vue / Monaco imports).
 */
export * from "./types";
export { contrastRatio, toHex, toHslTriplet } from "./contrast";
export { parseThemeFile, themeIdFromName, RESERVED_THEME_IDS } from "./validate";
export { resolveTheme, themeAppearances } from "./resolve";
export { serializeTheme } from "./serialize";
export { THEME_JSON_SCHEMA, THEME_SCHEMA_URI } from "./schema";
export { importTheme, type ImportOptions } from "./import";
export { pairVariants } from "./import/vscode";
export { BUILTIN_THEMES, DEFAULT_THEME_ID, type BuiltinTheme } from "./builtin";

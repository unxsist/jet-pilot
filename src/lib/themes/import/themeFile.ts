/*
 * Import of JSON theme files (the portable format, with or without a
 * `jetPilot` block): both go through parseThemeFile. A file with a
 * `jetPilot` block (top level or in a variant) is reported as "jet",
 * any other as "portable".
 */
import type { ImportFormat, ThemeFile } from "../types";
import { parseThemeFile } from "../validate";

export function importThemeFile(value: unknown): { theme: ThemeFile; format: ImportFormat } {
  const theme = parseThemeFile(value);
  const jet =
    theme.jetPilot !== undefined ||
    Object.values(theme.variants ?? {}).some((variant) => variant?.jetPilot !== undefined);
  return { theme, format: jet ? "jet" : "portable" };
}

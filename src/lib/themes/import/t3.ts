/*
 * Import of T3 Code and JET Pilot theme files: both go through
 * parseThemeFile (T3's rules, plus the jetPilot block). A file with a
 * `jetPilot` block (top level or in a variant) is reported as "jet".
 */
import type { ImportFormat, ThemeFile } from "../types";
import { parseThemeFile } from "../validate";

export function importThemeFile(value: unknown): { theme: ThemeFile; format: ImportFormat } {
  const theme = parseThemeFile(value);
  const jet =
    theme.jetPilot !== undefined ||
    Object.values(theme.variants ?? {}).some((variant) => variant?.jetPilot !== undefined);
  return { theme, format: jet ? "jet" : "t3" };
}

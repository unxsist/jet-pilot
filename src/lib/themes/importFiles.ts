/*
 * Many theme texts → one import report for the settings UI (dropped or
 * picked files, pasted JSON, an Open VSX extension). The importers load
 * lazily: this module itself is light.
 */
import { formatLabel, originLabel } from "./library";
import type { ImportFormat, ThemeFile, ThemeOrigin } from "./types";

export interface ImportSource {
  /** File name (or a label like "Pasted JSON"). */
  name: string;
  text: string;
  /** Open VSX contributes.themes[].uiTheme. */
  uiTheme?: string;
  /** Open VSX contributes.themes[].label. */
  label?: string;
}

export interface ImportedTheme {
  /** Unique within the report (checkbox state). */
  key: string;
  file: ThemeFile;
  /** Where it came from: file name(s) and format. */
  source: string;
  format: ImportFormat;
}

export interface ImportReport {
  themes: ImportedTheme[];
  warnings: string[];
  errors: { source: string; message: string }[];
}

/**
 * Imports theme texts of any supported format. VS Code light / dark files
 * imported together are paired into one theme with a variant. Themes
 * without an origin get `origin` when given (Open VSX), else their
 * format's (`VS Code`, `Sublime Text`...).
 */
export async function importSources(
  sources: ImportSource[],
  origin?: ThemeOrigin
): Promise<ImportReport> {
  const [{ importTheme }, { pairVariants }] = await Promise.all([
    import("./import/index"),
    import("./import/vscode"),
  ]);
  const report: ImportReport = { themes: [], warnings: [], errors: [] };
  const vscode = new Map<ThemeFile, string>();
  const others: Omit<ImportedTheme, "key">[] = [];
  for (const source of sources) {
    const result = importTheme(source.text, source.name, { uiTheme: source.uiTheme, label: source.label });
    if (!result.ok) {
      report.errors.push({ source: source.name, message: result.error });
      continue;
    }
    for (const warning of result.warnings) report.warnings.push(`${source.name}: ${warning}`);
    for (const file of result.themes) {
      if (result.format === "vscode") vscode.set(file, source.name);
      else others.push({ file, source: `${source.name} · ${formatLabel(result.format)}`, format: result.format });
    }
  }

  const files = [...vscode.keys()];
  const paired = files.length > 1 ? pairVariants(files) : files;
  // A merged pair names the files of both halves ("GitHub Light" + "GitHub Dark" → "GitHub").
  const sourceOf = (file: ThemeFile) =>
    vscode.get(file) ??
    (files
      .filter((half) => half.name.includes(file.name))
      .map((half) => vscode.get(half)!)
      .join(" + ") ||
      "VS Code files");

  report.themes = [
    ...paired.map((file) => ({ file, source: `${sourceOf(file)} · VS Code`, format: "vscode" as const })),
    ...others,
  ].map((theme, index) => {
    const label = originLabel(theme.format);
    const fileOrigin = theme.file.origin ?? origin ?? (label ? { label } : undefined);
    const file = fileOrigin ? { ...theme.file, origin: fileOrigin } : theme.file;
    return { ...theme, file, key: `${index}:${file.id ?? file.name}` };
  });
  return report;
}

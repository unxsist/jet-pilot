/*
 * Shared pieces of the theme settings UI. Everything heavy (the importers,
 * serialisation, culori) is imported lazily from its own module, so none
 * of it lands in the startup bundle.
 */
import { computed } from "vue";
import { usePreferredDark } from "@vueuse/core";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { readTextFile, stat, writeTextFile } from "@tauri-apps/plugin-fs";
import { injectStrict } from "@/lib/utils";
import { SettingsContextStateKey } from "@/providers/SettingsContextProvider";
import { wantedAppearance } from "@/lib/themes/scheme";
import { MAX_IMPORT_BYTES, classifyThemeFile, fileNameOf } from "@/lib/themes/library";
import type { ImportSource } from "@/lib/themes/importFiles";
import type { ThemeAppearance, ThemeEntry, ThemeFile } from "@/lib/themes/types";

/** The appearance the colour scheme asks for (not the one a preview paints). */
export function useWantedAppearance() {
  const { settings } = injectStrict(SettingsContextStateKey);
  const systemDark = usePreferredDark();
  return computed<ThemeAppearance>(() =>
    wantedAppearance(settings.value.appearance.colorScheme, systemDark.value)
  );
}

/** Token triplets as inline custom properties (scoped previews). */
export function varsStyle(vars: Readonly<Record<string, string>> | null | undefined) {
  if (!vars) return undefined;
  const style: Record<string, string> = {};
  for (const [token, value] of Object.entries(vars)) style[`--${token}`] = value;
  return style;
}

const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

/**
 * Runs tasks one at a time with a frame between them, so resolving a grid
 * of theme previews never blocks the page: cards fill in progressively.
 */
export function createTaskQueue() {
  let chain: Promise<unknown> = Promise.resolve();
  return <T>(task: () => Promise<T> | T): Promise<T> => {
    const run = chain.then(nextFrame).then(task);
    chain = run.catch(() => undefined);
    return run;
  };
}

export const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));

/* ------------------------------------------------------------ import -- */

export {
  importSources,
  type ImportedTheme,
  type ImportReport,
  type ImportSource,
} from "@/lib/themes/importFiles";

/**
 * Reads files picked in a dialog or dropped on the window (both are in the
 * fs scope: the dialog and the fs plugin add them). Unsupported or too
 * large files come back as errors.
 */
export async function readThemePaths(
  paths: string[]
): Promise<{ sources: ImportSource[]; errors: { source: string; message: string }[] }> {
  const sources: ImportSource[] = [];
  const errors: { source: string; message: string }[] = [];
  for (const path of paths) {
    const name = fileNameOf(path);
    if (!classifyThemeFile(name)) {
      errors.push({
        source: name,
        message: "Not a theme file (.json, .jsonc, .sublime-color-scheme or .tmTheme).",
      });
      continue;
    }
    try {
      const info = await stat(path).catch(() => null);
      if (info?.isDirectory) throw new Error("Folders can't be imported: drop the theme files.");
      if (info && info.size > MAX_IMPORT_BYTES) throw new Error("The file is larger than 512 KB.");
      sources.push({ name, text: await readTextFile(path) });
    } catch (e) {
      errors.push({ source: name, message: `The file could not be read: ${errorMessage(e)}` });
    }
  }
  return { sources, errors };
}

/** Browser File objects (HTML5 drop): same rules as readThemePaths. */
export async function readThemeBlobs(
  files: File[]
): Promise<{ sources: ImportSource[]; errors: { source: string; message: string }[] }> {
  const sources: ImportSource[] = [];
  const errors: { source: string; message: string }[] = [];
  for (const file of files) {
    if (!classifyThemeFile(file.name)) {
      errors.push({
        source: file.name,
        message: "Not a theme file (.json, .jsonc, .sublime-color-scheme or .tmTheme).",
      });
    } else if (file.size > MAX_IMPORT_BYTES) {
      errors.push({ source: file.name, message: "The file is larger than 512 KB." });
    } else {
      sources.push({ name: file.name, text: await file.text() });
    }
  }
  return { sources, errors };
}

/* ------------------------------------------------------------ export -- */

/**
 * Saves a theme file where the user picks. `forT3` writes what T3 Code's
 * importer accepts (every role resolved, no jetPilot block). Returns the
 * path, or null when cancelled.
 */
export async function exportThemeFile(
  file: ThemeFile,
  entry: Pick<ThemeEntry, "id">,
  forT3: boolean
): Promise<string | null> {
  const { serializeTheme } = await import("@/lib/themes/serialize");
  const text = serializeTheme(file, { forT3 });
  const path = await saveDialog({
    title: forT3 ? "Export theme for T3 Code" : "Export theme",
    defaultPath: `${entry.id.replace(/~.*$/, "")}${forT3 ? ".t3" : ""}.json`,
    filters: [{ name: forT3 ? "T3 Code theme" : "JET Pilot theme", extensions: ["json"] }],
  });
  if (!path) return null;
  await writeTextFile(path, text);
  return path;
}

/*
 * The lazy half of ThemeProvider: everything beyond painting JET. Loaded
 * once the app is idle, or right away when a theme other than JET is
 * saved, previewed or asked for. Brings the built-in theme list, the
 * themes folder (read, watch, write), resolution (culori) and the
 * first-paint cache with it, so none of that is in the startup bundle.
 */
import { effectScope, shallowRef, watch, type Ref, type ShallowRef } from "vue";
import {
  BaseDirectory,
  exists,
  mkdir,
  readDir,
  readTextFile,
  remove as removeFile,
  stat,
  watch as watchFs,
  writeTextFile,
} from "@tauri-apps/plugin-fs";
import { appConfigDir, join } from "@tauri-apps/api/path";
import { error as logError, warn } from "@/lib/logger";
import { BUILTIN_THEMES, DEFAULT_THEME_ID } from "@/lib/themes/builtin";
import { resolveTheme } from "@/lib/themes/resolve";
import { serializeTheme } from "@/lib/themes/serialize";
import { parseThemeFile } from "@/lib/themes/validate";
import {
  MAX_THEME_FILE_BYTES,
  MAX_THEME_FILES,
  OPEN_VSX_LABEL,
  RESERVED_THEME_IDS,
  THEME_CACHE_KEY,
  THEMES_DIR,
  bootCacheEntry,
  canonicalThemeId,
  isBuiltinThemeId,
  paintedAppearance,
  pickTheme,
  planThemeSave,
  themeAppearances,
  themeIdFromName,
  uniqueThemeId,
  userFileId,
  type BootCache,
  type ThemeChoice,
} from "@/lib/themes/runtime";
import type {
  ResolvedTheme,
  ThemeAppearance,
  ThemeContext,
  ThemeEntry,
  ThemeFile,
  ThemeOrigin,
  ThemeSettings,
  ThemeSource,
} from "@/lib/themes/types";

/** What ThemeProvider shares with its lazy half. */
export interface ThemeRuntimeHost {
  appearanceSettings: () => ThemeSettings;
  wanted: Readonly<Ref<ThemeAppearance>>;
  themes: ShallowRef<ThemeEntry[]>;
  active: ShallowRef<ResolvedTheme | null>;
  activeId: Ref<string>;
  previewing: Ref<boolean>;
  /** Paints the class for `appearance` and the token variables (null: JET's stylesheet). */
  paint(appearance: ThemeAppearance, vars: Record<string, string> | null, id: string | null): void;
}

export type ThemeRuntime = Pick<
  ThemeContext,
  "resolve" | "preview" | "install" | "save" | "remove" | "loadFile" | "folder" | "reload"
> & {
  /** Paints the preview or the saved choice (the latest call wins). */
  sync(): Promise<void>;
  /** The active theme once painted. */
  resolved(): Promise<ResolvedTheme>;
  dispose(): void;
};

/** Id painted for draft previews (the JSON editor). */
const DRAFT_ID = "preview";
const baseDir = BaseDirectory.AppConfig;
const themePath = (fileName: string) => `${THEMES_DIR}/${fileName}`;
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** A file of the themes folder; unchanged files keep their entry (and resolutions). */
interface UserFile {
  fileName: string;
  text: string | null;
  entry: ThemeEntry;
}

export function createThemeRuntime(host: ThemeRuntimeHost): ThemeRuntime {
  const settings = host.appearanceSettings;
  // Owns the runtime's watchers (it is created outside any component).
  const scope = effectScope(true);

  /* ---------------------------------------------------------- themes -- */

  const builtinEntries: ThemeEntry[] = BUILTIN_THEMES.map((theme) => ({
    id: theme.id,
    name: theme.name,
    source: "builtin",
    appearances: theme.appearances,
    ...(theme.origin ? { origin: theme.origin } : {}),
  }));
  const builtinIds = new Set(builtinEntries.map((entry) => entry.id));

  const userFiles = shallowRef<UserFile[]>([]);
  let userLoaded = false;
  const userFile = (id: string) => userFiles.value.find((file) => file.entry.id === id);
  const publish = () => {
    host.themes.value = [
      ...builtinEntries,
      ...userFiles.value
        .map((file) => file.entry)
        .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)),
    ];
  };
  publish();

  let folderReady: Promise<void> | null = null;
  const ensureFolder = () => {
    if (!folderReady) {
      folderReady = exists(THEMES_DIR, { baseDir }).then(async (found) => {
        if (!found) await mkdir(THEMES_DIR, { baseDir, recursive: true });
      });
      folderReady.catch(() => (folderReady = null));
    }
    return folderReady;
  };
  let folderPath: Promise<string> | null = null;
  const folder = async () => {
    await ensureFolder();
    if (!folderPath) {
      folderPath = appConfigDir().then((dir) => join(dir, THEMES_DIR));
      folderPath.catch(() => (folderPath = null));
    }
    return folderPath;
  };

  const readUserFile = async (
    fileName: string,
    id: string,
    path: string,
    previous: UserFile | undefined,
    conflict: string | null
  ): Promise<UserFile> => {
    const broken = (error: string, text: string | null = null): UserFile =>
      previous?.entry.error === error && previous.text === text && previous.entry.path === path
        ? previous
        : {
            fileName,
            text,
            entry: {
              id,
              name: fileName.replace(/\.json$/i, ""),
              source: "user",
              appearances: [],
              path,
              error,
            },
          };
    if (conflict) return broken(conflict);
    let text: string;
    try {
      const info = await stat(themePath(fileName), { baseDir });
      if (info.size > MAX_THEME_FILE_BYTES) return broken("The file is larger than 256 KB.");
      text = await readTextFile(themePath(fileName), { baseDir });
    } catch (e) {
      return broken(`The file could not be read: ${message(e)}`);
    }
    if (previous && previous.text === text && previous.entry.path === path) return previous;
    let file: ThemeFile;
    try {
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch (e) {
        throw new Error(`The file is not valid JSON: ${message(e)}`);
      }
      file = { ...parseThemeFile(json), id };
    } catch (e) {
      return broken(message(e), text);
    }
    return {
      fileName,
      text,
      entry: {
        id,
        name: file.name,
        source: file.origin?.label === OPEN_VSX_LABEL ? "openvsx" : "user",
        appearances: themeAppearances(file),
        file,
        ...(file.origin ? { origin: file.origin } : {}),
        path,
      },
    };
  };

  /** Reads the themes folder (64 files, 256 KB each; symlinks are skipped). */
  const readUserThemes = async () => {
    const dir = await folder();
    const names = (await readDir(THEMES_DIR, { baseDir }))
      .filter((item) => item.isFile && !item.isSymlink && /\.json$/i.test(item.name))
      .map((item) => item.name)
      .sort((a, b) => a.localeCompare(b));
    if (names.length > MAX_THEME_FILES) {
      warn(`Only the first ${MAX_THEME_FILES} of ${names.length} theme files are loaded.`);
    }
    const previous = new Map(userFiles.value.map((file) => [file.fileName, file]));
    const seen = new Set<string>();
    const next: UserFile[] = [];
    for (const fileName of names.slice(0, MAX_THEME_FILES)) {
      // "My Theme.json" and "my-theme.json" both claim "my-theme", "dracula.json"
      // a built-in's id, "light.json" a reserved one: listed as broken.
      const { id, conflict } = userFileId(
        fileName,
        (candidate) => isBuiltinThemeId(builtinIds, candidate),
        (candidate) => seen.has(candidate)
      );
      const path = await join(dir, fileName);
      next.push(await readUserFile(fileName, id, path, previous.get(fileName), conflict));
      if (!conflict) seen.add(id);
    }
    const changed =
      next.length !== userFiles.value.length ||
      next.some((file, index) => file !== userFiles.value[index]);
    if (changed) {
      userFiles.value = next;
      publish();
    }
  };

  /* One read at a time; a reload asked for meanwhile reads again afterwards. */
  let reading: Promise<void> | null = null;
  let queued: Promise<void> | null = null;
  const reload = (): Promise<void> => {
    if (queued) return queued;
    if (reading) {
      queued = reading.then(() => {
        queued = null;
        return reload();
      });
      return queued;
    }
    reading = readUserThemes()
      .catch((e) => logError(`Failed to read the themes folder: ${message(e)}`))
      .finally(() => {
        reading = null;
        if (!userLoaded) {
          userLoaded = true;
          void sync();
        }
      });
    return reading;
  };

  /* Hot reload: the folder is watched (150 ms debounce) once read. */
  let disposed = false;
  let unwatch: (() => void) | null = null;
  const firstRead = reload().then(async () => {
    try {
      const stop = await watchFs(THEMES_DIR, () => void reload(), { baseDir, delayMs: 150 });
      if (disposed) stop();
      else unwatch = stop;
    } catch (e) {
      warn(`Theme files are not watched for changes: ${message(e)}`);
    }
  });
  const loaded = () => (userLoaded ? Promise.resolve() : reading ?? firstRead);

  /* ------------------------------------------------------ resolution -- */

  const builtinFiles = new Map<string, Promise<ThemeFile>>();
  const loadFile = async (id: string): Promise<ThemeFile> => {
    const builtin = BUILTIN_THEMES.find((theme) => theme.id === id);
    if (builtin) {
      let file = builtinFiles.get(id);
      if (!file) {
        file = builtin.load();
        builtinFiles.set(id, file);
        file.catch(() => builtinFiles.delete(id));
      }
      return file;
    }
    await loaded();
    const entry = userFile(id)?.entry;
    if (!entry) throw new Error(`The theme "${id}" doesn't exist.`);
    if (!entry.file) throw new Error(entry.error ?? `The theme "${id}" can't be loaded.`);
    return entry.file;
  };

  const resolutions = new WeakMap<ThemeFile, Partial<Record<ThemeAppearance, ResolvedTheme>>>();
  const resolve = async (
    theme: string | ThemeFile,
    appearance: ThemeAppearance
  ): Promise<ResolvedTheme> => {
    const file = typeof theme === "string" ? await loadFile(theme) : theme;
    const cached = resolutions.get(file) ?? {};
    if (!cached[appearance]) {
      cached[appearance] = resolveTheme(file, appearance);
      resolutions.set(file, cached);
    }
    return cached[appearance]!;
  };

  /* -------------------------------------------------------- painting -- */

  /** Appearances of a known theme: undefined when unknown, null when broken. */
  const lookup = (id: string) => {
    const entry = host.themes.value.find((theme) => theme.id === id);
    if (!entry) return undefined;
    return entry.error ? null : entry.appearances;
  };

  /** The saved choice for `appearance`; null while its user theme is still being read. */
  const savedChoice = (appearance: ThemeAppearance): ThemeChoice | null => {
    const saved = settings();
    const id = canonicalThemeId(appearance === "light" ? saved.lightTheme : saved.darkTheme);
    if (!userLoaded && !builtinIds.has(id)) return null;
    return pickTheme(saved, appearance, lookup, DEFAULT_THEME_ID);
  };

  let draft: { theme: string | ThemeFile; appearance?: ThemeAppearance } | null = null;
  let generation = 0;

  const sync = async (): Promise<void> => {
    const current = ++generation;
    const stale = () => current !== generation || disposed;
    const preview = draft;
    host.previewing.value = preview !== null;
    try {
      let id: string;
      let theme: string | ThemeFile;
      let appearance: ThemeAppearance;
      if (preview && typeof preview.theme !== "string") {
        id = DRAFT_ID;
        theme = preview.theme;
        appearance = paintedAppearance(
          themeAppearances(preview.theme),
          preview.appearance ?? host.wanted.value
        );
      } else if (preview && typeof preview.theme === "string") {
        if (!builtinIds.has(preview.theme)) await loaded();
        if (stale()) return;
        const appearances = lookup(preview.theme);
        if (!appearances) throw new Error(`The theme "${preview.theme}" can't be previewed.`);
        id = theme = preview.theme;
        appearance = paintedAppearance(appearances, preview.appearance ?? host.wanted.value);
      } else {
        const choice = savedChoice(host.wanted.value);
        // Keep what boot.js painted until the folder is read (then sync again).
        if (!choice) return;
        id = theme = choice.id;
        appearance = choice.appearance;
      }

      const resolved = await resolve(theme, appearance);
      if (stale()) return;
      // JET is painted by main.postcss: no inline variables.
      host.paint(resolved.appearance, id === DEFAULT_THEME_ID ? null : resolved.vars, id === DEFAULT_THEME_ID ? null : id);
      host.activeId.value = id;
      host.active.value = resolved;
      if (!preview) void writeBootCache();
    } catch (e) {
      if (stale()) return;
      logError(`Failed to apply the theme: ${message(e)}`);
      if (draft) {
        // A broken preview: back to the saved theme.
        draft = null;
        void sync();
      } else {
        // JET paints, and Monaco / xterm follow it.
        host.paint(host.wanted.value, null, null);
        host.activeId.value = DEFAULT_THEME_ID;
        try {
          const jet = await resolve(DEFAULT_THEME_ID, host.wanted.value);
          if (!stale()) host.active.value = jet;
        } catch {
          if (!stale()) host.active.value = null;
        }
      }
    }
  };

  /** Caches both appearances for public/boot.js. */
  const writeBootCache = async () => {
    const cache: BootCache = { v: 1 };
    for (const appearance of ["light", "dark"] as const) {
      const choice = savedChoice(appearance);
      if (!choice) return;
      if (choice.id === DEFAULT_THEME_ID) {
        cache[appearance] = bootCacheEntry(choice, null);
        continue;
      }
      try {
        const resolved = await resolve(choice.id, appearance);
        cache[appearance] = bootCacheEntry(
          { id: choice.id, appearance: resolved.appearance },
          resolved.vars
        );
      } catch {
        return;
      }
    }
    try {
      const text = JSON.stringify(cache);
      if (localStorage.getItem(THEME_CACHE_KEY) !== text) localStorage.setItem(THEME_CACHE_KEY, text);
    } catch {
      /* storage unavailable: start-up paints JET first */
    }
  };

  // A changed or removed theme file repaints (hot reload).
  scope.run(() => watch(host.themes, () => void sync()));

  /* ------------------------------------------------------------- API -- */

  const resolved = async (): Promise<ResolvedTheme> => {
    await loaded();
    if (!host.active.value) await sync();
    // Still nothing (the saved theme can't be loaded): JET.
    return host.active.value ?? resolve(DEFAULT_THEME_ID, host.wanted.value);
  };

  const preview = async (theme: string | ThemeFile | null, appearance?: ThemeAppearance) => {
    draft = theme === null ? null : { theme, appearance };
    await sync();
  };

  const isTaken = (id: string) =>
    RESERVED_THEME_IDS.has(id) || isBuiltinThemeId(builtinIds, id) || !!userFile(id);

  const writeTheme = async (fileName: string, file: ThemeFile) => {
    await ensureFolder();
    await writeTextFile(themePath(fileName), serializeTheme(file), { baseDir }).catch((e) => {
      folderReady = null; // the folder may have been deleted meanwhile
      throw e;
    });
  };

  const readBack = (id: string) => {
    const entry = userFile(id)?.entry;
    if (!entry) throw new Error(`The theme "${id}" was written but could not be read back.`);
    return entry;
  };

  const install = async (
    files: ThemeFile[],
    source: ThemeSource = "user",
    origin?: ThemeOrigin
  ): Promise<ThemeEntry[]> => {
    await loaded();
    // Validate everything first: one invalid file installs nothing.
    const parsed = files.map((file) => parseThemeFile(file));
    const count = userFiles.value.length;
    if (count + parsed.length > MAX_THEME_FILES) {
      const adding = parsed.length === 1 ? "this one" : `these ${parsed.length}`;
      throw new Error(
        `The themes folder holds at most ${MAX_THEME_FILES} themes and has ${count}: ` +
          `remove ${count + parsed.length - MAX_THEME_FILES} before adding ${adding}.`
      );
    }
    const assigned = new Set<string>();
    const planned = parsed.map((file) => {
      const id = uniqueThemeId(
        file.id ?? themeIdFromName(file.name),
        (candidate) => isTaken(candidate) || assigned.has(candidate)
      );
      assigned.add(id);
      let fileOrigin = file.origin ?? origin;
      if (source === "openvsx") fileOrigin = { ...fileOrigin, label: OPEN_VSX_LABEL };
      return { id, file: { ...file, id, ...(fileOrigin ? { origin: fileOrigin } : {}) } };
    });
    // All or nothing: a failed write removes the files this call wrote.
    const written: string[] = [];
    try {
      for (const { id, file } of planned) {
        await writeTheme(`${id}.json`, file);
        written.push(`${id}.json`);
      }
    } catch (e) {
      await Promise.all(
        written.map((fileName) => removeFile(themePath(fileName), { baseDir }).catch(() => undefined))
      );
      if (written.length > 0) await reload();
      throw e;
    }
    await reload();
    return planned.map(({ id }) => readBack(id));
  };

  const save = async (id: string, file: ThemeFile): Promise<ThemeEntry> => {
    await loaded();
    const current = userFile(id);
    if (!current) throw new Error(`"${id}" is not one of your themes.`);
    // Only an explicit id renames (parseThemeFile derives one from the name).
    const explicit = file.id !== undefined;
    const parsed = parseThemeFile(file);
    const plan = planThemeSave({ id, fileName: current.fileName }, explicit ? parsed.id : undefined);
    if (plan.remove && isTaken(plan.id)) {
      throw new Error(`A theme with the id "${plan.id}" already exists.`);
    }
    const content: ThemeFile = { ...parsed };
    if (!explicit) delete content.id;
    await writeTheme(plan.fileName, content);
    if (plan.remove) {
      // The renamed theme is listed before the settings switch to it (no JET flash).
      await reload();
      const saved = settings();
      if (saved.lightTheme === id) saved.lightTheme = plan.id;
      if (saved.darkTheme === id) saved.darkTheme = plan.id;
      await removeFile(themePath(plan.remove), { baseDir });
    }
    await reload();
    return readBack(plan.id);
  };

  const remove = async (id: string): Promise<void> => {
    await loaded();
    const current = userFile(id);
    if (!current) throw new Error(`"${id}" is not one of your themes.`);
    await removeFile(themePath(current.fileName), { baseDir });
    const saved = settings();
    if (saved.lightTheme === id) saved.lightTheme = DEFAULT_THEME_ID;
    if (saved.darkTheme === id) saved.darkTheme = DEFAULT_THEME_ID;
    await reload();
  };

  return {
    sync,
    resolved,
    resolve,
    preview,
    install,
    save,
    remove,
    loadFile,
    folder,
    reload,
    dispose() {
      disposed = true;
      scope.stop();
      unwatch?.();
    },
  };
}

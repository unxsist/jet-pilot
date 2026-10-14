/*
 * The actions folder ($APPCONFIG/actions): read, watched (hot reload),
 * written by Settings › Actions. Loaded lazily through ./store.ts, so the
 * YAML parser and fs plugin stay out of the startup bundle. Every file is
 * parsed on its own: a broken one is listed with its problem and never
 * affects the others.
 */
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
import { invoke } from "@tauri-apps/api/core";
import { warn } from "@/lib/logger";
import {
  ACTIONS_DIR,
  MAX_ACTION_FILE_BYTES,
  MAX_ACTION_FILES,
  actionIdOf,
  isActionFileName,
  parseActionFile,
} from "./schema";
import type { ActionFile } from "./types";

const baseDir = BaseDirectory.AppConfig;
const relative = (file: string) => `${ACTIONS_DIR}/${file}`;
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export async function startActionsRuntime(publish: (files: ActionFile[]) => void) {
  let files: ActionFile[] = [];

  let folderReady: Promise<void> | null = null;
  const ensureFolder = () => {
    if (!folderReady) {
      folderReady = exists(ACTIONS_DIR, { baseDir }).then(async (found) => {
        if (!found) await mkdir(ACTIONS_DIR, { baseDir, recursive: true });
      });
      folderReady.catch(() => (folderReady = null));
    }
    return folderReady;
  };
  const folder = async () => join(await appConfigDir(), ACTIONS_DIR);

  const readFile = async (file: string, dir: string, previous?: ActionFile): Promise<ActionFile> => {
    const path = await join(dir, file);
    const id = actionIdOf(file);
    const broken = (text: string, problem: string): ActionFile => ({
      file,
      id,
      path,
      text,
      action: null,
      error: { message: problem },
    });
    let text: string;
    try {
      const info = await stat(relative(file), { baseDir });
      if (info.size > MAX_ACTION_FILE_BYTES) return broken("", "The file is larger than 64 KB");
      text = await readTextFile(relative(file), { baseDir });
    } catch (e) {
      return broken("", `The file can't be read: ${message(e)}`);
    }
    if (previous && previous.text === text) return previous;
    const parsed = parseActionFile(file, text);
    return { file, id, path, text, action: parsed.action, error: parsed.error };
  };

  const readAll = async () => {
    await ensureFolder();
    const dir = await folder();
    const names = (await readDir(ACTIONS_DIR, { baseDir }))
      .filter((entry) => entry.isFile && !entry.isSymlink && isActionFileName(entry.name))
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b));
    if (names.length > MAX_ACTION_FILES) {
      warn(`Only the first ${MAX_ACTION_FILES} of ${names.length} action files are loaded.`);
    }
    const previous = new Map(files.map((file) => [file.file, file]));
    // "grafana.yaml" and "grafana.yml" would share an id: the second is listed as broken.
    const seen = new Set<string>();
    const next: ActionFile[] = [];
    for (const name of names.slice(0, MAX_ACTION_FILES)) {
      const file = await readFile(name, dir, previous.get(name));
      const key = file.id.toLowerCase();
      if (seen.has(key)) {
        next.push({ ...file, action: null, error: { message: `Another file is also named ${file.id}: rename one of them` } });
      } else next.push(file);
      seen.add(key);
    }
    if (next.length !== files.length || next.some((file, index) => file !== files[index])) {
      files = next;
      publish(files);
    }
  };

  /* One read at a time; changes meanwhile read again afterwards. */
  let reading: Promise<void> | null = null;
  let again = false;
  const reload = (): Promise<void> => {
    if (reading) {
      again = true;
      return reading;
    }
    reading = readAll()
      .catch((e) => warn(`Failed to read the actions folder: ${message(e)}`))
      .finally(() => {
        reading = null;
        if (again) {
          again = false;
          void reload();
        }
      });
    return reading;
  };

  await reload();
  publish(files);
  try {
    await watchFs(ACTIONS_DIR, () => void reload(), { baseDir, delayMs: 150 });
  } catch (e) {
    warn(`Action files are not watched for changes: ${message(e)}`);
  }

  return {
    reload,
    folder,
    /** Writes `file` (created when new) and reloads. */
    async write(file: string, text: string) {
      await ensureFolder();
      await writeTextFile(relative(file), text, { baseDir });
      await reload();
    },
    async remove(file: string) {
      await removeFile(relative(file), { baseDir });
      await reload();
    },
    /** Reveals the folder in the system file manager. */
    async openFolder() {
      await ensureFolder();
      await invoke("open_actions_folder");
    },
    files: () => files,
  };
}

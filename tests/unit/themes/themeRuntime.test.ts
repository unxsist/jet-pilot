/*
 * The theme runtime (src/providers/ThemeRuntime.ts) against an in-memory
 * themes folder: saving, installing and listing user files. The folder can
 * be case-insensitive like APFS / NTFS (a write keeps the existing name).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ref, shallowRef } from "vue";
import type { ThemeEntry, ThemeFile, ThemeSettings, ResolvedTheme } from "@/lib/themes/types";

const fs = vi.hoisted(() => {
  const state = {
    caseInsensitive: true,
    /** Normalised path → the name on disk and the text. */
    files: new Map<string, { name: string; text: string }>(),
    failWrite: null as ((path: string) => boolean) | null,
  };
  const key = (path: string) => (state.caseInsensitive ? path.toLowerCase() : path);
  const name = (path: string) => path.replace(/^themes\//, "");
  return {
    state,
    put(fileName: string, value: unknown) {
      state.files.set(key(`themes/${fileName}`), { name: fileName, text: JSON.stringify(value) });
    },
    /** The file names on disk. */
    names: () => [...state.files.values()].map((file) => file.name).sort(),
    read: (fileName: string) => {
      const file = state.files.get(key(`themes/${fileName}`));
      return file ? JSON.parse(file.text) : undefined;
    },
    module: {
      BaseDirectory: { AppConfig: 13 },
      exists: async () => true,
      mkdir: async () => undefined,
      readDir: async () =>
        [...state.files.values()].map((file) => ({
          name: file.name,
          isFile: true,
          isDirectory: false,
          isSymlink: false,
        })),
      stat: async (path: string) => {
        const file = state.files.get(key(path));
        if (!file) throw new Error(`${path}: not found`);
        return { size: file.text.length };
      },
      readTextFile: async (path: string) => {
        const file = state.files.get(key(path));
        if (!file) throw new Error(`${path}: not found`);
        return file.text;
      },
      writeTextFile: async (path: string, text: string) => {
        if (state.failWrite?.(path)) throw new Error("No space left on device");
        const existing = state.files.get(key(path));
        state.files.set(key(path), { name: existing?.name ?? name(path), text });
      },
      remove: async (path: string) => {
        if (!state.files.delete(key(path))) throw new Error(`${path}: not found`);
      },
      watch: async () => () => undefined,
    },
  };
});

vi.mock("@tauri-apps/plugin-fs", () => fs.module);
vi.mock("@tauri-apps/api/path", () => ({
  appConfigDir: async () => "/config",
  join: async (...parts: string[]) => parts.join("/"),
}));
vi.mock("@/lib/logger", () => ({ error: vi.fn(), warn: vi.fn(), log: vi.fn() }));

import { createThemeRuntime, type ThemeRuntime } from "@/providers/ThemeRuntime";

const theme = (name: string, extra: Record<string, unknown> = {}) => ({
  name,
  appearance: "dark",
  canvas: "#1a1b26",
  accent: "#7aa2f7",
  ...extra,
});

let settings: ThemeSettings;
let themes: ReturnType<typeof shallowRef<ThemeEntry[]>>;
let runtime: ThemeRuntime;

const start = async () => {
  themes = shallowRef<ThemeEntry[]>([]);
  runtime = createThemeRuntime({
    appearanceSettings: () => settings,
    wanted: ref("dark"),
    themes,
    active: shallowRef<ResolvedTheme | null>(null),
    activeId: ref("jet"),
    previewing: ref(false),
    paint: () => undefined,
  });
  await runtime.reload();
};
const user = () => themes.value.filter((entry) => entry.source !== "builtin");

beforeEach(() => {
  fs.state.caseInsensitive = true;
  fs.state.files.clear();
  fs.state.failWrite = null;
  settings = { colorScheme: "dark", lightTheme: "jet", darkTheme: "nightfall" };
});
afterEach(() => runtime?.dispose());

describe("save", () => {
  it("keeps a dropped file without an id where it is (case-insensitive folder)", async () => {
    fs.put("Nightfall.json", theme("Nightfall"));
    await start();
    expect(user().map((entry) => entry.id)).toEqual(["nightfall"]);

    const saved = await runtime.save("nightfall", theme("Nightfall", { accent: "#ff0000" }) as ThemeFile);
    expect(saved.id).toBe("nightfall");
    expect(fs.names()).toEqual(["Nightfall.json"]);
    expect(fs.read("Nightfall.json").accent).toBe("#ff0000");
    expect(fs.read("Nightfall.json").id).toBeUndefined();
  });

  it("doesn't rename when the name changes, even to another theme's name", async () => {
    fs.put("Nightfall.json", theme("Nightfall"));
    fs.put("dusk.json", theme("Dusk"));
    await start();
    const saved = await runtime.save("nightfall", theme("Dusk") as ThemeFile);
    expect(saved).toMatchObject({ id: "nightfall", name: "Dusk" });
    expect(fs.names()).toEqual(["Nightfall.json", "dusk.json"]);
    expect(settings.darkTheme).toBe("nightfall");
  });

  it("renames for an explicit new id, and the settings follow", async () => {
    fs.state.caseInsensitive = false;
    fs.put("Nightfall.json", theme("Nightfall"));
    await start();
    const saved = await runtime.save("nightfall", theme("Nightfall", { id: "evening" }) as ThemeFile);
    expect(saved.id).toBe("evening");
    expect(fs.names()).toEqual(["evening.json"]);
    expect(fs.read("evening.json").id).toBe("evening");
    expect(settings.darkTheme).toBe("evening");
    expect(user().map((entry) => entry.id)).toEqual(["evening"]);
  });

  it("refuses an explicit id that is taken, and changes nothing", async () => {
    fs.put("nightfall.json", theme("Nightfall"));
    fs.put("dusk.json", theme("Dusk"));
    await start();
    await expect(
      runtime.save("nightfall", theme("Nightfall", { id: "dusk" }) as ThemeFile)
    ).rejects.toThrow(/already exists/);
    await expect(
      runtime.save("nightfall", theme("Nightfall", { id: "dracula" }) as ThemeFile)
    ).rejects.toThrow(/already exists/);
    expect(fs.names()).toEqual(["dusk.json", "nightfall.json"]);
    expect(fs.read("nightfall.json")).toEqual(theme("Nightfall"));
  });
});

describe("install", () => {
  it("refuses more than 64 theme files before writing anything", async () => {
    for (let i = 0; i < 63; i++) fs.put(`theme-${i}.json`, theme(`Theme ${i}`));
    await start();
    await expect(
      runtime.install([theme("One") as ThemeFile, theme("Two") as ThemeFile])
    ).rejects.toThrow(/at most 64 themes and has 63: remove 1 before adding these 2/);
    expect(fs.names()).toHaveLength(63);
    await runtime.install([theme("One") as ThemeFile]);
    expect(fs.names()).toHaveLength(64);
  });

  it("installs all or nothing", async () => {
    await start();
    fs.state.failWrite = (path) => path.endsWith("two.json");
    await expect(
      runtime.install([theme("One") as ThemeFile, theme("Two") as ThemeFile, theme("Three") as ThemeFile])
    ).rejects.toThrow(/No space left/);
    expect(fs.names()).toEqual([]);
    expect(user()).toEqual([]);
  });
});

describe("listing", () => {
  it("gives files named after a built-in or a reserved id a distinct id", async () => {
    fs.state.caseInsensitive = false;
    fs.put("dracula.json", theme("My Dracula"));
    fs.put("light.json", theme("Light-ish"));
    fs.put("nightfall.json", theme("Nightfall"));
    fs.put("Nightfall.json", theme("Nightfall again"));
    await start();
    const ids = themes.value.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(user().map(({ id, error }) => ({ id, broken: !!error }))).toEqual(
      expect.arrayContaining([
        { id: "dracula~dracula.json", broken: true },
        { id: "light~light.json", broken: true },
        { id: "nightfall", broken: false },
        { id: "nightfall~Nightfall.json", broken: true },
      ])
    );
    expect(themes.value.find((entry) => entry.id === "dracula")?.source).toBe("builtin");
  });
});

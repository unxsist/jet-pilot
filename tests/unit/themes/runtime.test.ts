import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import {
  bootCacheEntry,
  fileAppearances,
  paintedAppearance,
  parseBootCache,
  pickTheme,
  themeGroup,
  themeIdFromFileName,
  uniqueThemeId,
  wantedAppearance,
  type BootCache,
} from "@/lib/themes/runtime";
import type { ThemeAppearance, ThemeFile } from "@/lib/themes/types";

const APPEARANCES: Record<string, ThemeAppearance[]> = {
  jet: ["light", "dark"],
  dracula: ["dark"],
  "github-light": ["light"],
};
const lookup = (id: string) => (id === "broken" ? null : APPEARANCES[id]);

describe("appearance", () => {
  it("follows the scheme, or the system for auto", () => {
    expect(wantedAppearance("light", true)).toBe("light");
    expect(wantedAppearance("dark", false)).toBe("dark");
    expect(wantedAppearance("auto", true)).toBe("dark");
    expect(wantedAppearance("auto", false)).toBe("light");
  });

  it("paints a theme's own appearance when it lacks the wanted one (T3)", () => {
    expect(paintedAppearance(["dark"], "light")).toBe("dark");
    expect(paintedAppearance(["light", "dark"], "light")).toBe("light");
    expect(paintedAppearance([], "dark")).toBe("dark");
  });

  it("reads the appearances of a file", () => {
    const base = { name: "X", canvas: "#000", accent: "#fff" };
    expect(fileAppearances({ ...base, appearance: "dark" } as ThemeFile)).toEqual(["dark"]);
    expect(
      fileAppearances({ ...base, appearance: "dark", variants: { light: { canvas: "#fff" } } } as ThemeFile)
    ).toEqual(["light", "dark"]);
  });
});

describe("pickTheme", () => {
  const settings = { lightTheme: "jet", darkTheme: "dracula" };

  it("takes the half for the wanted appearance", () => {
    expect(pickTheme(settings, "dark", lookup, "jet")).toEqual({ id: "dracula", appearance: "dark" });
    expect(pickTheme(settings, "light", lookup, "jet")).toEqual({ id: "jet", appearance: "light" });
  });

  it("paints a dark-only theme chosen for light mode dark", () => {
    expect(pickTheme({ lightTheme: "dracula", darkTheme: "jet" }, "light", lookup, "jet")).toEqual({
      id: "dracula",
      appearance: "dark",
    });
  });

  it("falls back to JET for unknown and broken themes", () => {
    for (const id of ["gone", "broken"]) {
      expect(pickTheme({ lightTheme: id, darkTheme: id }, "dark", lookup, "jet")).toEqual({
        id: "jet",
        appearance: "dark",
      });
    }
  });
});

describe("theme ids", () => {
  it("de-duplicates with -2, -3 within 48 characters", () => {
    const taken = new Set(["nord", "nord-2", "dracula"]);
    expect(uniqueThemeId("harbor", (id) => taken.has(id))).toBe("harbor");
    expect(uniqueThemeId("nord", (id) => taken.has(id))).toBe("nord-3");
    expect(uniqueThemeId("dracula", (id) => taken.has(id))).toBe("dracula-2");
    const long = "a".repeat(48);
    const id = uniqueThemeId(long, (candidate) => candidate === long);
    expect(id).toHaveLength(48);
    expect(id.endsWith("-2")).toBe(true);
    // No "--" when the cut ends on a hyphen.
    expect(uniqueThemeId(`${"a".repeat(45)}-bc`, () => false)).toBe(`${"a".repeat(45)}-bc`);
    expect(uniqueThemeId(`${"a".repeat(45)}-bc`, (c) => c.endsWith("-bc"))).toBe(`${"a".repeat(45)}-2`);
  });

  it("takes the id from the file name (T3's rule)", () => {
    expect(themeIdFromFileName("nightfall.json")).toBe("nightfall");
    expect(themeIdFromFileName("My Theme.JSON")).toBe("my-theme");
  });

  it("groups themes for the palette", () => {
    expect(themeGroup({ source: "builtin", origin: { label: "JET Pilot" } })).toBe("Built-in");
    expect(themeGroup({ source: "builtin", origin: { label: "T3 Code" } })).toBe("T3 Code");
    expect(themeGroup({ source: "user" })).toBe("Yours");
    expect(themeGroup({ source: "openvsx", origin: { label: "Open VSX" } })).toBe("Open VSX");
  });
});

describe("boot cache", () => {
  const vars = { background: "231 15% 18%", foreground: "60 30% 96%" };
  const cache: BootCache = {
    v: 1,
    light: bootCacheEntry({ id: "dracula", appearance: "dark" }, vars),
    dark: bootCacheEntry({ id: "jet", appearance: "dark" }, null),
  };

  it("has an entry per wanted appearance; JET carries no variables", () => {
    expect(cache.light).toEqual({ id: "dracula", dark: true, vars });
    expect(cache.dark).toEqual({ id: "jet", dark: true });
    expect(parseBootCache(JSON.stringify(cache))).toEqual(cache);
  });

  it("reads corrupt or foreign values as empty", () => {
    for (const raw of [null, "", "{", "[]", '{"v":2,"light":{}}', '"x"']) {
      expect(parseBootCache(raw)).toEqual({ v: 1 });
    }
    expect(parseBootCache('{"v":1,"light":{"id":1},"dark":{"id":"jet","dark":true}}')).toEqual({
      v: 1,
      dark: { id: "jet", dark: true },
    });
  });

  /* public/boot.js is a classic script: run it against a fake document. */
  const boot = readFileSync(join(__dirname, "../../../public/boot.js"), "utf8");
  const runBoot = (storage: Record<string, string>, systemDark: boolean) => {
    const properties = new Map<string, string>();
    const classes = new Set<string>();
    const attributes = new Map<string, string>();
    const documentElement = {
      style: { setProperty: (name: string, value: string) => properties.set(name, value) },
      classList: {
        toggle: (name: string, on: boolean) => (on ? classes.add(name) : classes.delete(name)),
      },
      setAttribute: (name: string, value: string) => attributes.set(name, value),
    };
    runInNewContext(boot, {
      document: { documentElement },
      localStorage: { getItem: (key: string) => storage[key] ?? null },
      window: { matchMedia: () => ({ matches: systemDark }) },
    });
    return { properties, classes, theme: attributes.get("data-theme-id") };
  };

  it("boot.js paints the cached entry for the wanted appearance", () => {
    const storage = { "vueuse-color-scheme": "auto", "jet-theme-cache": JSON.stringify(cache) };
    const light = runBoot(storage, false);
    expect([...light.classes]).toEqual(["dark"]);
    expect(light.properties.get("--background")).toBe(vars.background);
    expect(light.theme).toBe("dracula");

    const dark = runBoot(storage, true);
    expect([...dark.classes]).toEqual(["dark"]);
    expect(dark.properties.size).toBe(0);
    expect(dark.theme).toBeUndefined();
  });

  it("boot.js falls back to the scheme without (or with a corrupt) cache", () => {
    expect([...runBoot({ "vueuse-color-scheme": "dark" }, false).classes]).toEqual(["dark"]);
    expect([...runBoot({ "jet-theme-cache": "{oops" }, false).classes]).toEqual(["light"]);
    expect([...runBoot({}, true).classes]).toEqual(["dark"]);
  });
});

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { JetDark, JetLight } from "@/components/monaco/themes/jet";
import { BUILTIN_THEMES, DEFAULT_THEME_ID } from "@/lib/themes/builtin";
import { JET_THEME } from "@/lib/themes/builtin/jet";
import { contrastRatio } from "@/lib/themes/contrast";
import { CONTRAST_PAIRS } from "@/lib/themes/derive";
import { resolveTheme, themeAppearances } from "@/lib/themes/resolve";
import { THEME_JSON_SCHEMA } from "@/lib/themes/schema";
import { serializeTheme } from "@/lib/themes/serialize";
import {
  type ThemeAppearance,
  type ThemeFile,
  THEME_COLOR_ROLES,
  THEME_TOKENS,
} from "@/lib/themes/types";
import { parseThemeFile } from "@/lib/themes/validate";
import { builtinFiles, FIXTURES, fixture, importFixture, validateSchema } from "./helpers";

const repo = join(__dirname, "../../..");

/** The token triplets of a selector block in main.postcss. */
function postcssTokens(selector: string): Record<string, string> {
  const css = readFileSync(join(repo, "src/assets/main.postcss"), "utf8");
  const start = css.indexOf(`${selector} {`);
  const block = css.slice(start, css.indexOf("}", start));
  return Object.fromEntries(
    [...block.matchAll(/--([a-z0-9-]+):\s*([^;]+);/g)]
      .filter(([, name]) => (THEME_TOKENS as readonly string[]).includes(name!))
      .map(([, name, value]) => [name, value!.trim()])
  );
}

/** DARK_THEME / LIGHT_THEME of PtyTerminal.vue. */
function ptyTheme(name: string): Record<string, string> {
  const source = readFileSync(join(repo, "src/components/PtyTerminal.vue"), "utf8");
  const start = source.indexOf(`const ${name} = {`);
  const block = source.slice(start, source.indexOf("};", start));
  return Object.fromEntries(
    [...block.matchAll(/(\w+):\s*"([^"]+)"/g)].map(([, key, value]) => [key, value])
  );
}

const allThemes = (): [string, ThemeFile][] => [
  ["jet", JET_THEME],
  ...builtinFiles().map((file): [string, ThemeFile] => [file.id!, file]),
  ...FIXTURES.map((name): [string, ThemeFile] => [name, importFixture(name)]),
];

const cases = allThemes().flatMap(([name, file]) =>
  themeAppearances(file).map((appearance): [string, ThemeAppearance, ThemeFile] => [name, appearance, file])
);

describe("the JET built-in", () => {
  it("reproduces main.postcss exactly", () => {
    const light = postcssTokens(":root,\n  .light");
    const dark = postcssTokens(".dark");
    expect(Object.keys(light)).toHaveLength(THEME_TOKENS.length);
    expect(Object.keys(dark)).toHaveLength(THEME_TOKENS.length);
    expect(resolveTheme(JET_THEME, "light").vars).toEqual(light);
    expect(resolveTheme(JET_THEME, "dark").vars).toEqual(dark);
  });

  it("reproduces the Monaco themes", () => {
    expect(resolveTheme(JET_THEME, "dark").monaco).toEqual(JetDark);
    expect(resolveTheme(JET_THEME, "light").monaco).toEqual(JetLight);
    expect(JetDark.colors["editor.background"]).toBe("#101011");
    expect(JetDark.rules).toContainEqual({ token: "comment", foreground: "6e6e78", fontStyle: "italic" });
    expect(JetLight.rules).toContainEqual({ token: "string.key.json", foreground: "3f37c9" });
  });

  it("reproduces the terminal themes of PtyTerminal.vue", () => {
    expect(resolveTheme(JET_THEME, "dark").xterm).toEqual(ptyTheme("DARK_THEME"));
    expect(resolveTheme(JET_THEME, "light").xterm).toEqual(ptyTheme("LIGHT_THEME"));
  });

  it("is the default and first built-in", () => {
    expect(DEFAULT_THEME_ID).toBe("jet");
    expect(BUILTIN_THEMES[0]!.id).toBe("jet");
  });
});

describe("resolution", () => {
  it.each(cases)("%s resolves in %s", (_name, appearance, file) => {
    const resolved = resolveTheme(file, appearance);
    expect(resolved.appearance).toBe(appearance);
    for (const value of Object.values(resolved.roles)) expect(value).toMatch(/^#[0-9a-f]{6}$/);
    for (const value of Object.values(resolved.vars)) {
      expect(value).toMatch(/^\d+(\.\d+)? \d+(\.\d+)?% \d+(\.\d+)?%$/);
    }
    expect(Object.keys(resolved.vars)).toHaveLength(THEME_TOKENS.length);
    expect(resolved.monaco.base).toBe(appearance === "dark" ? "vs-dark" : "vs");
    for (const rule of resolved.monaco.rules) expect(rule.foreground).toMatch(/^[0-9a-f]{6}$/);
    for (const value of Object.values(resolved.monaco.colors)) expect(value).toMatch(/^#[0-9a-f]{6}([0-9a-f]{2})?$/);
    expect(Object.keys(resolved.xterm)).toHaveLength(21);
  });

  it.each(cases)("%s (%s) meets the contrast guarantees", (_name, appearance, file) => {
    const { roles } = resolveTheme(file, appearance);
    expect(contrastRatio(roles.text, roles.canvas)).toBeGreaterThanOrEqual(7);
    for (const [foreground, background, min] of CONTRAST_PAIRS) {
      expect(contrastRatio(roles[foreground], roles[background]), `${foreground} on ${background}`).toBeGreaterThanOrEqual(min);
    }
  });

  it("falls back to the base for a missing appearance", () => {
    const dracula = importFixture("dracula-color-theme.json");
    expect(themeAppearances(dracula)).toEqual(["dark"]);
    expect(resolveTheme(dracula, "light").appearance).toBe("dark");
  });

  it("derives a seeded theme from canvas and accent, with colours on top", () => {
    const nightfall = resolveTheme(importFixture("nightfall.json"), "dark");
    expect(nightfall.id).toBe("nightfall");
    expect(nightfall.roles.canvas).toBe("#1a1b26");
    expect(nightfall.roles.accent).toBe("#7aa2f7");
    expect(nightfall.roles.terminalSelection).toBe("#292e42");
    expect(nightfall.roles.error).toBe("#f7768e");
    expect(nightfall.vars.background).toBe("235 18.8% 12.5%");
    expect(nightfall.xterm.selectionBackground).toBe("#292e42");
    // Derived success / info are a green and a blue.
    expect(nightfall.roles.success).not.toBe(nightfall.roles.info);
  });

  it("uses the syntax, terminal and editor extensions", () => {
    const dracula = resolveTheme(importFixture("dracula-color-theme.json"), "dark");
    expect(dracula.monaco.rules).toContainEqual({ token: "string", foreground: "f1fa8c" });
    expect(dracula.monaco.colors["editor.foldBackground"]).toBe("#21222c80");
    expect(dracula.xterm.red).toBe("#ff5555");
  });

  it("applies jetPilot.tokens over the mapping", () => {
    const file: ThemeFile = {
      name: "T",
      appearance: "dark",
      canvas: "#000000",
      accent: "#ff0000",
      jetPilot: { tokens: { background: "1 2% 3%" } },
    };
    expect(resolveTheme(file, "dark").vars.background).toBe("1 2% 3%");
  });
});

describe("serialization", () => {
  /** T3 Code's strict file shape (its parseThemeFile). */
  function expectT3Shape(value: Record<string, unknown>) {
    expect(Object.keys(value).every((key) => ["version", "id", "name", "appearance", "colors", "variants", "collection", "managed"].includes(key))).toBe(true);
    expect(value.version).toBe(1);
    const roleMaps = [value.colors, ...Object.values((value.variants ?? {}) as object)] as Record<string, string>[];
    for (const colors of roleMaps) {
      expect(Object.keys(colors).sort()).toEqual([...THEME_COLOR_ROLES].sort());
      for (const color of Object.values(colors)) expect(color).toMatch(/^#[0-9a-f]{6}$/);
    }
  }

  it.each(allThemes())("%s round-trips through the T3 export", (_name, file) => {
    const text = serializeTheme(file, { forT3: true });
    const value = JSON.parse(text);
    expectT3Shape(value);
    const parsed = parseThemeFile(value);
    expect(themeAppearances(parsed)).toEqual(themeAppearances(file));
    for (const appearance of themeAppearances(file)) {
      // The exported roles are already resolved and contrast-fixed, so they come back unchanged.
      const before = resolveTheme(file, appearance).roles;
      const after = resolveTheme(parsed, appearance).roles;
      for (const role of THEME_COLOR_ROLES) expect(after[role], role).toBe(before[role]);
    }
  });

  it("avoids ids T3 Code reserves", () => {
    expect(JSON.parse(serializeTheme(JET_THEME, { forT3: true })).id).toBe("jet-theme");
    expect(JSON.parse(serializeTheme({ ...JET_THEME, id: "t3-grove" }, { forT3: true })).id).toBe("t3-grove-theme");
  });

  it("writes theme files in a stable key order and re-parses them", () => {
    const nightfall = importFixture("nightfall.json");
    const text = serializeTheme({ ...nightfall, $schema: "jet-pilot://schemas/theme.json", author: "me" } as ThemeFile);
    expect(text.endsWith("}\n")).toBe(true);
    expect(Object.keys(JSON.parse(text))).toEqual(["$schema", "id", "name", "appearance", "canvas", "accent", "colors", "author"]);
    expect(parseThemeFile(JSON.parse(text))).toMatchObject({ id: "nightfall", author: "me" });
  });
});

describe("schema", () => {
  it.each(allThemes())("accepts %s", (_name, file) => {
    expect(validateSchema(THEME_JSON_SCHEMA, JSON.parse(JSON.stringify(file)))).toEqual([]);
  });

  it("accepts the raw T3 files and rejects unknown roles", () => {
    expect(validateSchema(THEME_JSON_SCHEMA, JSON.parse(fixture("nightfall.json")))).toEqual([]);
    expect(validateSchema(THEME_JSON_SCHEMA, JSON.parse(fixture("t3-export.json")))).toEqual([]);
    expect(validateSchema(THEME_JSON_SCHEMA, { name: "x", appearance: "dark", colors: { nope: "#000" } })).toEqual([
      "$.colors.nope: not allowed",
    ]);
  });

  it("describes every role and marks colours for Monaco's swatches", () => {
    const roles = THEME_JSON_SCHEMA.properties.colors.properties as Record<string, { description: string; format: string }>;
    for (const role of THEME_COLOR_ROLES) {
      expect(roles[role]!.description.length).toBeGreaterThan(10);
      expect(roles[role]!.format).toBe("color-hex");
    }
  });
});

describe("built-in catalogue", () => {
  it("lists JET, T3's palettes and the curated themes", () => {
    expect(BUILTIN_THEMES.map((theme) => theme.id)).toEqual([
      "jet",
      "t3-chat",
      "t3-grove",
      "t3-ocean",
      "t3-ember",
      "t3-iris",
      "catppuccin",
      "tokyo-night",
      "dracula",
      "nord",
      "github",
      "one-dark-pro",
      "rose-pine",
      "gruvbox",
    ]);
  });

  it.each(BUILTIN_THEMES.map((theme) => [theme.id, theme] as const))("%s loads lazily and matches its manifest", async (id, theme) => {
    const file = await theme.load();
    expect(file.id).toBe(id);
    expect(file.name).toBe(theme.name);
    expect(themeAppearances(file)).toEqual(theme.appearances);
    if (id !== "jet") {
      expect(() => parseThemeFile(file)).not.toThrow();
      expect(theme.origin?.license).toBe("MIT");
    }
  });
});

import { describe, expect, it } from "vitest";
import { contrastRatio } from "@/lib/themes/contrast";
import { importTheme } from "@/lib/themes/import";
import { scopeScore, splitSelectors, syntaxFromRules, readTokenRules } from "@/lib/themes/import/scopes";
import { SublimeColorResolver } from "@/lib/themes/import/sublime";
import { mergeVariants, pairVariants } from "@/lib/themes/import/vscode";
import { resolveTheme } from "@/lib/themes/resolve";
import type { ThemeFile } from "@/lib/themes/types";
import { fixture, importFixture } from "./helpers";

const vscode = (colors: Record<string, string>, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ name: "Test", type: "dark", colors: { "editor.background": "#1e1e1e", ...colors }, ...extra });

describe("format sniffing", () => {
  it.each([
    ["dracula-color-theme.json", "vscode"],
    ["harbor-light-color-theme.jsonc", "vscode"],
    ["monokai.sublime-color-scheme", "sublime"],
    ["meadow.tmTheme", "tmtheme"],
    ["nightfall.json", "t3"],
    ["t3-export.json", "t3"],
  ])("%s → %s", (name, format) => {
    const result = importTheme(fixture(name), name);
    expect(result.ok && result.format).toBe(format);
  });

  it("detects a JET file by its jetPilot block", () => {
    const text = JSON.stringify({
      name: "J",
      appearance: "dark",
      canvas: "#000000",
      accent: "#ff0000",
      jetPilot: { syntax: { key: "#ff0" } },
    });
    expect(importTheme(text)).toMatchObject({ ok: true, format: "jet" });
  });

  it("sniffs by content, not the file name", () => {
    expect(importTheme(fixture("meadow.tmTheme"), "theme.json")).toMatchObject({ format: "tmtheme" });
    expect(importTheme(fixture("nightfall.json"), "x.sublime-color-scheme")).toMatchObject({ format: "t3" });
  });

  it("a version-1 file with dotted keys is still a theme file (and fails T3 rules)", () => {
    const result = importTheme(JSON.stringify({ version: 1, name: "X", appearance: "dark", colors: { "editor.background": "#000" } }));
    expect(result).toEqual({ ok: false, error: '"editor.background" is not a supported theme color role.' });
  });

  it.each([
    ["", "The file is empty."],
    ["{ nope", "The file is not valid JSON"],
    ["[1, 2]", "Theme files must contain a JSON object."],
    [vscode({}, { colors: { "editor.foreground": "#fff" } }), 'no "editor.background" colour'],
    ["<?xml version=\"1.0\"?><plist><dict></dict></plist>", 'has no "settings" array'],
  ])("returns readable errors for %j", (text, message) => {
    const result = importTheme(text);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain(message);
  });
});

describe("VS Code import", () => {
  it("imports Dracula with syntax, terminal, editor and status colours", () => {
    const result = importTheme(fixture("dracula-color-theme.json"), "dracula.json");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const [theme] = result.themes;
    expect(theme).toMatchObject({ version: 1, id: "dracula", name: "Dracula", appearance: "dark" });
    expect(theme!.colors?.canvas).toBe("#282a36");
    expect(theme!.colors?.text).toBe("#f8f8f2");
    expect(theme!.jetPilot?.syntax).toMatchObject({ string: "#f1fa8c", comment: "#6272a4", text: "#f8f8f2" });
    expect(theme!.jetPilot?.terminal?.green).toBe("#50fa7b");
    expect(theme!.jetPilot?.colors?.success).toBe("#50fa7b");
    expect(theme!.jetPilot?.editor?.["editor.foldBackground"]).toBe("#21222c80");
    expect(result.warnings.some((warning) => /Ignored \d+ unsupported workbench colour keys/.test(warning))).toBe(true);
  });

  it("parses JSONC, humanizes slugs and detects the appearance from the background", () => {
    const theme = importFixture("harbor-light-color-theme.jsonc");
    expect(theme).toMatchObject({ name: "Harbor Light", id: "harbor-light", appearance: "light" });
    expect(theme.jetPilot?.editor?.["editorIndentGuide.background1"]).toBe("#e4e1d9");
    expect(theme.jetPilot?.colors).toEqual({ success: "#2f8f4e", info: "#2f6fdd" });
  });

  it("blends 8-digit hex over the surface it sits on", () => {
    const theme = importFixture("harbor-light-color-theme.jsonc");
    // list.hoverBackground #2f6fdd1a over the sidebar #f1efe9.
    expect(theme.colors?.sidebarRowHover).toBe("#dde2e8");
    // The editor keeps the alpha for Monaco.
    expect(theme.jetPilot?.editor?.["editor.selectionBackground"]).toBe("#2f6fdd33");
  });

  it("matches TextMate scopes by specificity", () => {
    const theme = importFixture("harbor-light-color-theme.jsonc");
    expect(theme.jetPilot?.syntax).toEqual({
      key: "#a8326e", // entity.name.tag.yaml beats entity.name.tag; source.css is ignored
      string: "#2f8f4e",
      number: "#b5641b",
      constant: "#8a3fd1", // constant.language.boolean beats constant.language
      comment: "#8a8f98",
      punctuation: "#6b7280",
      text: "#2b2f36",
    });
  });

  it("keeps readable foregrounds only (4.5:1 guard)", () => {
    const result = importTheme(vscode({ "editor.foreground": "#2a2a2a", "sideBar.background": "#1e1e1e", "sideBar.foreground": "#303030" }));
    if (!result.ok) throw new Error(result.error);
    const colors = result.themes[0]!.colors!;
    expect(contrastRatio(colors.text!, colors.canvas!)).toBeGreaterThanOrEqual(4.5);
    expect(colors.text).not.toBe("#2a2a2a");
    expect(contrastRatio(colors.sidebarForeground!, colors.sidebar!)).toBeGreaterThanOrEqual(4.5);
  });

  it("uses uiTheme over a stale type and falls back to luminance", () => {
    const light = importTheme(vscode({ "editor.background": "#fafafa" }, { type: "dark" }), "x.json", { uiTheme: "vs" });
    expect(light.ok && light.themes[0]!.appearance).toBe("light");
    const hc = importTheme(vscode({}, { type: "hc-black" }));
    expect(hc.ok && hc.themes[0]!.appearance).toBe("dark");
    const untyped = importTheme(JSON.stringify({ colors: { "editor.background": "#f0f0f0" } }), "paper-color-theme.json");
    expect(untyped.ok && untyped.themes[0]).toMatchObject({ appearance: "light", name: "Paper" });
  });

  it("follows include chains, child over parent", () => {
    const files: Record<string, string> = {
      "./base.json": JSON.stringify({
        include: "./root.json",
        colors: { "editor.foreground": "#dddddd", "terminal.ansiRed": "#aa0000" },
        tokenColors: [{ scope: "string", settings: { foreground: "#00aa00" } }],
      }),
      "./root.json": JSON.stringify({
        type: "dark",
        colors: { "editor.background": "#101010", "terminal.ansiBlue": "#0000aa" },
        tokenColors: [{ scope: "comment", settings: { foreground: "#777777" } }],
      }),
    };
    const child = JSON.stringify({
      name: "Child",
      include: "./base.json",
      colors: { "terminal.ansiRed": "#ff0000" },
      tokenColors: [{ scope: "string", settings: { foreground: "#00ff00" } }],
    });
    const result = importTheme(child, "child.json", { resolveInclude: (path) => files[path] });
    if (!result.ok) throw new Error(result.error);
    const [theme] = result.themes;
    expect(theme!.appearance).toBe("dark");
    expect(theme!.colors?.canvas).toBe("#101010");
    expect(theme!.jetPilot?.terminal).toMatchObject({ red: "#ff0000", blue: "#0000aa" });
    expect(theme!.jetPilot?.syntax).toMatchObject({ string: "#00ff00", comment: "#777777", text: "#dddddd" });
  });

  it("reports include problems", () => {
    const text = vscode({}, { include: "./missing.json" });
    expect(importTheme(text)).toMatchObject({ ok: true, warnings: expect.arrayContaining([expect.stringContaining("no way to read it")]) });
    expect(importTheme(text, "x.json", { resolveInclude: () => undefined })).toMatchObject({
      warnings: expect.arrayContaining([expect.stringContaining("file not found")]),
    });
    const cyclic = (path: string) => JSON.stringify({ include: path === "./a.json" ? "./b.json" : "./a.json" });
    expect(importTheme(vscode({}, { include: "./a.json" }), "x.json", { resolveInclude: cyclic })).toEqual({
      ok: false,
      error: "Theme includes contain a cycle.",
    });
    const deep = (path: string) => JSON.stringify({ include: `${path}x` });
    expect(importTheme(vscode({}, { include: "./d" }), "x.json", { resolveInclude: deep })).toEqual({
      ok: false,
      error: "Theme includes are nested too deeply.",
    });
  });

  it("reads tokenColors from a referenced .tmTheme", () => {
    const text = vscode({}, { tokenColors: "./meadow.tmTheme" });
    const result = importTheme(text, "x.json", { resolveInclude: () => fixture("meadow.tmTheme") });
    expect(result.ok && result.themes[0]!.jetPilot?.syntax?.string).toBe("#3a7d44");
  });

  it("renames ids that are reserved", () => {
    const result = importTheme(JSON.stringify({ name: "Dark", type: "dark", colors: { "editor.background": "#000" } }));
    expect(result.ok && result.themes[0]!.id).toBe("dark-theme");
  });
});

describe("pairing", () => {
  const theme = (name: string, appearance: "light" | "dark"): ThemeFile => ({
    version: 1,
    id: name.toLowerCase().replace(/\s+/g, "-"),
    name,
    appearance,
    colors: { canvas: appearance === "dark" ? "#000000" : "#ffffff" },
  });

  it("merges a light and a dark theme that differ by the appearance word", () => {
    const paired = pairVariants([theme("GitHub Light", "light"), theme("Other", "dark"), theme("GitHub Dark", "dark")]);
    expect(paired.map((file) => file.name)).toEqual(["GitHub", "Other"]);
    expect(paired[0]).toMatchObject({
      id: "github",
      appearance: "light",
      colors: { canvas: "#ffffff" },
      variants: { dark: { colors: { canvas: "#000000" } } },
    });
  });

  it("leaves ambiguous groups, appearance-only names and dual themes alone", () => {
    const files = [
      theme("Ayu Light", "light"),
      theme("Ayu Dark", "dark"),
      theme("Ayu  Dark", "dark"), // two darks for one light: not guessed at
      theme("Dark+", "dark"),
      theme("Light+", "light"),
      theme("Nord Dark Bordered", "dark"),
    ];
    expect(pairVariants(files).map((file) => file.name)).toEqual([
      "Ayu Light",
      "Ayu Dark",
      "Ayu  Dark",
      "Dark+",
      "Light+",
      "Nord Dark Bordered",
    ]);
    const dual = mergeVariants(theme("A Light", "light"), theme("A Dark", "dark"), "A");
    expect(pairVariants([dual, theme("A Dark", "dark")])).toHaveLength(2);
  });

  it("produces themes that resolve in both appearances", () => {
    const [paired] = pairVariants([importFixture("harbor-light-color-theme.jsonc"), { ...importFixture("dracula-color-theme.json"), name: "Harbor Dark" }]);
    expect(paired!.name).toBe("Harbor");
    expect(resolveTheme(paired!, "light").appearance).toBe("light");
    expect(resolveTheme(paired!, "dark").roles.canvas).toBe("#282a36");
  });
});

describe("Sublime import", () => {
  it("resolves variables, nested var() and color() adjusters", () => {
    const resolver = new SublimeColorResolver({
      white: "#ffffff",
      black: "#000000",
      fg: "var(white)",
      half: "color(var(fg) alpha(0.5))",
    });
    expect(resolver.resolve("var(fg)")).toBe("#ffffff");
    expect(resolver.resolve("var(half)")).toBe("#ffffff80");
    expect(resolver.resolve("color(var(white) blend(var(black) 25%))")).toBe("#404040");
    expect(resolver.resolve("color(#808080 l(+ 10%))")).toBe("#9a9a9a");
    expect(resolver.resolve("color(var(white) min-contrast(#000 4))")).toBe("#ffffff");
    expect(resolver.unsupported).toEqual(new Set(["min-contrast"]));
    expect(resolver.resolve("var(missing)")).toBeNull();
  });

  it("imports the Monokai scheme", () => {
    const result = importTheme(fixture("monokai.sublime-color-scheme"), "monokai.sublime-color-scheme");
    if (!result.ok) throw new Error(result.error);
    const [theme] = result.themes;
    expect(theme).toMatchObject({ name: "Monokai Test", id: "monokai-test", appearance: "dark" });
    expect(theme!.colors?.canvas).toBe("#282923");
    expect(theme!.colors?.accent).toBe("#67d8ef");
    expect(theme!.jetPilot?.syntax).toMatchObject({
      key: "#67d8ef",
      string: "#e7db74",
      number: "#ac80ff",
      comment: "#74705d",
      text: "#f8f8f2",
    });
    expect(theme!.jetPilot?.editor?.["editor.lineHighlightBackground"]).toMatch(/^#f8f8f2[0-9a-f]{2}$/);
    expect(result.warnings).toContain("Ignored unsupported colour adjusters: min-contrast.");
  });
});

describe("TextMate import", () => {
  it("maps the global settings and scope rules", () => {
    const result = importTheme(fixture("meadow.tmTheme"), "meadow.tmTheme");
    if (!result.ok) throw new Error(result.error);
    const [theme] = result.themes;
    expect(theme).toMatchObject({ name: "Meadow", id: "meadow", appearance: "light" });
    expect(theme!.colors?.canvas).toBe("#f7f9f2");
    expect(theme!.colors?.terminalCursor).toBe("#3a7d44");
    expect(theme!.colors?.accent).toBe("#6b3fa0"); // borrowed from the keyword rule
    expect(theme!.jetPilot?.syntax).toEqual({
      key: "#1f5fa3",
      string: "#3a7d44",
      number: "#a35a1f",
      constant: "#a35a1f",
      comment: "#7c8a72",
      text: "#283228",
    });
    expect(theme!.jetPilot?.editor?.["editor.selectionBackground"]).toBe("#3a7d4433");
  });
});

describe("scope matching", () => {
  it("prefix-matches with specificity, ancestors and exclusions", () => {
    expect(scopeScore("string", "string.quoted.double")).toBe(10);
    expect(scopeScore("string.quoted", "string.quoted.double")).toBe(20);
    expect(scopeScore("string.quoted.double.json", "string.quoted")).toBe(-1);
    expect(scopeScore("str", "string")).toBe(-1);
    expect(scopeScore("source.yaml string", "string.quoted")).toBe(11);
    expect(scopeScore("source.css string", "string.quoted")).toBe(-1);
    expect(scopeScore("string - string.quoted", "string.quoted.double")).toBe(-1);
    expect(splitSelectors(["a, b", "c"])).toEqual(["a", "b", "c"]);
  });

  it("later rules win ties", () => {
    const rules = readTokenRules(
      [
        { scope: "comment", settings: { foreground: "#111111" } },
        { scope: "comment", settings: { foreground: "#222222" } },
        { settings: { foreground: "#333333" } },
      ],
      { r: 0, g: 0, b: 0 }
    );
    expect(syntaxFromRules(rules)).toEqual({ comment: "#222222", text: "#333333" });
  });
});

describe("T3 / JET import", () => {
  it("imports the Nightfall example and a full T3 export", () => {
    expect(importFixture("nightfall.json")).toMatchObject({ id: "nightfall", canvas: "#1a1b26", accent: "#7aa2f7" });
    const exported = importFixture("t3-export.json");
    expect(exported).toMatchObject({ id: "my-ocean", appearance: "light" });
    expect(Object.keys(exported.colors!)).toHaveLength(57);
    expect(Object.keys(exported.variants!.dark!.colors!)).toHaveLength(57);
  });
});

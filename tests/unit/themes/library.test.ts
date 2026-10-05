import { describe, expect, it } from "vitest";
import {
  appearanceChips,
  classifyThemeFile,
  clickMode,
  duplicateTheme,
  errorLine,
  fileNameOf,
  formatCount,
  groupThemes,
  isExtensionInstalled,
  jsonErrorLocation,
  newThemeText,
  openVsxUrl,
  originLabel,
  rolePaths,
  themeBadge,
  themeUsage,
  useOptions,
} from "@/lib/themes/library";
import { parseThemeFile } from "@/lib/themes/validate";
import { importSources } from "@/lib/themes/importFiles";
import { fixture } from "./helpers";
import { THEME_SCHEMA_URI } from "@/lib/themes/schema";
import type { ThemeEntry } from "@/lib/themes/types";

const entry = (overrides: Partial<ThemeEntry> & { id: string }): ThemeEntry => ({
  name: overrides.id,
  source: "builtin",
  appearances: ["light", "dark"],
  ...overrides,
});

const T3 = { label: "T3 Code" };

describe("groupThemes", () => {
  const entries = [
    entry({ id: "jet", name: "JET" }),
    entry({ id: "t3-chat", name: "T3 Chat", origin: T3 }),
    entry({ id: "dracula", name: "Dracula", appearances: ["dark"] }),
    entry({ id: "zeta", name: "Zeta", source: "user" }),
    entry({ id: "pastel", name: "Pastel", source: "openvsx", origin: { label: "Open VSX" } }),
    entry({ id: "broken", name: "broken", source: "user", appearances: [], error: "Not JSON" }),
  ];

  it("groups built-ins, T3 palettes and your themes (Open VSX and broken files included)", () => {
    const groups = groupThemes(entries);
    expect(groups.map((group) => group.label)).toEqual(["Built-in", "T3 Code", "Your themes"]);
    expect(groups[0]!.entries.map((e) => e.id)).toEqual(["jet", "dracula"]);
    expect(groups[1]!.entries.map((e) => e.id)).toEqual(["t3-chat"]);
    // Sorted by name.
    expect(groups[2]!.entries.map((e) => e.id)).toEqual(["broken", "pastel", "zeta"]);
  });

  it("always has a Your themes group, and drops empty built-in groups", () => {
    const groups = groupThemes([entry({ id: "jet" })]);
    expect(groups.map((group) => group.id)).toEqual(["builtin", "yours"]);
    expect(groups[1]!.entries).toEqual([]);
  });

  it("labels the origin of each card", () => {
    expect(themeBadge(entries[0]!)).toEqual({ label: "Built-in", tone: "muted" });
    expect(themeBadge(entries[1]!).label).toBe("T3 Code");
    expect(themeBadge(entries[3]!).label).toBe("Yours");
    expect(themeBadge(entries[4]!).label).toBe("Open VSX");
    expect(themeBadge(entries[5]!)).toEqual({ label: "Broken", tone: "destructive" });
  });
});

describe("theme usage", () => {
  const settings = { lightTheme: "github", darkTheme: "dracula" };

  it("tells which halves use a theme", () => {
    expect(themeUsage("github", settings)).toBe("light");
    expect(themeUsage("dracula", settings)).toBe("dark");
    expect(themeUsage("jet", { lightTheme: "jet", darkTheme: "jet" })).toBe("both");
    expect(themeUsage("nord", settings)).toBeNull();
  });

  it("shows a chip per appearance, plus a half used without having it", () => {
    expect(appearanceChips(entry({ id: "github" }), settings)).toEqual([
      { appearance: "light", used: true, native: true },
      { appearance: "dark", used: false, native: true },
    ]);
    // Dracula (dark only) chosen for light mode too.
    expect(
      appearanceChips(entry({ id: "dracula", appearances: ["dark"] }), {
        lightTheme: "dracula",
        darkTheme: "dracula",
      })
    ).toEqual([
      { appearance: "light", used: true, native: false },
      { appearance: "dark", used: true, native: true },
    ]);
  });

  it("clicks apply like the command palette", () => {
    expect(clickMode({ appearances: ["light", "dark"] })).toBe("both");
    expect(clickMode({ appearances: ["dark"] })).toBe("dark");
  });

  it("offers only the halves a theme can paint", () => {
    expect(useOptions({ appearances: ["dark"] })).toEqual([{ mode: "dark", label: "Use for dark mode" }]);
    expect(useOptions({ appearances: ["light", "dark"] }).map((o) => o.mode)).toEqual([
      "light",
      "dark",
      "both",
    ]);
  });
});

describe("duplicateTheme", () => {
  it("makes a -custom copy named (custom)", () => {
    const copy = duplicateTheme({ id: "dracula", name: "Dracula", appearance: "dark", managed: true, canvas: "#000", accent: "#fff" }, "dracula");
    expect(copy).toMatchObject({ id: "dracula-custom", name: "Dracula (custom)" });
    expect(copy.managed).toBeUndefined();
    expect(() => parseThemeFile(copy)).not.toThrow();
  });

  it("keeps ids within 48 characters", () => {
    const long = "a".repeat(46);
    const copy = duplicateTheme({ name: "x".repeat(48), appearance: "dark", canvas: "#000", accent: "#fff" }, long);
    expect(copy.id!.length).toBeLessThanOrEqual(48);
    expect(copy.id!.endsWith("-custom")).toBe(true);
    expect(copy.name.length).toBeLessThanOrEqual(48);
  });
});

describe("import files", () => {
  it("classifies dropped files by extension", () => {
    expect(classifyThemeFile("dracula-color-theme.json")).toBe("json");
    expect(classifyThemeFile("theme.JSONC")).toBe("json");
    expect(classifyThemeFile("Monokai.sublime-color-scheme")).toBe("sublime");
    expect(classifyThemeFile("Meadow.tmTheme")).toBe("tmtheme");
    expect(classifyThemeFile("theme.vsix")).toBeNull();
    expect(classifyThemeFile("notes.txt")).toBeNull();
  });

  it("takes the file name of POSIX and Windows paths", () => {
    expect(fileNameOf("/home/me/themes/a.json")).toBe("a.json");
    expect(fileNameOf("C:\\Users\\me\\b.tmTheme")).toBe("b.tmTheme");
  });

  it("labels origins by format", () => {
    expect(originLabel("vscode")).toBe("VS Code");
    expect(originLabel("sublime")).toBe("Sublime Text");
    expect(originLabel("tmtheme")).toBe("TextMate");
    expect(originLabel("t3")).toBe("T3 Code");
    expect(originLabel("jet")).toBeNull();
  });
});

describe("importSources", () => {
  const vscodeTheme = (name: string, type: "light" | "dark", background: string) =>
    JSON.stringify({ name, type, colors: { "editor.background": background, focusBorder: "#5b8def" } });

  it("pairs VS Code light / dark files and names both sources", async () => {
    const report = await importSources([
      { name: "harbor-light.json", text: vscodeTheme("Harbor Light", "light", "#fafafa") },
      { name: "harbor-dark.json", text: vscodeTheme("Harbor Dark", "dark", "#16161e") },
    ]);
    expect(report.errors).toEqual([]);
    expect(report.themes).toHaveLength(1);
    const [theme] = report.themes;
    expect(theme!.file.name).toBe("Harbor");
    expect(theme!.file.variants?.dark).toBeDefined();
    expect(theme!.source).toBe("harbor-light.json + harbor-dark.json · VS Code");
    expect(theme!.file.origin).toEqual({ label: "VS Code" });
  });

  it("reports failing files next to the themes, with the format's origin", async () => {
    const report = await importSources([
      { name: "monokai.sublime-color-scheme", text: fixture("monokai.sublime-color-scheme") },
      { name: "broken.json", text: "{ nope" },
    ]);
    expect(report.themes).toHaveLength(1);
    expect(report.themes[0]!.file.origin).toEqual({ label: "Sublime Text" });
    expect(report.themes[0]!.source).toContain("Sublime Text");
    expect(report.errors.map((error) => error.source)).toEqual(["broken.json"]);
  });

  it("stamps a given origin (Open VSX) and keys themes uniquely", async () => {
    const origin = { label: "Open VSX", url: openVsxUrl("ns", "ext"), author: "ns" };
    const report = await importSources(
      [
        { name: "A", text: vscodeTheme("Alpha", "dark", "#111111"), uiTheme: "vs-dark" },
        { name: "B", text: vscodeTheme("Beta", "dark", "#121212"), uiTheme: "vs-dark" },
      ],
      origin
    );
    expect(report.themes.map((theme) => theme.file.origin)).toEqual([origin, origin]);
    expect(new Set(report.themes.map((theme) => theme.key)).size).toBe(2);
  });
});

describe("Open VSX", () => {
  it("formats download counts", () => {
    expect(formatCount(1_284_301)).toBe("1.3M");
    expect(formatCount(412_877)).toBe("413K");
    expect(formatCount(98_120)).toBe("98K");
    expect(formatCount(5_402)).toBe("5.4K");
    expect(formatCount(1_000)).toBe("1K");
    expect(formatCount(999_999)).toBe("1M");
    expect(formatCount(312)).toBe("312");
    expect(formatCount(-1)).toBe("0");
  });

  it("detects installed extensions by origin url", () => {
    const entries = [{ origin: { label: "Open VSX", url: openVsxUrl("dracula-theme", "theme-dracula") } }];
    expect(isExtensionInstalled(entries, "dracula-theme", "theme-dracula")).toBe(true);
    expect(isExtensionInstalled(entries, "dracula-theme", "other")).toBe(false);
    expect(isExtensionInstalled([{}], "a", "b")).toBe(false);
  });
});

describe("theme editor helpers", () => {
  it("seeds a valid new theme", () => {
    const text = newThemeText(THEME_SCHEMA_URI);
    const json = JSON.parse(text);
    expect(Object.keys(json)[0]).toBe("$schema");
    expect(parseThemeFile(json)).toMatchObject({ name: "My theme", appearance: "dark", canvas: "#16161e" });
  });

  it("finds the line a validation message is about", () => {
    const text = '{\n  "name": "X",\n  "colors": {\n    "text": "nope"\n  }\n}';
    expect(errorLine(text, 'The colour for "text" must be a CSS colour such as #1a1b26.')).toBe(4);
    expect(errorLine(text, "Something else")).toBeNull();
    expect(jsonErrorLocation('{\n  "a": }', "Unexpected token } in JSON at position 9")).toEqual({
      line: 2,
      column: 8,
    });
    expect(jsonErrorLocation("{", "Expected property name (line 3 column 5)")).toEqual({ line: 3, column: 5 });
  });

  it("knows where a role lives", () => {
    const file = {
      name: "X",
      appearance: "light",
      colors: { text: "#000" },
      variants: { dark: { canvas: "#111", accent: "#77f", colors: {} } },
    };
    expect(rolePaths(file, "text", "light")).toEqual([["colors", "text"]]);
    expect(rolePaths(file, "text", "dark")).toEqual([["variants", "dark", "colors", "text"]]);
    expect(rolePaths(file, "canvas", "dark")).toEqual([
      ["variants", "dark", "colors", "canvas"],
      ["variants", "dark", "canvas"],
    ]);
    expect(rolePaths(file, "success", "light")).toEqual([["jetPilot", "colors", "success"]]);
    // T3's flat variant form.
    const flat = { name: "Y", appearance: "dark", variants: { light: { canvas: "#fff", text: "#000" } } };
    expect(rolePaths(flat, "text", "light")).toEqual([["variants", "light", "text"]]);
    // No variant for that appearance: the base.
    expect(rolePaths({ appearance: "dark" }, "text", "light")).toEqual([["colors", "text"]]);
  });
});

import { describe, expect, it } from "vitest";
import { parseThemeFile, themeIdFromName } from "@/lib/themes/validate";

const full = (extra: Record<string, unknown> = {}) => ({
  version: 1,
  name: "Harbor",
  appearance: "dark",
  colors: { canvas: "#101820", accent: "#4aa3ff" },
  ...extra,
});

describe("themeIdFromName", () => {
  it("follows T3's rule", () => {
    expect(themeIdFromName("Tokyo Night Storm")).toBe("tokyo-night-storm");
    expect(themeIdFromName("  --Rosé Pine!! ")).toBe("rose-pine");
    expect(themeIdFromName("***")).toBe("custom-theme");
    expect(themeIdFromName("a".repeat(60))).toHaveLength(48);
  });
});

describe("parseThemeFile", () => {
  it("accepts the full form and fills the id", () => {
    const file = parseThemeFile(full());
    expect(file).toMatchObject({ version: 1, id: "harbor", name: "Harbor", appearance: "dark" });
  });

  it("accepts the seeded short form without a version", () => {
    const file = parseThemeFile({
      name: "Nightfall",
      appearance: "dark",
      canvas: "#1a1b26",
      accent: "#7aa2f7",
    });
    expect(file).toMatchObject({ id: "nightfall", canvas: "#1a1b26", accent: "#7aa2f7" });
    expect(file.version).toBeUndefined();
  });

  it("keeps unknown top-level keys", () => {
    expect(parseThemeFile(full({ author: "me", $schema: "x" }))).toMatchObject({ author: "me", $schema: "x" });
  });

  it("passes the origin through", () => {
    const origin = { label: "Open VSX", url: "https://open-vsx.org/extension/a/b", license: "MIT" };
    expect(parseThemeFile(full({ origin: { ...origin, label: " Open VSX " } })).origin).toEqual(origin);
    expect(() => parseThemeFile(full({ origin: { url: "x" } }))).toThrow(/origins need a label/);
    expect(() => parseThemeFile(full({ origin: { label: "x", url: 1 } }))).toThrow(/origins need a label/);
  });

  it.each([
    [null, "Theme files must contain a JSON object."],
    [full({ version: 2 }), "This theme file uses an unsupported version. Expected 1."],
    [full({ version: undefined }), 'Theme files need "version": 1'],
    [full({ name: "" }), "Theme files need a name (48 characters or fewer)."],
    [full({ name: "x".repeat(49) }), "Theme files need a name"],
    [full({ appearance: "dim" }), 'Theme files need an appearance of "light" or "dark".'],
    [full({ id: "Bad Id" }), "Theme ids may only contain lowercase letters"],
    [full({ id: "dark" }), 'The theme id "dark" is reserved.'],
    [full({ id: "jet" }), 'The theme id "jet" is reserved.'],
    [full({ colors: { canvass: "#000" } }), '"canvass" is not a supported theme color role.'],
    [full({ colors: { success: "#0f0" } }), '"success" is a JET Pilot role: put it in jetPilot.colors.'],
    [full({ colors: { canvas: "nope" } }), 'The colour for "canvas" must be a CSS colour'],
    [full({ colors: {} }), "Add at least one color role to the theme file."],
    [full({ colors: undefined }), "Theme files need a colors object."],
    [{ name: "N", appearance: "dark", canvas: "#000" }, 'Seeded theme files need both "canvas" and "accent"'],
    [{ name: "N", appearance: "dark", canvas: "#000", accent: "bogus" }, 'The "accent" seed must be a CSS colour'],
    [full({ variants: { dark: { canvas: "#000" } } }), 'Theme variants must not repeat the base appearance "dark".'],
    [full({ variants: { dim: {} } }), 'Theme variants may only be named "light" or "dark".'],
    [full({ variants: { light: {} } }), "Add at least one color role to the light variant."],
    [full({ variants: { light: { canvas: "#fff", bogus: "#000" } } }), 'variants.light: "bogus" is not a supported theme color role.'],
    [full({ collection: { id: "x" } }), "Theme collections need a valid id and label."],
    [full({ jetPilot: { fonts: {} } }), 'jetPilot: "fonts" is not supported'],
    [full({ jetPilot: { colors: { text: "#fff" } } }), '"text" is a T3 role: put it in the top-level colors.'],
    [full({ jetPilot: { terminal: { orange: "#f80" } } }), '"orange" is not an ANSI colour'],
    [full({ jetPilot: { syntax: { keyword: "#f80" } } }), '"keyword" is not a syntax slot'],
    [full({ jetPilot: { editor: { "editor.background": "x" } } }), 'The colour for "editor.background"'],
    [full({ jetPilot: { tokens: { background: "#fff" } } }), '"background" must be an HSL triplet'],
    [full({ jetPilot: { tokens: { canvas: "0 0% 0%" } } }), '"canvas" is not a JET Pilot token.'],
  ])("rejects %j", (value, message) => {
    expect(() => parseThemeFile(value)).toThrow(message);
  });

  it("normalises T3's flat variants to the structured form", () => {
    const file = parseThemeFile(
      full({ variants: { light: { canvas: "#ffffff", text: "#111111", jetPilot: { colors: { success: "#070" } } } } })
    );
    expect(file.variants?.light).toEqual({
      colors: { canvas: "#ffffff", text: "#111111" },
      jetPilot: { colors: { success: "#070" } },
    });
  });

  it("accepts structured variants with seeds and the jetPilot block", () => {
    const file = parseThemeFile(
      full({
        variants: { light: { canvas: "#fff", accent: "#06c", jetPilot: { tokens: { background: "0 0% 100%" } } } },
        jetPilot: { terminal: { red: "#f00" }, syntax: { key: "#0af" }, editor: { "editor.lineHighlightBackground": "#ffffff10" } },
        collection: { id: "harbor", label: "Harbor" },
        managed: true,
      })
    );
    expect(file.variants?.light?.canvas).toBe("#fff");
    expect(file.jetPilot?.terminal?.red).toBe("#f00");
    expect(file.collection).toEqual({ id: "harbor", label: "Harbor" });
    expect(file.managed).toBe(true);
  });
});

import { describe, expect, it } from "vitest";
import { JET_THEME } from "@/lib/themes/builtin/jet";
import { contrastRatio, toHslTriplet, tripletToHex } from "@/lib/themes/contrast";
import {
  chromaOf,
  completeRoles,
  deriveStatusColor,
  rgbToOklch,
  STATUS_CHROMA,
  statusReference,
} from "@/lib/themes/derive";
import { parseColor } from "@/lib/themes/contrast";
import { resolveTheme } from "@/lib/themes/resolve";
import { calmAccent } from "@/lib/themes/toTokens";
import type { ThemeAppearance, ThemeFile } from "@/lib/themes/types";
import { builtinFiles, FIXTURES, importFixture } from "./helpers";

const hueOf = (color: string) => (rgbToOklch(parseColor(color)!).h + 360) % 360;

/**
 * A muted, near-monochrome palette (sepia paper / ink): the action colour
 * is the text colour, the signal colours are desaturated, and it sets no
 * success / info of its own.
 */
const PARCHMENT: ThemeFile = {
  version: 1,
  name: "Parchment",
  appearance: "light",
  colors: {
    canvas: "#ccc8b1",
    text: "#211f1b",
    textMuted: "#4d4b3f",
    mutedForeground: "#4d4b3f",
    border: "#a29e89",
    focus: "#211f1b",
    accent: "#211f1b",
    accentForeground: "#dcd8c2",
    messageAction: "#211f1b",
    messageActionForeground: "#dcd8c2",
    error: "#a94a38",
    errorForeground: "#7d3427",
    errorSurface: "#cfb7a2",
    warning: "#a08e42",
    warningForeground: "#5c5022",
    warningSurface: "#ccc49e",
  },
  variants: {
    dark: {
      colors: {
        canvas: "#2f2d26",
        text: "#d1cdb7",
        textMuted: "#a8a593",
        mutedForeground: "#a8a593",
        border: "#4f4d45",
        focus: "#d1cdb7",
        accent: "#d1cdb7",
        accentForeground: "#2f2d26",
        messageAction: "#d1cdb7",
        messageActionForeground: "#2f2d26",
        error: "#c96b57",
        errorForeground: "#d98a77",
        errorSurface: "#45302a",
        warning: "#c2b169",
        warningForeground: "#d3c47e",
        warningSurface: "#403a24",
      },
    },
  },
};
const APPEARANCES: ThemeAppearance[] = ["light", "dark"];
const parchmentColors = (appearance: ThemeAppearance) =>
  (appearance === "light" ? PARCHMENT.colors : PARCHMENT.variants!.dark!.colors)!;

describe("derived success / info", () => {
  it.each(APPEARANCES)("follow a muted theme's own signal colours (%s)", (appearance) => {
    const { roles } = resolveTheme(PARCHMENT, appearance);
    for (const [role, hue] of [
      ["success", 145],
      ["info", 250],
    ] as const) {
      const color = roles[role];
      const chroma = chromaOf(color);
      expect(chroma, role).toBeGreaterThanOrEqual(STATUS_CHROMA.min - 0.005);
      // About the chroma of the theme's red / amber (≈ 0.1), well below JET's vivid ones.
      expect(chroma, role).toBeLessThan(0.12);
      expect(Math.abs(hueOf(color) - hue), role).toBeLessThan(15);
      // Text-grade, and no louder than the theme's own signal text.
      const ratio = contrastRatio(color, roles.canvas);
      expect(ratio, role).toBeGreaterThanOrEqual(4.5);
      expect(ratio, role).toBeLessThanOrEqual(7.05);
      // Solid fills keep readable text.
      expect(contrastRatio(roles[`${role}Foreground`], color)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("is JET's green / blue when the theme sets no signal colours", () => {
    const roles = completeRoles("dark", { canvas: "#16161e", accent: "#7aa2f7" });
    expect(roles.success).toBe(deriveStatusColor(155, "#16161e"));
    expect(roles.info).toBe(deriveStatusColor(250, "#16161e"));
    expect(statusReference({}, "#16161e")).toBeNull();
  });

  it("clamps the reference chroma and contrast", () => {
    expect(statusReference({ error: "#808080", warning: "#888888" }, "#101010")!.chroma).toBe(STATUS_CHROMA.min);
    const vivid = statusReference({ error: "#ff0000", errorForeground: "#ffd0d0", warning: "#ffcc00" }, "#000000")!;
    expect(vivid.chroma).toBe(STATUS_CHROMA.max);
    expect(vivid.contrast).toBe(7);
  });

  it("never replaces readable success / info a theme sets", () => {
    const dracula = importFixture("dracula-color-theme.json");
    const { success, info } = dracula.jetPilot!.colors!;
    const { roles } = resolveTheme(dracula, "dark");
    expect([roles.success, roles.info]).toEqual([success!.toLowerCase(), info!.toLowerCase()]);
  });
});

describe("a theme's own colours", () => {
  it.each(APPEARANCES)("are kept when they clear the floors (%s)", (appearance) => {
    const { roles } = resolveTheme(PARCHMENT, appearance);
    for (const [role, value] of Object.entries(parchmentColors(appearance))) {
      expect(roles[role as keyof typeof roles], role).toBe(value);
    }
  });

  it("are kept between the floor and the derived target", () => {
    // Text at 5:1 and muted text at 3.4:1: readable, so not pushed to 7:1 / 4.5:1.
    const roles = completeRoles("dark", {
      colors: { canvas: "#1e1e1e", text: "#949494", textMuted: "#717171", mutedForeground: "#7a7a7a" },
    });
    expect(roles.text).toBe("#949494");
    expect(roles.textMuted).toBe("#717171");
    expect(contrastRatio(roles.textMuted, "#1e1e1e")).toBeLessThan(4.5);
  });

  it("are corrected below the floors", () => {
    const roles = completeRoles("dark", {
      colors: { canvas: "#1e1e1e", text: "#3a3a3a", textMuted: "#2a2a2a", border: "#1f1f1f" },
    });
    expect(contrastRatio(roles.text, "#1e1e1e")).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(roles.text, "#1e1e1e")).toBeLessThan(7);
    expect(contrastRatio(roles.textMuted, "#1e1e1e")).toBeGreaterThanOrEqual(3);
    expect(contrastRatio(roles.border, "#1e1e1e")).toBeGreaterThanOrEqual(1.15);
  });

  it("keep a border darker than its surface darker", () => {
    const roles = completeRoles("dark", { colors: { canvas: "#1a1b26", border: "#16161e" } });
    expect(contrastRatio(roles.border, "#1a1b26")).toBeGreaterThanOrEqual(1.15);
    expect(parseColor(roles.border)!.r).toBeLessThan(0x1a);
  });

  it("derive text at 7:1 when the theme leaves it out", () => {
    const roles = completeRoles("light", { canvas: "#f4ecd8", accent: "#8a5a00" });
    expect(contrastRatio(roles.text, roles.canvas)).toBeGreaterThanOrEqual(7);
    expect(contrastRatio(roles.textMuted, roles.canvas)).toBeGreaterThanOrEqual(4.5);
  });
});

describe("accents of a monochrome theme", () => {
  it.each(APPEARANCES)("are calmed, within their floors (%s)", (appearance) => {
    const { roles, vars } = resolveTheme(PARCHMENT, appearance);
    const hex = (token: keyof typeof vars) => tripletToHex(vars[token]);
    const ratio = (token: keyof typeof vars) => contrastRatio(hex(token), roles.canvas);
    // The action colour is the text colour (> 8:1); its accent usages are quieter.
    expect(contrastRatio(roles.messageAction, roles.canvas)).toBeGreaterThan(8);
    for (const token of ["primary", "link"] as const) {
      expect(ratio(token), token).toBeGreaterThanOrEqual(4.5);
      expect(ratio(token), token).toBeLessThan(6);
    }
    for (const token of ["ring", "selection"] as const) {
      expect(ratio(token), token).toBeGreaterThanOrEqual(3);
      expect(ratio(token), token).toBeLessThan(5);
    }
    expect(contrastRatio(hex("primary-foreground"), hex("primary"))).toBeGreaterThanOrEqual(4.5);
  });

  it("leaves colourful and quiet accents alone", () => {
    expect(calmAccent("#7b75f2", "#101011", 0.4, 3)).toBe("#7b75f2");
    expect(calmAccent("#ebbbba", "#191724", 0.3, 4.5)).toBe("#ebbbba");
    // Neutral, but not louder than 6:1.
    expect(calmAccent("#808080", "#101011", 0.4, 3)).toBe("#808080");
    expect(calmAccent("#e4e4e8", "#101011", 0.4, 3)).not.toBe("#e4e4e8");
  });

  it("built-in and imported themes keep their accent tokens", () => {
    const files = [...builtinFiles(), ...FIXTURES.map((name) => importFixture(name))];
    for (const file of files) {
      for (const appearance of APPEARANCES) {
        const { roles, vars } = resolveTheme(file, appearance);
        expect(vars.ring, `${file.id} ${appearance}`).toBe(toHslTriplet(roles.focus));
        expect(vars.selection, `${file.id} ${appearance}`).toBe(toHslTriplet(roles.accent));
      }
    }
  });

  it("JET is unaffected", () => {
    for (const appearance of APPEARANCES) {
      const { vars } = resolveTheme(JET_THEME, appearance);
      const tokens = (appearance === "light" ? JET_THEME : JET_THEME.variants!.dark!).jetPilot!.tokens!;
      for (const token of ["primary", "ring", "link", "selection", "success", "info"] as const) {
        expect(vars[token], `${appearance} ${token}`).toBe(tokens[token]);
      }
    }
  });
});

import { describe, expect, it } from "vitest";
import { contrastRatio, tripletToHex } from "@/lib/themes/contrast";
import { pickActionColor } from "@/lib/themes/derive";
import { resolveTheme } from "@/lib/themes/resolve";
import { builtinFiles, FIXTURES, importFixture } from "./helpers";

const APPEARANCES = ["light", "dark"] as const;
/** The built-in palettes (complete theme files, not VS Code imports). */
const PALETTES = ["blossom", "grove", "ocean", "ember", "iris"];

describe("primary action colour", () => {
  const cases = [
    ...builtinFiles().map((file) => ({ label: `built-in ${file.id}`, file })),
    ...FIXTURES.map((name) => ({ label: `fixture ${name}`, file: importFixture(name) })),
  ];

  for (const { label, file } of cases) {
    for (const appearance of APPEARANCES) {
      it(`${label} (${appearance}): primary is visible on the canvas and apart from accent`, () => {
        const { vars } = resolveTheme(file, appearance);
        const primary = tripletToHex(vars.primary);
        const background = tripletToHex(vars.background);
        const accent = tripletToHex(vars.accent);
        expect(contrastRatio(primary, background)).toBeGreaterThanOrEqual(3);
        expect(primary).not.toBe(accent);
        expect(contrastRatio(primary, accent)).toBeGreaterThan(1.2);
        // Text on a primary fill stays readable.
        expect(
          contrastRatio(tripletToHex(vars["primary-foreground"]), primary)
        ).toBeGreaterThanOrEqual(4.4);
      });
    }
  }

  it("Dracula's primary is its purple, not the selection grey", () => {
    const dracula = builtinFiles().find((file) => file.id === "dracula")!;
    const primary = tripletToHex(resolveTheme(dracula, "dark").vars.primary);
    expect(primary).not.toBe("#44475a");
    expect(contrastRatio(primary, "#282a36")).toBeGreaterThanOrEqual(3);
  });

  it("imported VS Code themes keep hairline borders and quiet hover surfaces", () => {
    const vscode = [
      ...builtinFiles().filter((file) => file.id !== "jet" && !PALETTES.includes(file.id!)),
      importFixture("dracula-color-theme.json"),
      importFixture("harbor-light-color-theme.jsonc"),
    ];
    for (const file of vscode) {
      for (const appearance of APPEARANCES) {
        const { roles } = resolveTheme(file, appearance);
        const ratio = contrastRatio(roles.border, roles.canvas);
        expect(ratio, `${file.id} ${appearance}`).toBeGreaterThanOrEqual(1.1);
        expect(ratio, `${file.id} ${appearance}`).toBeLessThanOrEqual(3.2);
        // The hover / highlighted row surface stays a quiet surface.
        expect(contrastRatio(roles.accentSurface, roles.canvas), `${file.id} ${appearance}`).toBeLessThanOrEqual(2.2);
      }
    }
  });

  it("falls back to the most colourful candidate, solved for contrast", () => {
    // Both candidates are too dark on a dark canvas; the blue is kept and lightened.
    const picked = pickActionColor(["#44475a", "#1e2a8a"], "#101011", "#252528");
    expect(contrastRatio(picked, "#101011")).toBeGreaterThanOrEqual(3);
    expect(picked).not.toBe("#44475a");
    // A vivid first candidate is used as is.
    expect(pickActionColor(["#bd93f9", "#6272a4"], "#282a36", "#44475a")).toBe("#bd93f9");
  });
});

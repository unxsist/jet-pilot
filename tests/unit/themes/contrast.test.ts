import { describe, expect, it } from "vitest";
import {
  contrastRatio,
  parseColor,
  toHex,
  toHexAlpha,
  toHslTriplet,
  tripletToHex,
} from "@/lib/themes/contrast";
import { ensureContrast, readableForeground } from "@/lib/themes/derive";

describe("colour parsing", () => {
  it("parses hex, functions and named colours", () => {
    expect(toHex("#ABC")).toBe("#aabbcc");
    expect(toHex("rgb(255 0 0)")).toBe("#ff0000");
    expect(toHex("hsl(240 5% 6.5%)")).toBe("#101011");
    expect(toHex("rebeccapurple")).toBe("#663399");
    expect(toHex("oklch(1 0 0)")).toBe("#ffffff");
    expect(toHex("color(display-p3 1 0 0)")).toBe("#ff0000");
    expect(parseColor("not a colour")).toBeNull();
    expect(parseColor(42)).toBeNull();
  });

  it("keeps alpha in toHexAlpha only", () => {
    expect(toHexAlpha("#615aed4d")).toBe("#615aed4d");
    expect(toHexAlpha("rgba(97, 90, 237, 0.35)")).toBe("#615aed59");
    expect(toHexAlpha("#615aed")).toBe("#615aed");
    expect(toHex("#615aed4d")).toBe("#615aed");
    expect(parseColor("oklch(0.5 0.1 200 / none)")?.a).toBe(0);
  });

  it("formats HSL triplets like main.postcss", () => {
    expect(toHslTriplet("#ffffff")).toBe("0 0% 100%");
    expect(toHslTriplet("#000000")).toBe("0 0% 0%");
    expect(toHslTriplet("#101011")).toBe("240 3% 6.5%");
    expect(toHslTriplet("hsl(243 75% 59%)")).toBe("243 75% 59%");
    expect(toHslTriplet("#5048e5")).toBe("243 75.1% 59%");
    expect(tripletToHex("0 0% 100%")).toBe("#ffffff");
  });
});

describe("contrast", () => {
  it("computes WCAG ratios", () => {
    expect(contrastRatio("#000", "#fff")).toBeCloseTo(21, 5);
    expect(contrastRatio("#fff", "#fff")).toBe(1);
    expect(contrastRatio("#777", "#fff")).toBeCloseTo(4.48, 2);
  });

  it("solves a foreground up to the minimum, keeping readable ones", () => {
    expect(ensureContrast("#e4e4e8", "#101011", 4.5)).toBe("#e4e4e8");
    const solved = ensureContrast("#7aa2f7", "#ffffff", 4.5);
    expect(contrastRatio(solved, "#ffffff")).toBeGreaterThanOrEqual(4.5);
    // Mid-grey backgrounds fall back to black or white.
    expect(contrastRatio(ensureContrast("#777777", "#767676", 4.5), "#767676")).toBeGreaterThanOrEqual(4.5);
  });

  it("picks the most readable candidate", () => {
    expect(readableForeground("#ff6467", ["#101011", "#e4e4e8"])).toBe("#101011");
    expect(readableForeground("#808080", ["#7f7f7f"])).toMatch(/^#(000000|ffffff)$/);
  });
});

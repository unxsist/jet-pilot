/*
 * Colour primitives of the theme engine: parsing any CSS colour, hex and
 * HSL-triplet output, compositing and WCAG contrast. Everything works on
 * sRGB channels in 0–255 so contrast is measured on the exact pixels a
 * theme paints (the hex values the resolver hands out).
 *
 * Contrast maths ported from T3 Code (MIT, github.com/pingdotgg/t3code,
 * apps/web/src/themePalette.ts).
 */
import {
  converter,
  modeHsl,
  modeHwb,
  modeLab,
  modeLch,
  modeLrgb,
  modeOklab,
  modeOklch,
  modeP3,
  modeRgb,
  parse,
  useMode,
} from "culori/fn";

// culori/fn is tree-shakeable: only the colour spaces CSS themes use in
// practice are registered (hex / named / rgb() come with modeRgb).
useMode(modeRgb);
useMode(modeLrgb);
useMode(modeHsl);
useMode(modeHwb);
useMode(modeLab);
useMode(modeLch);
useMode(modeOklab);
useMode(modeOklch);
useMode(modeP3);

const toRgbSpace = converter("rgb");

/** sRGB channels in 0–255 (not rounded). */
export interface Rgb {
  r: number;
  g: number;
  b: number;
}

export interface Rgba extends Rgb {
  /** 0–1 */
  a: number;
}

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

/** Parses any CSS colour culori understands; null when it isn't one. */
export function parseColor(value: unknown): Rgba | null {
  if (typeof value !== "string") return null;
  const input = value.trim();
  if (!input || input.length > 128) return null;
  const parsed = parse(input);
  if (!parsed) return null;
  const rgb = toRgbSpace(parsed);
  if (!rgb) return null;
  // culori drops a `none` alpha; CSS treats it as 0 outside interpolation.
  const alpha = /\/\s*none\s*\)$/i.test(input) ? 0 : rgb.alpha ?? 1;
  const channels = [rgb.r, rgb.g, rgb.b, alpha];
  if (!channels.every((channel) => Number.isFinite(channel ?? 0))) return null;
  // Out-of-gamut colours (display-p3, oklch) clip to the sRGB edge, which is
  // what an sRGB screen shows anyway.
  return {
    r: clamp(rgb.r ?? 0, 0, 1) * 255,
    g: clamp(rgb.g ?? 0, 0, 1) * 255,
    b: clamp(rgb.b ?? 0, 0, 1) * 255,
    a: clamp(alpha, 0, 1),
  };
}

export const isColor = (value: unknown): value is string =>
  parseColor(value) !== null;

/** Parses a colour and flattens its alpha over `base`; throws when invalid. */
export function rgbOf(color: string, base?: Rgb): Rgb {
  const parsed = parseColor(color);
  if (!parsed) throw new Error(`"${color}" is not a valid colour.`);
  return base ? flattenOver(parsed, base) : parsed;
}

const channelHex = (value: number) =>
  Math.round(clamp(value, 0, 255))
    .toString(16)
    .padStart(2, "0");

export const rgbToHex = (color: Rgb): string =>
  `#${channelHex(color.r)}${channelHex(color.g)}${channelHex(color.b)}`;

/** Rounds to the 8-bit channels a hex colour can carry. */
export const roundRgb = (color: Rgb): Rgb => ({
  r: Math.round(clamp(color.r, 0, 255)),
  g: Math.round(clamp(color.g, 0, 255)),
  b: Math.round(clamp(color.b, 0, 255)),
});

/** "#rrggbb" (alpha is dropped); throws when the colour can't be parsed. */
export function toHex(color: string): string {
  return rgbToHex(rgbOf(color));
}

/** "#rrggbb", or "#rrggbbaa" when the colour is translucent. */
export function toHexAlpha(color: string): string {
  const parsed = parseColor(color);
  if (!parsed) throw new Error(`"${color}" is not a valid colour.`);
  const hex = rgbToHex(parsed);
  return parsed.a >= 1 ? hex : `${hex}${channelHex(parsed.a * 255)}`;
}

/** `color` composited onto an opaque `base`. */
export function flattenOver(color: Rgba, base: Rgb): Rgb {
  if (color.a >= 1) return { r: color.r, g: color.g, b: color.b };
  return mixRgb(base, color, color.a);
}

/** Linear sRGB-space mix: amount 0 = `from`, 1 = `to`. */
export function mixRgb(from: Rgb, to: Rgb, amount: number): Rgb {
  return {
    r: from.r + (to.r - from.r) * amount,
    g: from.g + (to.g - from.g) * amount,
    b: from.b + (to.b - from.b) * amount,
  };
}

/** Hex mix of two colours (see mixRgb). */
export const mix = (from: string, to: string, amount: number): string =>
  rgbToHex(mixRgb(rgbOf(from), rgbOf(to), amount));

/** `color` with an alpha byte appended ("#rrggbb" → "#rrggbbaa"). */
export const withAlpha = (color: string, alpha: number): string =>
  `${toHex(color)}${channelHex(alpha * 255)}`;

export function relativeLuminance(color: Rgb): number {
  const linearize = (channel: number) => {
    const normalized = channel / 255;
    return normalized <= 0.03928
      ? normalized / 12.92
      : ((normalized + 0.055) / 1.055) ** 2.4;
  };
  return (
    0.2126 * linearize(color.r) +
    0.7152 * linearize(color.g) +
    0.0722 * linearize(color.b)
  );
}

/**
 * 0.179 is the luminance where white and black text have equal contrast
 * headroom, so it splits "dark" from "light" backgrounds.
 */
export const isDarkRgb = (color: Rgb) => relativeLuminance(color) < 0.179;

export const isDark = (color: string) => isDarkRgb(rgbOf(color));

export function contrastRgb(first: Rgb, second: Rgb): number {
  const a = relativeLuminance(first);
  const b = relativeLuminance(second);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/** WCAG contrast ratio (1–21) of two opaque colours. */
export function contrastRatio(a: string, b: string): number {
  return contrastRgb(rgbOf(a), rgbOf(b));
}

const round = (value: number, decimals: number) => {
  const factor = 10 ** decimals;
  const rounded = Math.round(value * factor) / factor;
  return Object.is(rounded, -0) ? 0 : rounded;
};

/**
 * The bare HSL triplet the design tokens use ("240 5% 6.5%"): hue in whole
 * degrees, saturation and lightness to one decimal. Alpha is dropped.
 */
export function toHslTriplet(color: string): string {
  const { r, g, b } = rgbOf(color);
  const [rn, gn, bn] = [r / 255, g / 255, b / 255];
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const lightness = (max + min) / 2;
  const delta = max - min;
  let hue = 0;
  let saturation = 0;
  if (delta > 0) {
    saturation = delta / (1 - Math.abs(2 * lightness - 1));
    if (max === rn) hue = ((gn - bn) / delta) % 6;
    else if (max === gn) hue = (bn - rn) / delta + 2;
    else hue = (rn - gn) / delta + 4;
    hue = (hue * 60 + 360) % 360;
  }
  const h = round(hue, 0) % 360;
  const s = round(clamp(saturation, 0, 1) * 100, 1);
  const l = round(lightness * 100, 1);
  return `${s === 0 ? 0 : h} ${s}% ${l}%`;
}

/** Parses a "H S% L%" triplet back to hex (used for the JET tokens). */
export function tripletToHex(triplet: string): string {
  return toHex(`hsl(${triplet.trim().split(/\s+/).join(" ")})`);
}

/** Matches the token triplets of main.postcss. */
export const TRIPLET_PATTERN =
  /^\d{1,3}(?:\.\d+)? \d{1,3}(?:\.\d+)?% \d{1,3}(?:\.\d+)?%$/;

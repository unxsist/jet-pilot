/*
 * Palette derivation: fills every role a theme leaves out from its own
 * canvas and accent, then makes sure every foreground stays readable on
 * the surface it sits on.
 *
 * The vivid generator (createVividThemeColors), the OKLCH maths and the
 * contrast solver are ported from T3 Code (MIT, github.com/pingdotgg/t3code,
 * apps/web/src/themePalette.ts); the output is hex instead of oklch() so
 * the contrast guarantees hold for the exact pixels painted. JET Pilot's
 * own roles (success / info) are derived the same way: a fixed hue solved
 * for text contrast on the canvas.
 */
import {
  type Rgb,
  contrastRgb,
  flattenOver,
  isDarkRgb,
  mixRgb,
  parseColor,
  relativeLuminance,
  rgbToHex,
  roundRgb,
} from "./contrast";
import {
  type JetColorRole,
  type ThemeAppearance,
  type ThemeColorRole,
  JET_COLOR_ROLES,
  THEME_COLOR_ROLES,
} from "./types";

export type ThemeRoles = Record<ThemeColorRole | JetColorRole, string>;
type Oklch = { L: number; C: number; h: number };

/** Seeds used when a theme names neither canvas nor accent (JET's own). */
export const DEFAULT_SEEDS: Record<
  ThemeAppearance,
  { canvas: string; accent: string }
> = {
  light: { canvas: "#ffffff", accent: "#5048e5" },
  dark: { canvas: "#101011", accent: "#7b75f2" },
};

/* ---- OKLCH (T3 Code) ---- */

const srgbToLinear = (channel: number) => {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};

const linearToSrgb = (channel: number) => {
  const c =
    channel <= 0.0031308 ? channel * 12.92 : 1.055 * channel ** (1 / 2.4) - 0.055;
  return Math.round(Math.min(1, Math.max(0, c)) * 255);
};

export function rgbToOklch(color: Rgb): Oklch {
  const r = srgbToLinear(color.r);
  const g = srgbToLinear(color.g);
  const b = srgbToLinear(color.b);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return { L, C: Math.hypot(a, bb), h: (Math.atan2(bb, a) * 180) / Math.PI };
}

function oklchToLinear({ L, C, h }: Oklch): Rgb {
  const hr = (h * Math.PI) / 180;
  const a = C * Math.cos(hr);
  const bb = C * Math.sin(hr);
  const l = (L + 0.3963377774 * a + 0.2158037573 * bb) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * bb) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * bb) ** 3;
  return {
    r: 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    g: -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    b: -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  };
}

/** The greatest chroma at the same lightness and hue that fits in sRGB. */
function mapToGamut(color: Oklch): Oklch {
  const inGamut = (C: number) => {
    const linear = oklchToLinear({ ...color, C });
    return [linear.r, linear.g, linear.b].every(
      (channel) => channel >= -0.0001 && channel <= 1.0001
    );
  };
  if (inGamut(color.C)) return color;
  let low = 0;
  let high = color.C;
  const resolution = 0.000001;
  const steps = Math.max(
    1,
    Math.ceil(Math.log2(Math.max(color.C, resolution)) - Math.log2(resolution))
  );
  for (let step = 0; step < steps; step += 1) {
    const mid = (low + high) / 2;
    if (inGamut(mid)) low = mid;
    else high = mid;
  }
  return { ...color, C: low };
}

/** 8-bit sRGB after gamut mapping. */
export function oklchToRgb(color: Oklch): Rgb {
  const linear = oklchToLinear(mapToGamut(color));
  return {
    r: linearToSrgb(linear.r),
    g: linearToSrgb(linear.g),
    b: linearToSrgb(linear.b),
  };
}

const oklchHex = (color: Oklch) => rgbToHex(oklchToRgb(color));

/** Binary-searches the lightness that reaches `minContrast` against a background. */
export function solveOklchLightness(
  base: Oklch,
  against: Rgb,
  minContrast: number,
  direction: "lighter" | "darker"
): Oklch {
  let low = direction === "lighter" ? base.L : 0;
  let high = direction === "lighter" ? 1 : base.L;
  let candidate = { ...base };
  if (contrastRgb(oklchToRgb(candidate), against) >= minContrast) return candidate;
  for (let step = 0; step < 18; step += 1) {
    const mid = (low + high) / 2;
    candidate = { ...base, L: mid };
    if (contrastRgb(oklchToRgb(candidate), against) >= minContrast) {
      if (direction === "lighter") high = mid;
      else low = mid;
    } else if (direction === "lighter") low = mid;
    else high = mid;
  }
  return { ...base, L: direction === "lighter" ? high : low };
}

/* ---- readable foregrounds ---- */

const WHITE: Rgb = { r: 255, g: 255, b: 255 };
const BLACK: Rgb = { r: 0, g: 0, b: 0 };
const LIGHT_FOREGROUND: Rgb = { r: 255, g: 250, b: 255 };
const DARK_FOREGROUND: Rgb = { r: 36, g: 21, b: 35 };

const hexRgb = (hex: string): Rgb => parseColor(hex) ?? BLACK;

/** Black or white, whichever reads better on `background`. */
const extremeOn = (background: Rgb) =>
  contrastRgb(background, WHITE) >= contrastRgb(background, BLACK) ? WHITE : BLACK;

/**
 * `foreground` when it already reaches `min` on `background`; otherwise
 * its lightness is moved (hue kept) until it does, and as a last resort
 * black or white.
 */
export function ensureContrast(
  foreground: string,
  background: string,
  min: number
): string {
  const fg = hexRgb(foreground);
  const bg = hexRgb(background);
  if (contrastRgb(fg, bg) >= min) return foreground;
  const solved = oklchToRgb(
    solveOklchLightness(rgbToOklch(fg), bg, min, isDarkRgb(bg) ? "lighter" : "darker")
  );
  if (contrastRgb(solved, bg) >= min) return rgbToHex(solved);
  return rgbToHex(extremeOn(bg));
}

/** The first candidate with the best contrast on `background`, at least 4.5:1. */
export function readableForeground(background: string, candidates: string[]): string {
  const bg = hexRgb(background);
  let best = rgbToHex(extremeOn(bg));
  let bestRatio = 0;
  for (const candidate of candidates) {
    const ratio = contrastRgb(hexRgb(candidate), bg);
    if (ratio > bestRatio) {
      best = candidate;
      bestRatio = ratio;
    }
  }
  return bestRatio >= 4.5 ? best : rgbToHex(extremeOn(bg));
}

/* ---- the vivid generator (T3 Code) ---- */

function readableThemeForeground(background: Rgb): Rgb {
  const light = contrastRgb(background, LIGHT_FOREGROUND);
  const dark = contrastRgb(background, DARK_FOREGROUND);
  if (Math.max(light, dark) >= 4.5) return light >= dark ? LIGHT_FOREGROUND : DARK_FOREGROUND;
  return extremeOn(background);
}

/** The quietest mix of `foreground` toward `background` that still reaches `min`. */
function readableThemeText(
  background: Rgb,
  foreground: Rgb,
  amount: number,
  min: number
): Rgb {
  const softened = roundRgb(mixRgb(foreground, background, amount));
  if (contrastRgb(softened, background) >= min) return softened;
  let readable = foreground;
  let lower = 0;
  let upper = amount;
  for (let index = 0; index < 12; index += 1) {
    const candidateAmount = (lower + upper) / 2;
    const candidate = roundRgb(mixRgb(foreground, background, candidateAmount));
    if (contrastRgb(candidate, background) >= min) {
      readable = candidate;
      lower = candidateAmount;
    } else upper = candidateAmount;
  }
  return readable;
}

// The measured contrast of the stock muted text in T3 Code (zinc-500 on the
// light canvas, #818181 on the dark one), so derived muted text feels the same.
const STANDARD_LIGHT_MUTED_CONTRAST = 4.705;
const STANDARD_DARK_MUTED_CONTRAST = 5.082;

const standardMutedText = (background: Rgb, foreground: Rgb) =>
  readableThemeText(
    background,
    foreground,
    1,
    isDarkRgb(background) ? STANDARD_DARK_MUTED_CONTRAST : STANDARD_LIGHT_MUTED_CONTRAST
  );

/**
 * The standard red / amber status colours, so a generated palette never
 * inherits a brand tint on destructive buttons and warnings.
 */
const STANDARD_STATUS_COLORS = {
  light: {
    error: "#fb2c36",
    errorForeground: "#c10007",
    warning: "#fe9a00",
    warningForeground: "#bb4d00",
  },
  dark: {
    error: "#fb414a",
    errorForeground: "#ff6467",
    warning: "#fe9a00",
    warningForeground: "#ffb900",
  },
} as const;

/** Status surfaces are the status colour laid over the canvas (8% / 16%). */
function standardStatusColors(canvas: Rgb) {
  const dark = isDarkRgb(canvas);
  const standard = STANDARD_STATUS_COLORS[dark ? "dark" : "light"];
  const surfaceOf = (value: string) => mixRgb(canvas, hexRgb(value), dark ? 0.16 : 0.08);
  // Tuned for the stock canvas; nudged on tinted ones until they clear 4.6.
  const readableOn = (foreground: string, surface: Rgb) =>
    oklchHex(
      solveOklchLightness(
        rgbToOklch(hexRgb(foreground)),
        roundRgb(surface),
        4.6,
        dark ? "lighter" : "darker"
      )
    );
  const errorSurface = surfaceOf(standard.error);
  const warningSurface = surfaceOf(standard.warning);
  return {
    error: standard.error,
    errorForeground: readableOn(standard.errorForeground, errorSurface),
    errorSurface: rgbToHex(errorSurface),
    warning: standard.warning,
    warningForeground: readableOn(standard.warningForeground, warningSurface),
    warningSurface: rgbToHex(warningSurface),
  };
}

/**
 * Derives a full palette from two seed colours, in OKLCH. Surfaces climb a
 * perceptually even lightness ramp carrying the accent hue at low chroma, a
 * companion action colour is rotated off the accent, and every foreground
 * is contrast-solved against its own surface. Light vs dark follows the
 * canvas itself, so a dark canvas in a "light" file still gets light text.
 */
export function createVividThemeColors(
  canvasValue: string,
  accentValue: string
): Record<ThemeColorRole, string> {
  const canvasRgb = roundRgb(hexRgb(canvasValue));
  const accentRgb = roundRgb(hexRgb(accentValue));
  const canvas = rgbToOklch(canvasRgb);
  const accent = rgbToOklch(accentRgb);
  const dark = isDarkRgb(canvasRgb);
  const hue = accent.C < 0.02 ? canvas.h : accent.h;
  const tintC = Math.min(0.045, Math.max(0.008, accent.C * 0.22));
  const step = dark ? 1 : -1;

  const surfaceAt = (deltaL: number, chroma = tintC): Oklch => ({
    L: Math.min(0.98, Math.max(0.05, canvas.L + step * deltaL)),
    C: chroma,
    h: hue,
  });
  const hex = oklchHex;
  const hexRgbOf = (color: Rgb) => rgbToHex(color);

  // Text carries a whisper of the accent hue and is solved to WCAG AAA.
  const textBase: Oklch = {
    L: dark ? 0.95 : 0.2,
    C: Math.min(0.035, accent.C * 0.25),
    h: hue,
  };
  const textRgb = oklchToRgb(
    solveOklchLightness(textBase, canvasRgb, 7, dark ? "lighter" : "darker")
  );
  const textMutedRgb = standardMutedText(canvasRgb, textRgb);

  // The companion action rotates off the accent for a two-voice palette.
  const action: Oklch = {
    L: Math.min(0.85, Math.max(0.35, accent.L + (dark ? 0.06 : -0.02))),
    C: Math.max(accent.C * 0.9, 0.06),
    h: (hue + 50) % 360,
  };
  const actionRgb = oklchToRgb(action);

  const sidebar = oklchToRgb(surfaceAt(0.045, tintC * 1.4));
  const surfaceRaised = oklchToRgb(surfaceAt(0.05));
  const secondary = oklchToRgb(surfaceAt(dark ? 0.1 : 0.06, Math.min(0.09, accent.C * 0.5)));
  const muted = oklchToRgb(surfaceAt(dark ? 0.06 : 0.04, Math.min(0.06, accent.C * 0.35)));
  const accentSurface = oklchToRgb(
    surfaceAt(dark ? 0.13 : 0.08, Math.min(0.11, accent.C * 0.55))
  );
  const messageSurface = oklchToRgb(
    surfaceAt(dark ? 0.16 : 0.1, Math.min(0.13, accent.C * 0.6))
  );
  const updateSurface = oklchToRgb(
    surfaceAt(dark ? 0.14 : 0.09, Math.min(0.12, accent.C * 0.55))
  );

  const foregroundOn = (surface: Rgb) =>
    hex(solveOklchLightness(textBase, surface, 4.6, dark ? "lighter" : "darker"));
  const actionHover: Oklch = {
    ...rgbToOklch(actionRgb),
    L: rgbToOklch(actionRgb).L + (dark ? 0.06 : -0.06),
  };
  const canvasHex = hexRgbOf(canvasRgb);
  const textHex = hexRgbOf(textRgb);
  const textMutedHex = hexRgbOf(textMutedRgb);
  const accentHex = hexRgbOf(accentRgb);

  return {
    ...standardStatusColors(canvasRgb),
    canvas: canvasHex,
    // The top bar shares the canvas so the main panel reads as one surface.
    chrome: canvasHex,
    toolbar: canvasHex,
    toolbarForeground: textHex,
    toolbarBorder: hex(surfaceAt(dark ? 0.14 : 0.1, Math.min(0.08, accent.C * 0.4))),
    toolbarControl: hex(surfaceAt(dark ? 0.09 : 0.05, tintC * 1.3)),
    toolbarControlForeground: textHex,
    toolbarControlHover: hex(surfaceAt(dark ? 0.14 : 0.09, tintC * 1.6)),
    surface: hex(surfaceAt(0.015)),
    surfaceRaised: hexRgbOf(surfaceRaised),
    surfaceOverlay: hex(surfaceAt(0.075)),
    text: textHex,
    textMuted: textMutedHex,
    border: hex(surfaceAt(dark ? 0.16 : 0.12, Math.min(0.07, accent.C * 0.35))),
    input: hex(surfaceAt(dark ? 0.21 : 0.16, Math.min(0.08, accent.C * 0.4))),
    focus: accentHex,
    accent: accentHex,
    accentForeground: hexRgbOf(readableThemeForeground(accentRgb)),
    secondary: hexRgbOf(secondary),
    secondaryForeground: foregroundOn(secondary),
    muted: hexRgbOf(muted),
    mutedForeground: hexRgbOf(readableThemeText(muted, textRgb, 1, 4.6)),
    placeholder: hexRgbOf(readableThemeText(surfaceRaised, textRgb, 1, 4.6)),
    secondaryLabel: textMutedHex,
    iconMuted: textMutedHex,
    update: accentHex,
    updateForeground: foregroundOn(updateSurface),
    updateSurface: hexRgbOf(updateSurface),
    accentSurface: hexRgbOf(accentSurface),
    accentSurfaceForeground: foregroundOn(accentSurface),
    messageSurface: hexRgbOf(messageSurface),
    messageForeground: foregroundOn(messageSurface),
    messageAction: hexRgbOf(actionRgb),
    messageActionForeground: hexRgbOf(readableThemeForeground(actionRgb)),
    messageActionHover: hex(actionHover),
    codeBackground: hex(surfaceAt(0.035, tintC * 0.8)),
    codeForeground: textHex,
    sidebar: hexRgbOf(sidebar),
    sidebarForeground: foregroundOn(sidebar),
    sidebarMutedForeground: hexRgbOf(standardMutedText(sidebar, textRgb)),
    sidebarControlSurface: hex(surfaceAt(dark ? 0.1 : 0.07, tintC * 1.5)),
    sidebarRowHover: hex(surfaceAt(dark ? 0.08 : 0.06, Math.min(0.08, accent.C * 0.45))),
    sidebarRowActive: hex(surfaceAt(dark ? 0.12 : 0.09, Math.min(0.1, accent.C * 0.55))),
    sidebarRowSelected: hex(surfaceAt(dark ? 0.14 : 0.1, Math.min(0.11, accent.C * 0.6))),
    sidebarBorder: hex(surfaceAt(dark ? 0.17 : 0.12, Math.min(0.08, accent.C * 0.4))),
    terminalBackground: canvasHex,
    terminalForeground: textHex,
    terminalCursor: accentHex,
    terminalSelection: hex(surfaceAt(dark ? 0.18 : 0.12, Math.min(0.12, accent.C * 0.55))),
    terminalScrollbar: hex(surfaceAt(dark ? 0.22 : 0.16, tintC)),
    terminalScrollbarHover: hex(surfaceAt(dark ? 0.3 : 0.22, tintC)),
  };
}

/* ---- JET roles ---- */

/** OKLCH hues of the derived status colours (JET's green / blue). */
const SUCCESS_HUE = 155;
const INFO_HUE = 250;

/** A text-grade colour of `hue`: readable (4.6:1) on the canvas. */
export function deriveStatusColor(hue: number, canvas: string): string {
  const canvasRgb = hexRgb(canvas);
  const dark = isDarkRgb(canvasRgb);
  const base: Oklch = { L: dark ? 0.72 : 0.55, C: 0.15, h: hue };
  return oklchHex(solveOklchLightness(base, canvasRgb, 4.6, dark ? "lighter" : "darker"));
}

/* ---- completion + contrast fixes ---- */

/**
 * Foreground / surface pairs and their minimum contrast. JET's status roles
 * are text-grade (readable on the canvas, like the --success token) and
 * their *Foreground is the text on a solid fill of that colour.
 */
export const CONTRAST_PAIRS: [ThemeColorRole | JetColorRole, ThemeColorRole | JetColorRole, number][] = [
  ["text", "canvas", 7],
  ["textMuted", "canvas", 4.5],
  ["secondaryLabel", "canvas", 4.5],
  ["iconMuted", "canvas", 3],
  ["toolbarForeground", "toolbar", 4.5],
  ["toolbarControlForeground", "toolbarControl", 4.5],
  ["accentForeground", "accent", 4.5],
  ["secondaryForeground", "secondary", 4.5],
  ["mutedForeground", "muted", 4.5],
  ["placeholder", "surfaceRaised", 4.5],
  ["errorForeground", "errorSurface", 4.5],
  ["warningForeground", "warningSurface", 4.5],
  ["updateForeground", "updateSurface", 4.5],
  ["accentSurfaceForeground", "accentSurface", 4.5],
  ["messageForeground", "messageSurface", 4.5],
  ["messageActionForeground", "messageAction", 4.5],
  ["codeForeground", "codeBackground", 4.5],
  ["sidebarForeground", "sidebar", 4.5],
  ["sidebarMutedForeground", "sidebar", 4.5],
  ["terminalForeground", "terminalBackground", 4.5],
  ["success", "canvas", 4.5],
  ["info", "canvas", 4.5],
  ["successForeground", "success", 4.5],
  ["infoForeground", "info", 4.5],
];

export interface RoleInput {
  canvas?: string;
  accent?: string;
  /** Explicit T3 + JET roles (any CSS colour; alpha is flattened over the canvas). */
  colors?: Partial<Record<ThemeColorRole | JetColorRole, string>>;
}

/**
 * Every T3 + JET role as #rrggbb: the vivid palette derived from the seeds,
 * the explicit roles on top, then the contrast fixes of CONTRAST_PAIRS.
 */
export function completeRoles(appearance: ThemeAppearance, input: RoleInput): ThemeRoles {
  const colors = input.colors ?? {};
  const backdrop = appearance === "dark" ? BLACK : WHITE;
  const opaque = (value: string | undefined, base: Rgb): string | undefined => {
    const parsed = value === undefined ? null : parseColor(value);
    return parsed ? rgbToHex(flattenOver(parsed, base)) : undefined;
  };

  // `colors` is layered over the seeds (T3), so an explicit canvas role wins.
  const canvas =
    opaque(colors.canvas, backdrop) ??
    opaque(input.canvas, backdrop) ??
    DEFAULT_SEEDS[appearance].canvas;
  const canvasRgb = hexRgb(canvas);
  const accent =
    opaque(colors.accent, canvasRgb) ??
    opaque(input.accent, canvasRgb) ??
    opaque(colors.focus, canvasRgb) ??
    DEFAULT_SEEDS[appearance].accent;

  const roles = {
    ...createVividThemeColors(canvas, accent),
    canvas,
    accent,
  } as ThemeRoles;
  const explicit = new Set<string>();
  for (const role of [...THEME_COLOR_ROLES, ...JET_COLOR_ROLES]) {
    if (role === "canvas" || role === "accent") continue;
    const value = opaque(colors[role], canvasRgb);
    if (value) {
      roles[role] = value;
      explicit.add(role);
    }
  }

  if (!explicit.has("success")) roles.success = deriveStatusColor(SUCCESS_HUE, canvas);
  if (!explicit.has("info")) roles.info = deriveStatusColor(INFO_HUE, canvas);

  for (const [foreground, background, min] of CONTRAST_PAIRS) {
    if (
      (foreground === "successForeground" || foreground === "infoForeground") &&
      !explicit.has(foreground)
    ) {
      roles[foreground] = readableForeground(roles[background], [roles.canvas, roles.text]);
      continue;
    }
    roles[foreground] = ensureContrast(roles[foreground], roles[background], min);
  }
  return roles;
}

/** Relative luminance of a colour string (0 when it can't be parsed). */
export const luminanceOf = (color: string) => relativeLuminance(hexRgb(color));

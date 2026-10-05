/*
 * The built-in JET theme: today's look, pixel for pixel. The token triplets
 * mirror src/assets/main.postcss (`:root,.light` and `.dark`) and are carried
 * as `jetPilot.tokens`, so resolving JET reproduces the stylesheet exactly;
 * the editor and terminal colours are JET's Monaco / xterm palettes. The
 * standard roles are mapped from the same tokens, so the portable export
 * and theme previews show JET too. (The runtime clears inline vars for JET and lets
 * main.postcss paint; a test keeps this file and the stylesheet in sync.)
 */
import { mix, tripletToHex } from "../contrast";
import { JET_EDITOR_COLORS, JET_SYNTAX } from "../monacoTheme";
import type {
  AnsiColor,
  ThemeAppearance,
  ThemeColors,
  ThemeFile,
  ThemeToken,
  ThemeVariant,
} from "../types";
import { ANSI_COLORS } from "../types";
import { JET_XTERM } from "../xtermTheme";

export const JET_TOKENS: Record<ThemeAppearance, Record<ThemeToken, string>> = {
  light: {
    background: "0 0% 100%",
    foreground: "240 10% 8%",
    "surface-1": "240 5% 96.5%",
    "surface-2": "0 0% 100%",
    "surface-3": "0 0% 100%",
    muted: "240 5% 96%",
    "muted-foreground": "240 4% 42%",
    accent: "240 5% 94%",
    "accent-foreground": "240 10% 8%",
    secondary: "240 5% 94.5%",
    "secondary-foreground": "240 10% 8%",
    "sidebar-foreground": "240 6% 22%",
    border: "240 6% 90%",
    "border-subtle": "240 6% 93.5%",
    "border-strong": "240 5% 82%",
    input: "240 6% 86%",
    ring: "243 75% 59%",
    primary: "243 75% 59%",
    "primary-foreground": "0 0% 100%",
    link: "243 70% 53%",
    success: "152 76% 27%",
    "success-foreground": "0 0% 100%",
    warning: "28 90% 35%",
    "warning-foreground": "0 0% 100%",
    destructive: "0 72% 46%",
    "destructive-foreground": "0 0% 100%",
    info: "215 85% 44%",
    "info-foreground": "0 0% 100%",
    tooltip: "240 10% 10%",
    "tooltip-foreground": "0 0% 98%",
    overlay: "240 10% 8%",
    selection: "243 75% 59%",
    scrollbar: "240 5% 80%",
    "scrollbar-hover": "240 4% 64%",
  },
  dark: {
    background: "240 5% 6.5%",
    foreground: "240 6% 93%",
    "surface-1": "240 5% 8.5%",
    "surface-2": "240 5% 10%",
    "surface-3": "240 5% 12%",
    muted: "240 4% 14%",
    "muted-foreground": "240 5% 62%",
    accent: "240 4% 16%",
    "accent-foreground": "240 6% 96%",
    secondary: "240 4% 15%",
    "secondary-foreground": "240 6% 93%",
    "sidebar-foreground": "240 5% 82%",
    border: "240 4% 17%",
    "border-subtle": "240 4% 13%",
    "border-strong": "240 4% 25%",
    input: "240 4% 21%",
    ring: "243 85% 68%",
    primary: "243 80% 64%",
    "primary-foreground": "0 0% 100%",
    link: "240 90% 76%",
    success: "152 58% 50%",
    "success-foreground": "152 60% 6%",
    warning: "38 92% 58%",
    "warning-foreground": "38 80% 7%",
    destructive: "0 84% 67%",
    "destructive-foreground": "0 50% 8%",
    info: "212 92% 65%",
    "info-foreground": "212 80% 8%",
    tooltip: "240 5% 18%",
    "tooltip-foreground": "240 6% 96%",
    overlay: "0 0% 0%",
    selection: "243 85% 68%",
    scrollbar: "240 4% 24%",
    "scrollbar-hover": "240 4% 36%",
  },
};

/** JET's tokens expressed as standard roles (for exports and previews). */
function jetVariant(appearance: ThemeAppearance): ThemeVariant {
  const tokens = JET_TOKENS[appearance];
  const hex = (token: ThemeToken) => tripletToHex(tokens[token]);
  const xterm = JET_XTERM[appearance];
  const statusSurface = (token: ThemeToken) =>
    mix(hex("background"), hex(token), appearance === "dark" ? 0.16 : 0.08);

  const colors: ThemeColors = {
    canvas: hex("background"),
    chrome: hex("surface-1"),
    toolbar: hex("surface-1"),
    toolbarForeground: hex("foreground"),
    toolbarBorder: hex("border"),
    toolbarControl: hex("surface-2"),
    toolbarControlForeground: hex("foreground"),
    toolbarControlHover: hex("accent"),
    surface: hex("surface-2"),
    surfaceRaised: hex("surface-2"),
    surfaceOverlay: hex("surface-3"),
    text: hex("foreground"),
    textMuted: hex("muted-foreground"),
    border: hex("border"),
    input: hex("input"),
    focus: hex("ring"),
    accent: hex("primary"),
    accentForeground: hex("primary-foreground"),
    secondary: hex("secondary"),
    secondaryForeground: hex("secondary-foreground"),
    muted: hex("muted"),
    mutedForeground: hex("muted-foreground"),
    placeholder: hex("muted-foreground"),
    secondaryLabel: hex("muted-foreground"),
    iconMuted: hex("muted-foreground"),
    error: hex("destructive"),
    errorForeground: hex("destructive"),
    errorSurface: statusSurface("destructive"),
    warning: hex("warning"),
    warningForeground: hex("warning"),
    warningSurface: statusSurface("warning"),
    update: hex("primary"),
    updateForeground: hex("link"),
    updateSurface: statusSurface("primary"),
    accentSurface: hex("accent"),
    accentSurfaceForeground: hex("accent-foreground"),
    messageSurface: hex("accent"),
    messageForeground: hex("foreground"),
    messageAction: hex("primary"),
    messageActionForeground: hex("primary-foreground"),
    messageActionHover: hex("ring"),
    codeBackground: hex("surface-2"),
    codeForeground: hex("foreground"),
    sidebar: hex("surface-1"),
    sidebarForeground: hex("sidebar-foreground"),
    sidebarMutedForeground: hex("muted-foreground"),
    sidebarControlSurface: hex("accent"),
    sidebarRowHover: hex("accent"),
    sidebarRowActive: hex("accent"),
    sidebarRowSelected: hex("accent"),
    sidebarBorder: hex("border"),
    terminalBackground: xterm.background,
    terminalForeground: xterm.foreground,
    terminalCursor: xterm.cursor,
    terminalSelection: mix(xterm.background, hex("primary"), 0.35),
    terminalScrollbar: hex("scrollbar"),
    terminalScrollbarHover: hex("scrollbar-hover"),
  };

  const syntax = JET_SYNTAX[appearance];
  return {
    colors,
    jetPilot: {
      colors: {
        success: hex("success"),
        successForeground: hex("success-foreground"),
        info: hex("info"),
        infoForeground: hex("info-foreground"),
      },
      terminal: Object.fromEntries(
        ANSI_COLORS.map((color: AnsiColor) => [color, xterm[color]])
      ),
      syntax: Object.fromEntries(
        Object.entries(syntax).map(([slot, color]) => [slot, `#${color}`])
      ),
      editor: {
        ...JET_EDITOR_COLORS[appearance],
        "terminal.selectionBackground": xterm.selectionBackground,
      },
      tokens: { ...tokens },
    },
  };
}

export const JET_THEME_ID = "jet";

export const JET_THEME: ThemeFile = {
  version: 1,
  id: JET_THEME_ID,
  name: "JET",
  appearance: "light",
  ...jetVariant("light"),
  variants: { dark: jetVariant("dark") },
};

/*
 * xterm.js themes built from theme roles. The 16 ANSI colours come from
 * `jetPilot.terminal` (VS Code `terminal.ansi*` on import); missing ones
 * fall back to JET's palettes, tuned to the design tokens (the normal
 * colours reuse the status hues). `jetPilot.editor` may carry the VS Code
 * terminal keys (terminal.selectionBackground, terminalCursor.*), which win
 * over the roles and are passed through as written (xterm takes any CSS
 * colour, so translucent selections stay translucent).
 */
import { isDark, parseColor } from "./contrast";
import type { ThemeRoles } from "./derive";
import {
  type AnsiColor,
  type JetPilotThemeExtensions,
  type ThemeAppearance,
  type XtermTheme,
  ANSI_COLORS,
} from "./types";

/** JET's terminal themes (src/components/PtyTerminal.vue). */
export const JET_XTERM: Record<ThemeAppearance, XtermTheme> = {
  dark: {
    background: "#101011",
    foreground: "#e4e4e8",
    cursor: "#a5a8fb",
    cursorAccent: "#101011",
    selectionBackground: "rgba(97, 90, 237, 0.35)",
    black: "#27272a",
    red: "#f26464",
    green: "#36c984",
    yellow: "#f6ae31",
    blue: "#54a0f8",
    magenta: "#c084fc",
    cyan: "#3cc8de",
    white: "#d4d4d8",
    brightBlack: "#5c5c66",
    brightRed: "#f88a8a",
    brightGreen: "#5edc9e",
    brightYellow: "#f9c45e",
    brightBlue: "#7fb8fb",
    brightMagenta: "#d4a5fd",
    brightCyan: "#6fdcec",
    brightWhite: "#fafafa",
  },
  light: {
    background: "#ffffff",
    foreground: "#17171c",
    cursor: "#5048e5",
    cursorAccent: "#ffffff",
    selectionBackground: "rgba(80, 72, 229, 0.2)",
    black: "#18181b",
    red: "#ca2121",
    green: "#117948",
    yellow: "#aa5409",
    blue: "#1160d0",
    magenta: "#8b3fd9",
    cyan: "#0e7490",
    white: "#a1a1aa",
    brightBlack: "#71717a",
    brightRed: "#dc2626",
    brightGreen: "#15803d",
    brightYellow: "#b45309",
    brightBlue: "#2563eb",
    brightMagenta: "#a855f7",
    brightCyan: "#0891b2",
    brightWhite: "#d4d4d8",
  },
};

export function buildXtermTheme(
  roles: ThemeRoles,
  extensions: JetPilotThemeExtensions = {}
): XtermTheme {
  const editor = extensions.editor ?? {};
  const raw = (key: string) => {
    const value = editor[key]?.trim();
    return value && parseColor(value) ? value : undefined;
  };
  // ANSI defaults follow the terminal canvas, not the file's appearance.
  const defaults = JET_XTERM[isDark(roles.terminalBackground) ? "dark" : "light"];

  const theme: XtermTheme = {
    ...defaults,
    background: roles.terminalBackground,
    foreground: roles.terminalForeground,
    cursor: raw("terminalCursor.foreground") ?? roles.terminalCursor,
    cursorAccent: raw("terminalCursor.background") ?? roles.terminalBackground,
    selectionBackground: raw("terminal.selectionBackground") ?? roles.terminalSelection,
  };
  for (const color of ANSI_COLORS as readonly AnsiColor[]) {
    const value = extensions.terminal?.[color];
    if (value && parseColor(value)) theme[color] = value.trim();
  }
  return theme;
}

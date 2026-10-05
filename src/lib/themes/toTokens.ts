/*
 * Theme roles → JET Pilot's CSS tokens (src/assets/main.postcss) as bare
 * HSL triplets. The tokens without a standard role (border-subtle/-strong,
 * tooltip, overlay, status fills) are mixed from the canvas and text so
 * they follow the theme. Status tokens keep JET's semantics: the colour
 * itself is text-grade on the canvas, *-foreground is the text on a solid
 * fill of it.
 */
import { ensureContrast, pickActionColor, readableForeground, type ThemeRoles } from "./derive";
import { isDark, mix, toHslTriplet, TRIPLET_PATTERN } from "./contrast";
import { type ThemeToken, THEME_TOKENS } from "./types";

/**
 * The primary fill and its text. The messageAction role when it is a vivid
 * action colour; otherwise the theme's accent / focus colour (VS Code
 * themes often give their buttons the selection grey, which made the
 * active nav indicator invisible on the selected row).
 */
function primaryPair(roles: ThemeRoles): [string, string] {
  const primary = pickActionColor(
    [roles.messageAction, roles.accent, roles.focus],
    roles.canvas,
    roles.accentSurface
  );
  if (primary === roles.messageAction) return [primary, roles.messageActionForeground];
  return [
    primary,
    readableForeground(primary, [roles.messageActionForeground, roles.accentForeground, roles.text, roles.canvas]),
  ];
}

/** A text-grade status colour and the text that sits on a solid fill of it. */
function statusPair(color: string, roles: ThemeRoles): [string, string] {
  const textGrade = ensureContrast(color, roles.canvas, 4.5);
  return [textGrade, readableForeground(textGrade, [roles.canvas, roles.text])];
}

export function rolesToTokens(
  roles: ThemeRoles,
  /** jetPilot.tokens: raw triplets that win over the mapping. */
  overrides?: Partial<Record<ThemeToken, string>>
): Record<ThemeToken, string> {
  const dark = isDark(roles.canvas);
  const [destructive, destructiveForeground] = statusPair(roles.errorForeground, roles);
  const [warning, warningForeground] = statusPair(roles.warningForeground, roles);
  const [primary, primaryForeground] = primaryPair(roles);
  // Light themes get an inverted tooltip (JET light: near-black), dark ones
  // a raised surface.
  const tooltip = dark ? mix(roles.canvas, roles.text, 0.13) : mix(roles.text, roles.canvas, 0.02);
  const tooltipForeground = readableForeground(tooltip, [
    dark ? roles.text : mix(roles.canvas, roles.text, 0.02),
    roles.canvas,
  ]);

  const hex: Record<ThemeToken, string> = {
    background: roles.canvas,
    foreground: roles.text,
    "surface-1": roles.sidebar,
    "surface-2": roles.surface,
    "surface-3": roles.surfaceOverlay,
    muted: roles.muted,
    "muted-foreground": roles.mutedForeground,
    accent: roles.accentSurface,
    "accent-foreground": roles.accentSurfaceForeground,
    secondary: roles.secondary,
    "secondary-foreground": roles.secondaryForeground,
    "sidebar-foreground": roles.sidebarForeground,
    border: roles.border,
    "border-subtle": mix(roles.border, roles.canvas, 0.35),
    "border-strong": mix(roles.border, roles.text, 0.1),
    input: roles.input,
    ring: roles.focus,
    primary,
    "primary-foreground": primaryForeground,
    link: ensureContrast(roles.accent, roles.canvas, 4.5),
    success: roles.success,
    "success-foreground": roles.successForeground,
    warning,
    "warning-foreground": warningForeground,
    destructive,
    "destructive-foreground": destructiveForeground,
    info: roles.info,
    "info-foreground": roles.infoForeground,
    tooltip,
    "tooltip-foreground": tooltipForeground,
    // The backdrop behind dialogs (painted at --overlay-alpha).
    overlay: dark ? mix(roles.canvas, "#000000", 0.7) : roles.text,
    selection: roles.accent,
    scrollbar: roles.terminalScrollbar,
    "scrollbar-hover": roles.terminalScrollbarHover,
  };

  const vars = {} as Record<ThemeToken, string>;
  for (const token of THEME_TOKENS) {
    const raw = overrides?.[token]?.trim();
    vars[token] = raw && TRIPLET_PATTERN.test(raw) ? raw : toHslTriplet(hex[token]);
  }
  return vars;
}

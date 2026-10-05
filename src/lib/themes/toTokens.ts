/*
 * Theme roles → JET Pilot's CSS tokens (src/assets/main.postcss) as bare
 * HSL triplets. The tokens without a standard role (border-subtle/-strong,
 * tooltip, overlay, status fills) are mixed from the canvas and text so
 * they follow the theme. Status tokens keep JET's semantics: the colour
 * itself is text-grade on the canvas, *-foreground is the text on a solid
 * fill of it.
 */
import {
  chromaOf,
  ensureContrast,
  pickActionColor,
  readableForeground,
  type ThemeRoles,
} from "./derive";
import { contrastRatio, isDark, mix, toHslTriplet, TRIPLET_PATTERN } from "./contrast";
import { type ThemeToken, THEME_TOKENS } from "./types";

/** OKLCH chroma below which an accent reads as a neutral (cream, grey, ink). */
const NEUTRAL_ACCENT_CHROMA = 0.04;
/** Contrast on the canvas above which a neutral accent is as loud as body text. */
const LOUD_ACCENT_CONTRAST = 6;

/**
 * Monochrome themes (NieR-like: the action colour is the text colour) make
 * every accent usage as loud as body text: the active nav indicator, the
 * selected graph card, links, focus rings, text selection. A neutral accent
 * above 6:1 is mixed `amount` toward the canvas, never below `min` (the
 * floor of what it paints); colourful accents and quieter neutrals are
 * kept as they are.
 */
export function calmAccent(color: string, canvas: string, amount: number, min: number): string {
  if (chromaOf(color) >= NEUTRAL_ACCENT_CHROMA) return color;
  if (contrastRatio(color, canvas) <= LOUD_ACCENT_CONTRAST) return color;
  const mixed = mix(color, canvas, amount);
  if (contrastRatio(mixed, canvas) >= min) return mixed;
  // The quietest mix that still reaches `min`.
  let low = 0;
  let high = amount;
  let best = color;
  for (let step = 0; step < 12; step += 1) {
    const mid = (low + high) / 2;
    const candidate = mix(color, canvas, mid);
    if (contrastRatio(candidate, canvas) >= min) {
      best = candidate;
      low = mid;
    } else high = mid;
  }
  return best;
}

/**
 * The primary fill and its text. The messageAction role when it is a vivid
 * action colour; otherwise the theme's accent / focus colour (VS Code
 * themes often give their buttons the selection grey, which made the
 * active nav indicator invisible on the selected row).
 */
function primaryPair(roles: ThemeRoles): [string, string] {
  const picked = pickActionColor(
    [roles.messageAction, roles.accent, roles.focus],
    roles.canvas,
    roles.accentSurface
  );
  // --primary is also text (text-primary): a calmed one stays ≥ 4.5:1.
  const primary = calmAccent(picked, roles.canvas, 0.3, 4.5);
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
    // Focus rings are non-text UI: 3:1.
    ring: calmAccent(roles.focus, roles.canvas, 0.4, 3),
    primary,
    "primary-foreground": primaryForeground,
    link: calmAccent(ensureContrast(roles.accent, roles.canvas, 4.5), roles.canvas, 0.3, 4.5),
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
    // Painted at 30% behind selected text.
    selection: calmAccent(roles.accent, roles.canvas, 0.4, 3),
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

/*
 * Theme file + appearance → everything the runtime paints: the roles
 * (derived and contrast-fixed), the CSS token triplets, the Monaco theme
 * and the xterm theme. Pure, so it runs in Node tests and in the settings
 * previews alike.
 */
import { completeRoles } from "./derive";
import { themeIdFromName } from "./validate";
import { buildMonacoTheme } from "./monacoTheme";
import { rolesToTokens } from "./toTokens";
import type {
  ResolvedTheme,
  ThemeAppearance,
  ThemeFile,
  ThemeVariant,
} from "./types";
import { buildXtermTheme } from "./xtermTheme";

/** Appearances a file can render (base + variants), light first. */
export function themeAppearances(file: ThemeFile): ThemeAppearance[] {
  return (["light", "dark"] as const).filter(
    (appearance) => appearance === file.appearance || !!file.variants?.[appearance]
  );
}

/** The base or variant body for `appearance`, and the appearance it really renders. */
export function pickVariant(
  file: ThemeFile,
  appearance: ThemeAppearance
): { variant: ThemeVariant; appearance: ThemeAppearance } {
  const variant = appearance === file.appearance ? undefined : file.variants?.[appearance];
  if (variant) return { variant, appearance };
  // Variants don't inherit the base's colours: a dark base's syntax or
  // terminal colours would be wrong on a light canvas.
  return {
    variant: {
      canvas: file.canvas,
      accent: file.accent,
      colors: file.colors,
      jetPilot: file.jetPilot,
    },
    appearance: file.appearance,
  };
}

/**
 * Resolves `file` for `appearance`. A file without that appearance renders
 * its base (the result's `appearance` says which one).
 */
export function resolveTheme(file: ThemeFile, appearance: ThemeAppearance): ResolvedTheme {
  const picked = pickVariant(file, appearance);
  const { variant } = picked;
  const extensions = variant.jetPilot ?? {};
  const roles = completeRoles(picked.appearance, {
    canvas: variant.canvas,
    accent: variant.accent,
    colors: { ...variant.colors, ...extensions.colors },
  });
  return {
    id: file.id ?? themeIdFromName(file.name),
    name: file.name,
    appearance: picked.appearance,
    roles,
    vars: rolesToTokens(roles, extensions.tokens),
    monaco: buildMonacoTheme(roles, picked.appearance, extensions),
    xterm: buildXtermTheme(roles, extensions),
  };
}

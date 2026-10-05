/*
 * Monaco themes matching the JET Pilot design tokens (src/assets/main.postcss).
 * The palettes and the syntax `rules()` live in src/lib/themes/jetEditor.ts
 * (no culori), shared with the theme engine (which builds the same data for
 * any theme).
 * JetDark / JetLight are the built-in JET theme's editor colours: the
 * reference the resolver is tested against. Editors are painted with the
 * active theme's resolution (applyMonacoTheme()).
 */
import { JET_EDITOR_COLORS, JET_SYNTAX, rules } from "@/lib/themes/jetEditor";
import type { MonacoThemeData } from "@/lib/themes/types";

export const JetDark: MonacoThemeData = {
  base: "vs-dark",
  inherit: true,
  rules: rules(JET_SYNTAX.dark),
  colors: { ...JET_EDITOR_COLORS.dark },
};

export const JetLight: MonacoThemeData = {
  base: "vs",
  inherit: true,
  rules: rules(JET_SYNTAX.light),
  colors: { ...JET_EDITOR_COLORS.light },
};

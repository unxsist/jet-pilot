/*
 * Monaco themes matching the JET Pilot design tokens (src/assets/main.postcss).
 * The palettes and the syntax `rules()` live in src/lib/themes/monacoTheme.ts,
 * shared with the theme engine (which builds the same data for any theme);
 * JetDark / JetLight are the built-in JET theme's editor colours.
 */
import { JET_EDITOR_COLORS, JET_SYNTAX, rules } from "@/lib/themes/monacoTheme";
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

/** Editor options shared by every Monaco instance (typography, chrome). */
export const editorOptions = {
  fontFamily: '"JetBrains Mono Variable", "JetBrains Mono", ui-monospace, monospace',
  fontSize: 12.5,
  lineHeight: 20,
  fontLigatures: false,
  padding: { top: 12, bottom: 12 },
  renderLineHighlight: "line" as const,
  scrollBeyondLastLine: false,
  smoothScrolling: true,
  cursorBlinking: "smooth" as const,
  roundedSelection: true,
  guides: { indentation: true },
  scrollbar: {
    verticalScrollbarSize: 10,
    horizontalScrollbarSize: 10,
    useShadows: false,
  },
  overviewRulerBorder: false,
  hideCursorInOverviewRuler: true,
};

/*
 * Editor options shared by every Monaco instance (typography, chrome). Kept
 * apart from the themes: importing them must not pull the colour maths
 * (culori) into a component's bundle.
 */
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

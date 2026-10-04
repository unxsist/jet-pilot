/*
 * Monaco themes matching the JET Pilot design tokens (src/assets/main.postcss).
 * Monaco needs literal hex colours, so the token values are mirrored here:
 * canvas = --background, gutter / widgets = --surface-*, accent = --primary.
 * Syntax colours reuse the status / link hues so YAML reads like the rest of
 * the app (keys = link, strings = success, numbers = warning, constants =
 * info).
 */
type ThemeRule = { token: string; foreground?: string; fontStyle?: string };

interface MonacoTheme {
  base: "vs" | "vs-dark";
  inherit: boolean;
  rules: ThemeRule[];
  colors: Record<string, string>;
}

const rules = (palette: {
  key: string;
  string: string;
  number: string;
  constant: string;
  comment: string;
  punctuation: string;
  text: string;
}): ThemeRule[] => [
  { token: "", foreground: palette.text },
  { token: "type", foreground: palette.key },
  { token: "type.yaml", foreground: palette.key },
  { token: "key", foreground: palette.key },
  { token: "attribute.name", foreground: palette.key },
  { token: "string", foreground: palette.string },
  { token: "string.yaml", foreground: palette.string },
  { token: "string.value.json", foreground: palette.string },
  { token: "string.key.json", foreground: palette.key },
  { token: "number", foreground: palette.number },
  { token: "number.yaml", foreground: palette.number },
  { token: "keyword", foreground: palette.constant },
  { token: "constant", foreground: palette.constant },
  { token: "tag", foreground: palette.constant },
  { token: "comment", foreground: palette.comment, fontStyle: "italic" },
  { token: "operators", foreground: palette.punctuation },
  { token: "delimiter", foreground: palette.punctuation },
];

export const JetDark: MonacoTheme = {
  base: "vs-dark",
  inherit: true,
  rules: rules({
    key: "a5a8fb",
    string: "7fd8ad",
    number: "f3b65a",
    constant: "6cb0fb",
    comment: "6e6e78",
    punctuation: "8b8b94",
    text: "e4e4e8",
  }),
  colors: {
    "editor.background": "#101011",
    "editor.foreground": "#e4e4e8",
    "editorLineNumber.foreground": "#4a4a52",
    "editorLineNumber.activeForeground": "#a1a1aa",
    "editorCursor.foreground": "#a5a8fb",
    "editor.lineHighlightBackground": "#18181b",
    "editor.lineHighlightBorder": "#00000000",
    "editor.selectionBackground": "#615aed4d",
    "editor.inactiveSelectionBackground": "#615aed26",
    "editor.selectionHighlightBackground": "#615aed1f",
    "editor.wordHighlightBackground": "#615aed1f",
    "editor.findMatchBackground": "#f6ae3155",
    "editor.findMatchHighlightBackground": "#f6ae3126",
    "editorIndentGuide.background1": "#1f1f23",
    "editorIndentGuide.activeBackground1": "#34343a",
    "editorWhitespace.foreground": "#2a2a30",
    "editorBracketMatch.background": "#615aed26",
    "editorBracketMatch.border": "#615aed80",
    "editorGutter.background": "#101011",
    "editorWidget.background": "#1c1c1f",
    "editorWidget.border": "#2b2b30",
    "editorSuggestWidget.background": "#1c1c1f",
    "editorSuggestWidget.border": "#2b2b30",
    "editorSuggestWidget.selectedBackground": "#252528",
    "editorHoverWidget.background": "#1c1c1f",
    "editorHoverWidget.border": "#2b2b30",
    "input.background": "#151517",
    "input.border": "#2b2b30",
    focusBorder: "#7b75f2",
    "scrollbar.shadow": "#00000000",
    "scrollbarSlider.background": "#3a3a4066",
    "scrollbarSlider.hoverBackground": "#52525a88",
    "scrollbarSlider.activeBackground": "#615aed88",
    "editorOverviewRuler.border": "#00000000",
  },
};

export const JetLight: MonacoTheme = {
  base: "vs",
  inherit: true,
  rules: rules({
    key: "3f37c9",
    string: "117948",
    number: "aa5409",
    constant: "1160d0",
    comment: "8a8a93",
    punctuation: "71717a",
    text: "17171c",
  }),
  colors: {
    "editor.background": "#ffffff",
    "editor.foreground": "#17171c",
    "editorLineNumber.foreground": "#b4b4bb",
    "editorLineNumber.activeForeground": "#52525b",
    "editorCursor.foreground": "#5048e5",
    "editor.lineHighlightBackground": "#f6f6f7",
    "editor.lineHighlightBorder": "#00000000",
    "editor.selectionBackground": "#5048e533",
    "editor.inactiveSelectionBackground": "#5048e51a",
    "editor.selectionHighlightBackground": "#5048e514",
    "editor.wordHighlightBackground": "#5048e514",
    "editor.findMatchBackground": "#f6ae3166",
    "editor.findMatchHighlightBackground": "#f6ae3133",
    "editorIndentGuide.background1": "#eeeef0",
    "editorIndentGuide.activeBackground1": "#d4d4d8",
    "editorWhitespace.foreground": "#e4e4e7",
    "editorBracketMatch.background": "#5048e51a",
    "editorBracketMatch.border": "#5048e566",
    "editorGutter.background": "#ffffff",
    "editorWidget.background": "#ffffff",
    "editorWidget.border": "#e4e4e7",
    "editorSuggestWidget.background": "#ffffff",
    "editorSuggestWidget.border": "#e4e4e7",
    "editorSuggestWidget.selectedBackground": "#efeff1",
    "editorHoverWidget.background": "#ffffff",
    "editorHoverWidget.border": "#e4e4e7",
    "input.background": "#ffffff",
    "input.border": "#dcdce0",
    focusBorder: "#5048e5",
    "scrollbar.shadow": "#00000000",
    "scrollbarSlider.background": "#c8c8cf66",
    "scrollbarSlider.hoverBackground": "#a1a1aa88",
    "scrollbarSlider.activeBackground": "#5048e566",
    "editorOverviewRuler.border": "#00000000",
  },
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

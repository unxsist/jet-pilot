/*
 * Theme contract shared by the importers, the resolver, the runtime
 * (ThemeProvider), the settings UI and the Open VSX commands.
 *
 * The file format is a superset of T3 Code's theme file (version 1, MIT,
 * github.com/pingdotgg/t3code): T3 ignores unknown top-level keys, so a JET
 * Pilot theme with a `jetPilot` block still imports into T3 Code, and every
 * T3 theme (full or seeded "canvas + accent" form) imports here.
 */

/** T3 Code's colour roles, verbatim and in T3's order. */
export const THEME_COLOR_ROLES = [
  "canvas",
  "chrome",
  "toolbar",
  "toolbarForeground",
  "toolbarBorder",
  "toolbarControl",
  "toolbarControlForeground",
  "toolbarControlHover",
  "surface",
  "surfaceRaised",
  "surfaceOverlay",
  "text",
  "textMuted",
  "border",
  "input",
  "focus",
  "accent",
  "accentForeground",
  "secondary",
  "secondaryForeground",
  "muted",
  "mutedForeground",
  "placeholder",
  "secondaryLabel",
  "iconMuted",
  "error",
  "errorForeground",
  "errorSurface",
  "warning",
  "warningForeground",
  "warningSurface",
  "update",
  "updateForeground",
  "updateSurface",
  "accentSurface",
  "accentSurfaceForeground",
  "messageSurface",
  "messageForeground",
  "messageAction",
  "messageActionForeground",
  "messageActionHover",
  "codeBackground",
  "codeForeground",
  "sidebar",
  "sidebarForeground",
  "sidebarMutedForeground",
  "sidebarControlSurface",
  "sidebarRowHover",
  "sidebarRowActive",
  "sidebarRowSelected",
  "sidebarBorder",
  "terminalBackground",
  "terminalForeground",
  "terminalCursor",
  "terminalSelection",
  "terminalScrollbar",
  "terminalScrollbarHover",
] as const;
export type ThemeColorRole = (typeof THEME_COLOR_ROLES)[number];

/** Roles JET Pilot has that T3 Code doesn't (kept under `jetPilot.colors`). */
export const JET_COLOR_ROLES = [
  "success",
  "successForeground",
  "info",
  "infoForeground",
] as const;
export type JetColorRole = (typeof JET_COLOR_ROLES)[number];

/** xterm's 16 ANSI colours (VS Code: `terminal.ansiBrightRed` → brightRed). */
export const ANSI_COLORS = [
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
  "brightBlack",
  "brightRed",
  "brightGreen",
  "brightYellow",
  "brightBlue",
  "brightMagenta",
  "brightCyan",
  "brightWhite",
] as const;
export type AnsiColor = (typeof ANSI_COLORS)[number];

/** Syntax slots of the YAML/JSON editor (src/components/monaco/themes/jet.ts). */
export const SYNTAX_SLOTS = [
  "key",
  "string",
  "number",
  "constant",
  "comment",
  "punctuation",
  "text",
] as const;
export type SyntaxSlot = (typeof SYNTAX_SLOTS)[number];

/**
 * The CSS custom properties a theme sets (src/assets/main.postcss), as bare
 * HSL triplets ("240 5% 6.5%"). card/popover/sidebar are aliases of the
 * surfaces and follow automatically.
 */
export const THEME_TOKENS = [
  "background",
  "foreground",
  "surface-1",
  "surface-2",
  "surface-3",
  "muted",
  "muted-foreground",
  "accent",
  "accent-foreground",
  "secondary",
  "secondary-foreground",
  "sidebar-foreground",
  "border",
  "border-subtle",
  "border-strong",
  "input",
  "ring",
  "primary",
  "primary-foreground",
  "link",
  "success",
  "success-foreground",
  "warning",
  "warning-foreground",
  "destructive",
  "destructive-foreground",
  "info",
  "info-foreground",
  "tooltip",
  "tooltip-foreground",
  "overlay",
  "selection",
  "scrollbar",
  "scrollbar-hover",
] as const;
export type ThemeToken = (typeof THEME_TOKENS)[number];

export type ThemeAppearance = "light" | "dark";
export type ColorScheme = "auto" | ThemeAppearance;

/** Any CSS colour culori can parse (hex, rgb(), hsl(), oklch(), named...). */
export type CssColor = string;

export type ThemeColors = Partial<Record<ThemeColorRole, CssColor>>;

/** JET Pilot extensions; everything optional. */
export interface JetPilotThemeExtensions {
  colors?: Partial<Record<JetColorRole, CssColor>>;
  terminal?: Partial<Record<AnsiColor, CssColor>>;
  syntax?: Partial<Record<SyntaxSlot, CssColor>>;
  /**
   * Raw Monaco / VS Code workbench colour keys, e.g. "editor.lineHighlightBackground".
   * The VS Code terminal keys (terminal.selectionBackground, terminalCursor.*)
   * go to xterm instead of Monaco.
   */
  editor?: Record<string, CssColor>;
  /**
   * Exact token values as bare HSL triplets ("240 5% 6.5%"); they win over the
   * role mapping. An escape hatch for pixel-exact themes (the built-in JET
   * theme reproduces main.postcss with it).
   */
  tokens?: Partial<Record<ThemeToken, string>>;
}

/** One appearance's colours (the base theme or a variant). */
export interface ThemeVariant {
  /** T3 seeded form: the rest of the palette is derived from these two. */
  canvas?: CssColor;
  accent?: CssColor;
  colors?: ThemeColors;
  jetPilot?: JetPilotThemeExtensions;
}

/** A theme file as written on disk ($APPCONFIG/themes/<id>.json). */
export interface ThemeFile extends ThemeVariant {
  $schema?: string;
  /** T3: must be 1 for the full form; optional for the seeded form. */
  version?: 1;
  /** /^[a-z0-9](?:[a-z0-9-]{0,47})$/; derived from the name when missing. */
  id?: string;
  name: string;
  appearance: ThemeAppearance;
  /** The other appearance (never the base one). */
  variants?: Partial<Record<ThemeAppearance, ThemeVariant>>;
  /** Groups variants imported together (e.g. one Open VSX extension). */
  collection?: { id: string; label: string };
  managed?: boolean;
  /**
   * Where the theme came from (JET Pilot extension; T3 ignores it). Written
   * by install(); `label: "Open VSX"` marks Open VSX installs.
   */
  origin?: ThemeOrigin;
}

export type ThemeSource = "builtin" | "user" | "openvsx";

export interface ThemeOrigin {
  /** "T3 Code", "Open VSX", "VS Code", "Sublime Text", "TextMate"... */
  label: string;
  url?: string;
  author?: string;
  license?: string;
}

/** A theme known to the app (built-in or loaded from the themes folder). */
export interface ThemeEntry {
  /** User themes: the file name without ".json" (T3's rule). */
  id: string;
  name: string;
  source: ThemeSource;
  /** Appearances this theme can render (base + variants); empty when `error` is set. */
  appearances: ThemeAppearance[];
  /**
   * The parsed file of user themes. Built-ins are loaded on demand
   * (ThemeContext.loadFile / resolve), so it is absent for them, as it is
   * for broken user files.
   */
  file?: ThemeFile;
  origin?: ThemeOrigin;
  /** Absolute path for user themes. */
  path?: string;
  /** Why a user theme file can't be used (invalid JSON, too large...): show it, don't hide it. */
  error?: string;
}

/** Monaco `IStandaloneThemeData` without importing monaco into src/lib. */
export interface MonacoThemeData {
  base: "vs" | "vs-dark";
  inherit: boolean;
  rules: { token: string; foreground?: string; fontStyle?: string }[];
  colors: Record<string, string>;
}

/** xterm `ITheme` subset. */
export type XtermTheme = {
  background: string;
  foreground: string;
  cursor: string;
  cursorAccent: string;
  selectionBackground: string;
} & Record<AnsiColor, string>;

/** Everything the runtime needs to paint one theme in one appearance. */
export interface ResolvedTheme {
  id: string;
  name: string;
  appearance: ThemeAppearance;
  /** Every T3 + JET role as #rrggbb (after derivation and contrast fixes). */
  roles: Record<ThemeColorRole | JetColorRole, string>;
  /** CSS custom properties without the leading "--", as HSL triplets. */
  vars: Record<ThemeToken, string>;
  monaco: MonacoThemeData;
  xterm: XtermTheme;
}

export type ImportFormat = "jet" | "t3" | "vscode" | "sublime" | "tmtheme";

export type ImportResult =
  | { ok: true; format: ImportFormat; themes: ThemeFile[]; warnings: string[] }
  | { ok: false; error: string };

/* ---- Open VSX (Rust commands in src-tauri/src/openvsx.rs) ---- */

export type OpenVsxSort = "relevance" | "downloadCount" | "averageRating" | "timestamp";

export interface OpenVsxExtension {
  namespace: string;
  name: string;
  displayName: string;
  description: string;
  version: string;
  iconUrl?: string;
  downloadCount: number;
  averageRating?: number;
  license?: string;
}

export interface OpenVsxSearchResult {
  offset: number;
  totalSize: number;
  extensions: OpenVsxExtension[];
}

/** One `contributes.themes[]` entry with its file (includes already merged). */
export interface OpenVsxTheme {
  label: string;
  /** "vs" | "vs-dark" | "hc-black" | "hc-light" */
  uiTheme: string;
  path: string;
  text: string;
}

export interface OpenVsxInstallResult {
  extension: OpenVsxExtension;
  themes: OpenVsxTheme[];
  /** Themes of the extension that could not be read (omitted when empty). */
  warnings?: string[];
}

/* ---- Module API (implemented in src/lib/themes/*, re-exported from ./index) ----
 *
 * import/index.ts  importTheme(text: string, filename?: string, opts?: { resolveInclude?: (path: string) => string | undefined;
 *                                                                     uiTheme?: string }): ImportResult
 *                  - uiTheme: the Open VSX `contributes.themes[].uiTheme`, used when a VS Code file has no `type`.
 *                  - sniffs the format: plist XML → tmtheme; `globals`/`rules` → sublime;
 *                    VS Code detection (dotted `colors` keys or `tokenColors` array, version !== 1) → vscode;
 *                    otherwise jet/t3 (jet when a `jetPilot` block is present).
 * import/vscode.ts pairVariants(files: ThemeFile[]): ThemeFile[]  — merges "X Light" + "X Dark" into one file with `variants`.
 * validate.ts      parseThemeFile(value: unknown): ThemeFile  (throws Error with a readable message; T3 rules)
 *                  themeIdFromName(name: string): string
 * resolve.ts       resolveTheme(file: ThemeFile, appearance: ThemeAppearance): ResolvedTheme
 *                  - picks the variant for `appearance` (falls back to the base), derives missing roles
 *                    (T3 createVividThemeColors port, contrast-solved), maps to tokens / Monaco / xterm.
 *                  themeAppearances(file: ThemeFile): ThemeAppearance[]
 * serialize.ts     serializeTheme(file: ThemeFile, opts?: { forT3?: boolean }): string  (2-space JSON;
 *                  forT3 → version 1, all 57 roles resolved as hex, no jetPilot block, variants resolved too)
 * schema.ts        THEME_JSON_SCHEMA: object (JSON Schema draft-07 for ThemeFile), THEME_SCHEMA_URI = "jet-pilot://schemas/theme.json"
 * builtin/index.ts BUILTIN_THEMES: { id: string; name: string; origin?: ThemeOrigin; appearances: ThemeAppearance[];
 *                                    load: () => Promise<ThemeFile> }[]   — "jet" first; JET's file is eager.
 *                  DEFAULT_THEME_ID = "jet"
 * contrast.ts      contrastRatio(a: string, b: string): number; toHslTriplet(color: string): string; toHex(color: string): string
 */

/* ---- Runtime API (src/providers/ThemeProvider.ts) ---- */

export interface ThemeSettings {
  colorScheme: ColorScheme;
  lightTheme: string;
  darkTheme: string;
}

/**
 * `useTheme()` (src/providers/ThemeProvider.ts). The theme engine (culori,
 * derivation) is a lazy chunk: `active` is null until it has loaded (shortly
 * after start-up); the colours on screen don't depend on it (the CSS / boot
 * cache paint them).
 */
export interface ThemeContext {
  /** Built-in + user themes: built-ins first (manifest order), then user themes by name. */
  themes: Readonly<import("vue").Ref<ThemeEntry[]>>;
  /** The theme currently painted (respecting a live preview); null while the engine loads. */
  active: Readonly<import("vue").Ref<ResolvedTheme | null>>;
  /** Id of the theme currently painted (respecting a live preview; "preview" for drafts). */
  activeId: Readonly<import("vue").Ref<string>>;
  /** The appearance currently painted (a theme without the wanted appearance paints its own). */
  appearance: Readonly<import("vue").Ref<ThemeAppearance>>;
  /** True while preview() overrides the saved choice. */
  previewing: Readonly<import("vue").Ref<boolean>>;
  /** The active theme, waiting for the engine (Monaco / xterm use it before creating editors). */
  resolved(): Promise<ResolvedTheme>;
  /** Resolves any theme (id or draft) for previews and swatches; cached. */
  resolve(theme: string | ThemeFile, appearance: ThemeAppearance): Promise<ResolvedTheme>;
  /**
   * Paints a theme without saving it (id of a known theme, or a draft file);
   * null restores the saved choice. `appearance` defaults to the one the
   * colour scheme wants.
   */
  preview(theme: string | ThemeFile | null, appearance?: ThemeAppearance): Promise<void>;
  /** Saves the choice ("both" sets lightTheme and darkTheme) and ends a preview. */
  setTheme(id: string, mode: ThemeAppearance | "both"): void;
  setColorScheme(scheme: ColorScheme): void;
  /**
   * Writes theme files to $APPCONFIG/themes/<id>.json; ids are made unique
   * (-2, -3... never a built-in's id). `origin` is stored in files that have
   * none; source "openvsx" stores `origin.label = "Open VSX"`. Returns the
   * stored entries, in order.
   */
  install(files: ThemeFile[], source?: ThemeSource, origin?: ThemeOrigin): Promise<ThemeEntry[]>;
  /**
   * Overwrites a user theme (the JSON editor); `id` is the theme's current
   * id. A changed `file.id` renames the file (and the settings follow).
   * Throws a readable Error for invalid files or taken ids.
   */
  save(id: string, file: ThemeFile): Promise<ThemeEntry>;
  /** Deletes a user theme; the appearances that used it fall back to JET. */
  remove(id: string): Promise<void>;
  /** The file of any theme (built-ins are loaded on demand). */
  loadFile(id: string): Promise<ThemeFile>;
  /** Absolute path of the themes folder (created on demand). */
  folder(): Promise<string>;
  /** Opens the themes folder in the OS file manager. */
  openFolder(): Promise<void>;
  /** Re-reads the themes folder (it is also watched). */
  reload(): Promise<void>;
}

/*
 * JSON Schema (draft-07) of the theme file, for the JSON theme editor:
 * Monaco uses it for validation, completion of role names and hovers, so
 * every role carries a description saying where JET Pilot paints it.
 * Colours are loose strings here (any CSS colour); parseThemeFile does the
 * real colour validation with readable errors.
 */
import {
  type AnsiColor,
  type JetColorRole,
  type SyntaxSlot,
  type ThemeColorRole,
  type ThemeToken,
  ANSI_COLORS,
  JET_COLOR_ROLES,
  SYNTAX_SLOTS,
  THEME_COLOR_ROLES,
  THEME_TOKENS,
} from "./types";

export const THEME_SCHEMA_URI = "jet-pilot://schemas/theme.json";

export const ROLE_DESCRIPTIONS: Record<ThemeColorRole, string> = {
  canvas: "Main background behind content: tables, editor, terminal (--background). Seed of the derived palette.",
  chrome: "Window chrome background (T3 Code). JET Pilot uses `sidebar` for its chrome.",
  toolbar: "Toolbar background (T3 Code).",
  toolbarForeground: "Text on the toolbar (T3 Code).",
  toolbarBorder: "Toolbar border (T3 Code).",
  toolbarControl: "Toolbar button background (T3 Code).",
  toolbarControlForeground: "Toolbar button text (T3 Code).",
  toolbarControlHover: "Toolbar button background on hover (T3 Code).",
  surface: "Panels and cards: side panel, grouped settings (--surface-2 / --card).",
  surfaceRaised: "Raised surfaces; the placeholder text is checked against it.",
  surfaceOverlay: "Popovers, menus, dialogs, command palette and editor widgets (--surface-3 / --popover).",
  text: "Primary text (--foreground). Kept at 7:1 contrast on the canvas.",
  textMuted: "Secondary text (T3 Code). JET Pilot's muted text is `mutedForeground`.",
  border: "Hairline borders (--border); --border-subtle and --border-strong are mixed from it.",
  input: "Input borders (--input).",
  focus: "Focus rings (--ring) and the editor's focus border.",
  accent: "Brand / accent colour: links (--link), text selection (--selection), editor selection. Seed of the derived palette.",
  accentForeground: "Text on a solid accent fill.",
  secondary: "Secondary buttons and controls (--secondary).",
  secondaryForeground: "Text on secondary buttons (--secondary-foreground).",
  muted: "Muted backgrounds: skeletons, subtle fills (--muted).",
  mutedForeground: "Muted text: descriptions, captions, table meta (--muted-foreground).",
  placeholder: "Input placeholder text.",
  secondaryLabel: "Secondary labels (T3 Code).",
  iconMuted: "Muted icons (T3 Code).",
  error: "Error signal colour (T3 Code). The editor's find highlights use `warning`.",
  errorForeground: "Readable error text; becomes --destructive (also checked on the canvas).",
  errorSurface: "Background of error alerts.",
  warning: "Warning signal colour; editor find-match highlight.",
  warningForeground: "Readable warning text; becomes --warning (also checked on the canvas).",
  warningSurface: "Background of warning alerts.",
  update: "Update / info signal colour (T3 Code).",
  updateForeground: "Text on update surfaces (T3 Code).",
  updateSurface: "Background of update notices (T3 Code).",
  accentSurface: "Hover and selected rows, menu highlight (--accent) and the editor's selected suggestion.",
  accentSurfaceForeground: "Text on hovered / selected rows (--accent-foreground).",
  messageSurface: "Message bubble background (T3 Code).",
  messageForeground: "Message bubble text (T3 Code).",
  messageAction: "Primary buttons (--primary).",
  messageActionForeground: "Text on primary buttons (--primary-foreground).",
  messageActionHover: "Primary button hover (T3 Code).",
  codeBackground: "Inline code background.",
  codeForeground: "Inline code text.",
  sidebar: "App chrome: navigation, tab bar, toolbars (--surface-1 / --sidebar).",
  sidebarForeground: "Navigation text (--sidebar-foreground).",
  sidebarMutedForeground: "Muted navigation text.",
  sidebarControlSurface: "Controls in the sidebar (T3 Code).",
  sidebarRowHover: "Sidebar row on hover (T3 Code).",
  sidebarRowActive: "Active sidebar row (T3 Code).",
  sidebarRowSelected: "Selected sidebar row (T3 Code).",
  sidebarBorder: "Sidebar border (T3 Code).",
  terminalBackground: "Terminal background.",
  terminalForeground: "Terminal text.",
  terminalCursor: "Terminal and editor cursor.",
  terminalSelection: "Terminal selection.",
  terminalScrollbar: "Scrollbar thumbs (--scrollbar), also in the editor.",
  terminalScrollbarHover: "Scrollbar thumbs on hover (--scrollbar-hover).",
};

const JET_ROLE_DESCRIPTIONS: Record<JetColorRole, string> = {
  success: "Success colour, text-grade on the canvas (--success): ready pods, healthy status. Derived as a green when missing.",
  successForeground: "Text on a solid success fill (--success-foreground).",
  info: "Info colour, text-grade on the canvas (--info). Derived as a blue when missing.",
  infoForeground: "Text on a solid info fill (--info-foreground).",
};

const SYNTAX_DESCRIPTIONS: Record<SyntaxSlot, string> = {
  key: "YAML / JSON keys.",
  string: "String values.",
  number: "Numbers.",
  constant: "Booleans, null and keywords.",
  comment: "Comments (italic).",
  punctuation: "Colons, dashes, brackets.",
  text: "Plain text.",
};

// format: color-hex makes Monaco's JSON mode show colour swatches (hex values
// only); any CSS colour is still accepted, parseThemeFile validates them.
const color = (description: string) => ({ type: "string", format: "color-hex", description });

const properties = <K extends string>(keys: readonly K[], describe: (key: K) => string) =>
  Object.fromEntries(keys.map((key) => [key, color(describe(key))]));

const ansiLabel = (name: AnsiColor) =>
  `ANSI ${name.replace(/([A-Z])/g, " $1").toLowerCase()} (VS Code terminal.ansi${name.charAt(0).toUpperCase()}${name.slice(1)}).`;

const colorsSchema = {
  type: "object",
  description: "T3 Code colour roles (any CSS colour). Missing roles are derived from the canvas and accent.",
  properties: properties(THEME_COLOR_ROLES, (role) => ROLE_DESCRIPTIONS[role]),
  additionalProperties: false,
};

const jetPilotSchema = {
  type: "object",
  description: "JET Pilot extensions (T3 Code ignores this block).",
  properties: {
    colors: {
      type: "object",
      description: "JET Pilot's own colour roles.",
      properties: properties(JET_COLOR_ROLES, (role) => JET_ROLE_DESCRIPTIONS[role]),
      additionalProperties: false,
    },
    terminal: {
      type: "object",
      description: "The terminal's 16 ANSI colours.",
      properties: properties(ANSI_COLORS, ansiLabel),
      additionalProperties: false,
    },
    syntax: {
      type: "object",
      description: "Syntax colours of the YAML / JSON editor.",
      properties: properties(SYNTAX_SLOTS, (slot) => SYNTAX_DESCRIPTIONS[slot]),
      additionalProperties: false,
    },
    editor: {
      type: "object",
      description:
        'Raw Monaco / VS Code colour keys, e.g. "editor.lineHighlightBackground". terminal.selectionBackground and terminalCursor.* go to the terminal.',
      additionalProperties: color("A VS Code workbench colour."),
    },
    tokens: {
      type: "object",
      description: 'Exact CSS token values as HSL triplets ("240 5% 6.5%"); they win over the role mapping.',
      properties: Object.fromEntries(
        THEME_TOKENS.map((token: ThemeToken) => [
          token,
          { type: "string", description: `--${token}`, pattern: "^\\d+(\\.\\d+)? \\d+(\\.\\d+)?% \\d+(\\.\\d+)?%$" },
        ])
      ),
      additionalProperties: false,
    },
  },
  additionalProperties: false,
};

const variantSchema = {
  type: "object",
  description:
    'The other appearance. Either JET\'s form ({ "canvas", "accent", "colors", "jetPilot" }) or T3\'s flat role map.',
  properties: {
    canvas: color(ROLE_DESCRIPTIONS.canvas),
    accent: color(ROLE_DESCRIPTIONS.accent),
    colors: colorsSchema,
    jetPilot: jetPilotSchema,
    ...properties(
      THEME_COLOR_ROLES.filter((role) => role !== "canvas" && role !== "accent"),
      (role) => `${ROLE_DESCRIPTIONS[role]} (T3 flat variant form)`
    ),
  },
  additionalProperties: false,
};

export const THEME_JSON_SCHEMA = {
  $schema: "http://json-schema.org/draft-07/schema#",
  $id: THEME_SCHEMA_URI,
  title: "JET Pilot theme",
  description:
    "A JET Pilot theme: T3 Code's theme file (version 1) plus an optional jetPilot block. Short form: name, appearance, canvas and accent.",
  type: "object",
  required: ["name", "appearance"],
  properties: {
    $schema: { type: "string" },
    version: { const: 1, description: "1 for the full form (optional in the canvas + accent short form)." },
    id: {
      type: "string",
      pattern: "^[a-z0-9](?:[a-z0-9-]{0,47})$",
      description: "Lower-case letters, digits and hyphens. Derived from the name when missing.",
    },
    name: { type: "string", minLength: 1, maxLength: 48, description: "Shown on the theme card." },
    appearance: { enum: ["light", "dark"], description: "The appearance of the base colours." },
    canvas: color(`Seed: ${ROLE_DESCRIPTIONS.canvas}`),
    accent: color(`Seed: ${ROLE_DESCRIPTIONS.accent}`),
    colors: colorsSchema,
    variants: {
      type: "object",
      description: "The other appearance (never the base one).",
      properties: { light: variantSchema, dark: variantSchema },
      additionalProperties: false,
    },
    jetPilot: jetPilotSchema,
    collection: {
      type: "object",
      description: "Groups variants imported together.",
      properties: { id: { type: "string" }, label: { type: "string" } },
      required: ["id", "label"],
    },
    managed: { type: "boolean" },
    origin: {
      type: "object",
      description: "Where the theme came from (JET Pilot; T3 Code ignores it).",
      properties: {
        label: { type: "string", description: 'E.g. "Open VSX", "VS Code", "T3 Code".' },
        url: { type: "string" },
        author: { type: "string" },
        license: { type: "string" },
      },
      required: ["label"],
    },
  },
} as const;

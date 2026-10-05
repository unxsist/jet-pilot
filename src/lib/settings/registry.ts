/*
 * Every preference, defined once: the settings UI, search, the palette,
 * validation, reset, the settings.json schema and exports all come from
 * these definitions. Loaded lazily (SettingsContextProvider imports it while
 * it reads the settings files), so it can grow without weighing on startup.
 *
 * Adding a setting: add its type to `Preferences` (./types.ts), a definition
 * here, and read it as `settings.value.<key>` where it applies.
 */
import type {
  BooleanSetting,
  EnumSetting,
  NumberSetting,
  SettingDefinition,
  StringListSetting,
  StringSetting,
} from "./types";
import type { JsonObject } from "./paths";
import { setPath } from "./paths";

/* Typed constructors: `type` is fixed per helper, defaults stay checked. */
const boolean = (def: Omit<BooleanSetting, "type">): BooleanSetting => ({ ...def, type: "boolean" });
const number = (def: Omit<NumberSetting, "type">): NumberSetting => ({ ...def, type: "number" });
const string = (def: Omit<StringSetting, "type">): StringSetting => ({ ...def, type: "string" });
const choice = (def: Omit<EnumSetting, "type">): EnumSetting => ({ ...def, type: "enum" });
const list = (def: Omit<StringListSetting, "type">): StringListSetting => ({ ...def, type: "string[]" });

export const SETTINGS: readonly SettingDefinition[] = [
  /* ------------------------------------------------------------ general -- */
  boolean({
    key: "updates.checkOnStartup",
    default: true,
    label: "Check for updates on startup",
    description: "Look for a new JET Pilot release every time the app starts.",
    keywords: ["update", "release", "version", "auto"],
    category: "general",
    section: "updates",
  }),
  boolean({
    key: "updates.showWhatsNew",
    default: true,
    label: "Show what's new after updating",
    description: "Introduce the highlights of a new release the first time it starts.",
    keywords: ["release notes", "changelog", "whats new"],
    category: "general",
    section: "updates",
  }),

  /* --------------------------------------------------------- appearance -- */
  choice({
    key: "appearance.colorScheme",
    default: "auto",
    label: "Color scheme",
    description: "Light, dark, or follow your system. Each mode has its own theme.",
    keywords: ["dark mode", "light mode", "system", "appearance"],
    options: [
      { value: "auto", label: "System" },
      { value: "light", label: "Light" },
      { value: "dark", label: "Dark" },
    ],
    category: "appearance",
    section: "mode",
    hidden: true,
  }),
  string({
    key: "appearance.lightTheme",
    default: "jet",
    label: "Light theme",
    description: "Theme used when the appearance is light (a theme id).",
    keywords: ["theme", "colors", "palette"],
    category: "appearance",
    section: "themes",
    hidden: true,
  }),
  string({
    key: "appearance.darkTheme",
    default: "jet",
    label: "Dark theme",
    description: "Theme used when the appearance is dark (a theme id).",
    keywords: ["theme", "colors", "palette"],
    category: "appearance",
    section: "themes",
    hidden: true,
  }),

  /* ----------------------------------------------------------- terminal -- */
  string({
    key: "terminal.fontFamily",
    default: "",
    label: "Font family",
    description: "A CSS font family list. Leave empty for the bundled JetBrains Mono.",
    placeholder: "JetBrains Mono",
    keywords: ["font", "typeface", "monospace"],
    category: "terminal",
    section: "terminal",
  }),
  number({
    key: "terminal.fontSize",
    default: 13,
    min: 8,
    max: 32,
    step: 0.5,
    unit: "px",
    label: "Font size",
    keywords: ["text size", "zoom"],
    category: "terminal",
    section: "terminal",
  }),
  number({
    key: "terminal.lineHeight",
    default: 1.25,
    min: 1,
    max: 2,
    step: 0.05,
    label: "Line height",
    description: "Multiplier of the font size.",
    keywords: ["spacing"],
    category: "terminal",
    section: "terminal",
  }),
  choice({
    key: "terminal.cursorStyle",
    default: "bar",
    label: "Cursor style",
    options: [
      { value: "bar", label: "Bar" },
      { value: "block", label: "Block" },
      { value: "underline", label: "Underline" },
    ],
    control: "segmented",
    keywords: ["caret"],
    category: "terminal",
    section: "terminal",
  }),
  boolean({
    key: "terminal.cursorBlink",
    default: true,
    label: "Blinking cursor",
    description: "Never blinks when your system asks for reduced motion.",
    keywords: ["caret", "animation"],
    category: "terminal",
    section: "terminal",
  }),
  number({
    key: "terminal.scrollback",
    default: 5000,
    min: 100,
    max: 100000,
    step: 500,
    integer: true,
    unit: "lines",
    label: "Scrollback",
    description: "Lines kept above the visible part of a terminal.",
    keywords: ["history", "buffer"],
    category: "terminal",
    section: "terminal",
    appliesTo: "New terminals",
  }),
  boolean({
    key: "terminal.copyOnSelect",
    default: false,
    label: "Copy on select",
    description: "Copy text to the clipboard as soon as you select it.",
    keywords: ["clipboard", "selection"],
    category: "terminal",
    section: "terminal",
  }),
  string({
    key: "terminal.localShell",
    default: "",
    label: "Local terminal shell",
    description: "Program started by the built-in terminal. Leave empty for your login shell.",
    placeholder: "Login shell",
    mono: true,
    keywords: ["bash", "zsh", "fish", "powershell", "pwsh", "shell"],
    category: "terminal",
    section: "shells",
    machine: true,
    appliesTo: "New terminals",
  }),
  string({
    key: "terminal.containerShell",
    default: "/bin/sh",
    label: "Container shell",
    description: "Shell started when you open a shell in a container.",
    placeholder: "/bin/sh",
    mono: true,
    keywords: ["exec", "bash", "sh", "pod"],
    category: "terminal",
    section: "shells",
    appliesTo: "New shells",
  }),

  /* ------------------------------------------------------------- editor -- */
  number({
    key: "editor.fontSize",
    default: 12.5,
    min: 8,
    max: 32,
    step: 0.5,
    unit: "px",
    label: "Font size",
    keywords: ["text size", "yaml", "monaco"],
    category: "terminal",
    section: "editor",
  }),
  number({
    key: "editor.tabSize",
    default: 2,
    min: 1,
    max: 8,
    integer: true,
    label: "Tab size",
    description: "Spaces per indentation level.",
    keywords: ["indent", "indentation", "spaces"],
    category: "terminal",
    section: "editor",
  }),
  boolean({
    key: "editor.wordWrap",
    default: false,
    label: "Word wrap",
    description: "Wrap long lines instead of scrolling sideways.",
    keywords: ["wrap", "lines"],
    category: "terminal",
    section: "editor",
  }),
  boolean({
    key: "editor.minimap",
    default: false,
    label: "Minimap",
    description: "Show an overview of the document next to the scrollbar.",
    keywords: ["overview"],
    category: "terminal",
    section: "editor",
  }),
  boolean({
    key: "editor.lineNumbers",
    default: true,
    label: "Line numbers",
    keywords: ["gutter"],
    category: "terminal",
    section: "editor",
  }),
  choice({
    key: "editor.diffMode",
    default: "sideBySide",
    label: "Diff layout",
    description: "How changes are compared before you apply them.",
    options: [
      { value: "sideBySide", label: "Side by side" },
      { value: "inline", label: "Inline" },
    ],
    control: "segmented",
    keywords: ["compare", "review", "changes"],
    category: "terminal",
    section: "editor",
  }),

  /* ------------------------------------------------------------- tables -- */
  choice({
    key: "tables.liveUpdates",
    default: "watch",
    label: "Live updates",
    description:
      "Watch streams changes the moment they happen. Polling asks kubectl again every few seconds, for clusters or proxies that drop long-lived connections.",
    options: [
      { value: "watch", label: "Watch" },
      { value: "poll", label: "Poll" },
    ],
    control: "segmented",
    keywords: ["refresh", "watch", "polling", "kubectl", "realtime"],
    category: "tables",
    section: "live",
  }),
  number({
    key: "tables.pollInterval",
    default: 5000,
    min: 1000,
    max: 60000,
    step: 1000,
    integer: true,
    unit: "ms",
    label: "Polling interval",
    description: "How often lists refresh when they are polled (also the fallback when a watch fails).",
    keywords: ["refresh", "interval"],
    category: "tables",
    section: "live",
  }),

  /* --------------------------------------------------------------- logs -- */
  number({
    key: "logs.tailLines",
    default: 200,
    min: 1,
    max: 100000,
    integer: true,
    unit: "lines",
    label: "Tail lines",
    description: "Lines loaded per container when logs open.",
    keywords: ["tail", "history"],
    category: "tables",
    section: "logs",
  }),
  boolean({
    key: "logs.follow",
    default: true,
    label: "Follow new lines",
    description: "Keep streaming and scroll along as new lines arrive.",
    keywords: ["stream", "live", "tail -f"],
    category: "tables",
    section: "logs",
  }),
  boolean({
    key: "logs.timestamps",
    default: true,
    label: "Show timestamps",
    keywords: ["time", "date"],
    category: "tables",
    section: "logs",
  }),
  boolean({
    key: "logs.wrap",
    default: false,
    label: "Wrap long lines",
    keywords: ["wrap"],
    category: "tables",
    section: "logs",
  }),

  /* ----------------------------------------------------------- clusters -- */
  list({
    key: "kubeconfig.sources",
    default: [],
    label: "Kubeconfig files",
    description: "Kubeconfig files you added. Their contexts appear in the context switcher.",
    keywords: ["kubeconfig", "config", "contexts", "clusters", "files"],
    category: "clusters",
    section: "kubeconfigs",
    machine: true,
    hidden: true,
  }),
  boolean({
    key: "kubeconfig.autoDetect",
    default: true,
    label: "Find kubeconfig files automatically",
    description: "Also load ~/.kube/config, the files in $KUBECONFIG, ~/.kube/*.yaml and ~/.kube/config.d.",
    keywords: ["kubeconfig", "KUBECONFIG", "detect", "discover"],
    category: "clusters",
    section: "kubeconfigs",
    hidden: true,
  }),

  /* ----------------------------------------------------------- advanced -- */
  number({
    key: "network.requestTimeout",
    default: 30,
    min: 5,
    max: 300,
    integer: true,
    unit: "s",
    label: "Request timeout",
    description: "How long kubectl waits for the API server before giving up.",
    keywords: ["timeout", "slow", "network", "api server"],
    category: "advanced",
    section: "network",
  }),
  string({
    key: "debug.defaultImage",
    default: "busybox:1.36",
    label: "Default debug image",
    description: "Image preselected when you attach a debug container to a pod.",
    placeholder: "busybox:1.36",
    mono: true,
    keywords: ["ephemeral", "debug container", "netshoot", "busybox"],
    category: "advanced",
    section: "debug",
  }),
  choice({
    key: "diagnostics.logLevel",
    default: "error",
    label: "Log level",
    description: "The least severe messages JET Pilot keeps in its application log.",
    options: [
      { value: "error", label: "Error" },
      { value: "warn", label: "Warning" },
      { value: "info", label: "Info" },
      { value: "debug", label: "Debug" },
      { value: "trace", label: "Trace" },
    ],
    keywords: ["logging", "debug", "verbose", "troubleshoot"],
    category: "advanced",
    section: "diagnostics",
  }),
];

export const SETTINGS_BY_KEY: ReadonlyMap<string, SettingDefinition> = new Map(
  SETTINGS.map((def) => [def.key, def])
);

/** The preference defaults as a nested object. */
export function preferenceDefaults(): JsonObject {
  const defaults: JsonObject = {};
  for (const def of SETTINGS) {
    setPath(defaults, def.key, structuredClone(def.default));
  }
  return defaults;
}

/*
 * Types of the settings store (src/providers/SettingsContextProvider.ts).
 *
 * In memory the app keeps one reactive `Settings` object. On disk it is
 * split in two files:
 *   settings.json  the preferences (`Preferences`): only values that differ
 *                  from their default, meant to be read and edited by users
 *                  (Settings › Open settings.json). Every preference has a
 *                  definition in ./registry.ts.
 *   state.json     session state and collections the UI manages (`AppState`):
 *                  active contexts, open tabs, workspaces, ...
 */
import type { TabSession } from "@/lib/tabDescriptors";
import type { PortForwardProfile } from "@/lib/portForwardProfiles";
import type { Workspace } from "@/lib/workspaces";
import type { ThemeSettings } from "@/lib/themes/types";
import type { ClusterRecord } from "@/lib/clusters/meta";

export type LogLevel = "error" | "warn" | "info" | "debug" | "trace";

export interface Preferences {
  updates: {
    checkOnStartup: boolean;
    showWhatsNew: boolean;
  };
  /** Mode plus the theme used for each appearance (theme ids). */
  appearance: ThemeSettings;
  terminal: {
    /** Empty: the bundled JetBrains Mono. */
    fontFamily: string;
    fontSize: number;
    lineHeight: number;
    cursorStyle: "bar" | "block" | "underline";
    cursorBlink: boolean;
    scrollback: number;
    copyOnSelect: boolean;
    /** Shell of local terminals; empty: the login shell ($SHELL). */
    localShell: string;
    /** Shell started in containers (kubectl exec). */
    containerShell: string;
  };
  editor: {
    fontSize: number;
    tabSize: number;
    wordWrap: boolean;
    minimap: boolean;
    lineNumbers: boolean;
    diffMode: "sideBySide" | "inline";
  };
  tables: {
    /** "poll": kubectl polling instead of live watches. */
    liveUpdates: "watch" | "poll";
    /** Polling interval (ms) when lists are polled. */
    pollInterval: number;
  };
  logs: {
    tailLines: number;
    timestamps: boolean;
    wrap: boolean;
    follow: boolean;
  };
  kubeconfig: {
    /** Kubeconfig files added by the user. */
    sources: string[];
    /** Also load ~/.kube/config, $KUBECONFIG, ~/.kube/*.yaml and ~/.kube/config.d. */
    autoDetect: boolean;
  };
  network: {
    /** Seconds before a kubectl request gives up. */
    requestTimeout: number;
  };
  debug: {
    /** Image preselected for debug containers. */
    defaultImage: string;
  };
  diagnostics: {
    logLevel: LogLevel;
  };
  auth: {
    /** Run exec sign-in plugins through JET Pilot's broker (timeouts, no hidden prompts). */
    credentialBroker: boolean;
  };
}

/** Per-context namespace lists of releases before 1.41 (now part of `clusters`). */
export interface ContextSettings {
  context: string;
  namespaces: string[];
}

export interface AppState {
  lastKubeConfig: string | null;
  lastContext: string | null;
  lastNamespace: string | null;
  /** Contexts (and their namespaces) activated in the context switcher. */
  activeContexts: { context: string; kubeConfig: string; namespaces: string[] }[];
  PanelProvider: {
    height: number;
  };
  /** What the user told JET Pilot about each cluster (alias, colour, guardrails...). */
  clusters: ClusterRecord[];
  collapsedNavigationGroups: string[];
  pinnedResources: { name: string; kind: string }[];
  updates: {
    /** Version whose "What's new" was shown last. */
    whatsNew: string | null;
    /** Ids of announcements (src/lib/announcements.ts) the user dismissed. */
    dismissedAnnouncements: string[];
  };
  /** Bottom-panel tabs of the last session, restored on start. */
  openTabs: TabSession | null;
  /** Saved port forwards (optionally started on launch). */
  portForwardProfiles: PortForwardProfile[];
  /** Named working sets, in hotbar order (Mod+Alt+1..9). */
  workspaces: Workspace[];
  activeWorkspaceId: string | null;
  /** Command palette "Recent" items (most recent first). */
  recentCommands: string[];
  /** Version in which the setup guide was finished or skipped. */
  welcomeCompleted: string | null;
}

/** Everything the app reads through `SettingsContextStateKey`. */
export type Settings = Preferences & AppState;

export type SettingCategoryId =
  | "general"
  | "appearance"
  | "terminal"
  | "tables"
  | "clusters"
  | "advanced";

export type Platform = "macos" | "linux" | "windows";

interface BaseDefinition<T> {
  /** Dotted path in `Settings`, e.g. "terminal.fontSize". */
  key: string;
  default: T;
  label: string;
  description?: string;
  /** Extra search terms. */
  keywords?: string[];
  category: SettingCategoryId;
  /** Section id within the category (./categories.ts). */
  section: string;
  /**
   * Specific to this machine (paths, shells): left out of exported
   * settings unless asked for.
   */
  machine?: boolean;
  /** Only shown on these platforms. */
  platforms?: Platform[];
  /**
   * Edited by a bespoke section (theme library, kubeconfig list) instead of
   * a row; still searchable, validated, exported and in the JSON schema.
   */
  hidden?: boolean;
  /** When the change takes effect, e.g. "New terminals" (a badge). */
  appliesTo?: string;
}

export type BooleanSetting = BaseDefinition<boolean> & { type: "boolean" };

export type NumberSetting = BaseDefinition<number> & {
  type: "number";
  min: number;
  max: number;
  step?: number;
  integer?: boolean;
  /** Shown after the value, e.g. "px". */
  unit?: string;
};

export type StringSetting = BaseDefinition<string> & {
  type: "string";
  placeholder?: string;
  /** Monospace input (paths, images, commands). */
  mono?: boolean;
  maxLength?: number;
};

export interface EnumOption {
  value: string;
  label: string;
  description?: string;
}

export type EnumSetting = BaseDefinition<string> & {
  type: "enum";
  options: readonly EnumOption[];
  /** Segmented buttons instead of a select (few, short options). */
  control?: "select" | "segmented";
};

export type StringListSetting = BaseDefinition<string[]> & {
  type: "string[]";
  placeholder?: string;
};

export type SettingDefinition =
  | BooleanSetting
  | NumberSetting
  | StringSetting
  | EnumSetting
  | StringListSetting;

/** A value that was ignored while loading or importing settings. */
export interface SettingsIssue {
  key: string;
  message: string;
}

/*
 * Pure logic behind SettingsContextProvider: migrating the settings files,
 * validating preferences against the registry, combining them with the
 * session state into the in-memory `Settings`, and splitting that back into
 * the two files (settings.json written sparse: only non-default values).
 */
import { mergeSettings } from "@/lib/settingsMerge";
import { SETTINGS, preferenceDefaults } from "./registry";
import { STATE_KEYS, stateDefaults } from "./state";
import type { Settings, SettingDefinition, SettingsIssue } from "./types";
import { validateSetting } from "./values";
import {
  cloneJson,
  deepEqual,
  deepMerge,
  deletePath,
  getPath,
  hasPath,
  isPlainObject,
  setPath,
  type JsonObject,
} from "./paths";

export const SETTINGS_FILE = "settings.json";
export const SETTINGS_VERSION = 2;
/** The settings file as it was before the first migration (written once). */
export const SETTINGS_BACKUP_FILE = "settings.v1.backup.json";

/**
 * Keys renamed in v2. Applied on every load, not just once: a downgraded
 * release that ran in between writes the old keys again.
 */
const RENAMES: readonly [from: string, to: string][] = [
  ["shell.executable", "terminal.containerShell"],
  ["logs.tail_lines", "logs.tailLines"],
  ["kubeConfigs", "kubeconfig.sources"],
  ["logLevel", "diagnostics.logLevel"],
];

/** v1 defaults that changed: users who never touched them get the new default. */
const LEGACY_DEFAULTS: Record<string, unknown> = {
  "logs.tail_lines": 15,
};

export interface MigrateOptions {
  /** Home directory: v1 always listed ~/.kube/config, auto-detection finds it now. */
  home?: string;
}

export interface Migrated {
  preferences: JsonObject;
  state: JsonObject;
  /** Something was moved or renamed (the files should be rewritten). */
  changed: boolean;
}

const normalizePath = (path: string) => path.replace(/\\/g, "/").replace(/\/+$/, "");

/**
 * Brings the parsed settings.json / state.json up to the current layout:
 * session state found in settings.json moves to the state (state.json wins
 * when both have it), renamed keys get their new names, and dropped flags
 * become their replacements. Pure and idempotent.
 */
export function migrate(
  settingsFile: unknown,
  stateFile: unknown,
  options: MigrateOptions = {}
): Migrated {
  const preferences = isPlainObject(settingsFile) ? cloneJson(settingsFile) : {};
  const state = isPlainObject(stateFile) ? cloneJson(stateFile) : {};
  let changed = false;

  for (const key of STATE_KEYS) {
    if (!hasPath(preferences, key)) continue;
    if (!hasPath(state, key)) setPath(state, key, getPath(preferences, key));
    deletePath(preferences, key);
    changed = true;
  }

  for (const [from, to] of RENAMES) {
    if (!hasPath(preferences, from)) continue;
    const value = getPath(preferences, from);
    deletePath(preferences, from);
    changed = true;
    if (hasPath(preferences, to) || deepEqual(value, LEGACY_DEFAULTS[from])) continue;
    setPath(preferences, to, from === "kubeConfigs" ? legacyKubeconfigs(value, options.home) : value);
  }

  const experimental = preferences.experimental;
  if (isPlainObject(experimental) && "useKubectlPolling" in experimental) {
    if (experimental.useKubectlPolling === true && !hasPath(preferences, "tables.liveUpdates")) {
      setPath(preferences, "tables.liveUpdates", "poll");
    }
    deletePath(preferences, "experimental.useKubectlPolling");
    changed = true;
  }

  delete preferences.version;
  delete preferences.$schema;
  return { preferences, state, changed };
}

/*
 * v1 always listed ~/.kube/config (it re-added it when the list was empty)
 * and allowed empty rows: keep only the files the user added.
 */
function legacyKubeconfigs(value: unknown, home?: string): unknown {
  if (!Array.isArray(value)) return value;
  const defaultPath = home ? normalizePath(`${home}/.kube/config`) : null;
  return value.filter(
    (path) =>
      typeof path !== "string" ||
      (path.trim() !== "" && normalizePath(path) !== defaultPath)
  );
}

export interface SanitizedPreferences {
  /** Every preference (defaults filled in), nested. */
  values: JsonObject;
  /** Keys the registry doesn't know (kept, so newer or older releases don't lose them). */
  extras: JsonObject;
  issues: SettingsIssue[];
}

/** Validates the preferences of a settings file; invalid values fall back to the default. */
export function sanitizePreferences(
  raw: JsonObject,
  defs: readonly SettingDefinition[] = SETTINGS
): SanitizedPreferences {
  const values = preferenceDefaults();
  const extras = cloneJson(raw);
  const issues: SettingsIssue[] = [];

  for (const def of defs) {
    if (!hasPath(raw, def.key)) continue;
    const result = validateSetting(def, getPath(raw, def.key));
    if (result.ok) setPath(values, def.key, result.value);
    else issues.push({ key: def.key, message: result.message });
    deletePath(extras, def.key);
  }

  // "terminal": 12 would shadow every terminal.* key when written back.
  for (const def of defs) {
    const parts = def.key.split(".");
    for (let i = 1; i < parts.length; i++) {
      const prefix = parts.slice(0, i).join(".");
      const value = getPath(extras, prefix);
      if (value !== undefined && !isPlainObject(value)) {
        deletePath(extras, prefix);
        issues.push({ key: prefix, message: "Expected an object" });
      }
    }
  }

  return { values, extras, issues };
}

/** The in-memory settings: state (with its defaults) plus validated preferences. */
export function buildSettings(values: JsonObject, state: unknown): Settings {
  const merged = mergeSettings(stateDefaults(), state) as unknown as JsonObject;
  return deepMerge(merged, cloneJson(values)) as unknown as Settings;
}

/** Adds the keys of `source` that `target` lacks (recursively); `target` wins. */
function fillMissing(target: JsonObject, source: JsonObject): JsonObject {
  for (const [key, value] of Object.entries(source)) {
    if (!(key in target)) target[key] = value;
    else if (isPlainObject(target[key]) && isPlainObject(value)) {
      fillMissing(target[key] as JsonObject, value);
    }
  }
  return target;
}

/** settings.json: the version, non-default preferences (registry order), then unknown keys. */
export function preferencesFile(
  settings: unknown,
  extras: JsonObject = {},
  defs: readonly SettingDefinition[] = SETTINGS
): JsonObject {
  const file: JsonObject = { version: SETTINGS_VERSION };
  for (const def of defs) {
    const value = getPath(settings, def.key);
    if (value !== undefined && !deepEqual(value, def.default)) {
      setPath(file, def.key, cloneJson(value));
    }
  }
  return fillMissing(file, cloneJson(extras));
}

/** state.json: the session state keys. */
export function stateFile(settings: unknown): JsonObject {
  const file: JsonObject = {};
  for (const key of STATE_KEYS) {
    const value = getPath(settings, key);
    if (value !== undefined) setPath(file, key, cloneJson(value));
  }
  return file;
}

export const serializeJson = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

export interface AppliedPreferences {
  extras: JsonObject;
  issues: SettingsIssue[];
  /** Keys whose value changed. */
  changed: string[];
}

/**
 * Replaces the preferences in `settings` with those of a settings file
 * (settings.json edited in the app or on disk, an import, a reset). Missing
 * keys mean "default"; session state in the file is ignored.
 */
export function applyPreferences(
  settings: Settings,
  raw: unknown,
  defs: readonly SettingDefinition[] = SETTINGS
): AppliedPreferences {
  const { preferences } = migrate(raw, undefined);
  const { values, extras, issues } = sanitizePreferences(preferences, defs);
  const changed: string[] = [];
  for (const def of defs) {
    const next = getPath(values, def.key);
    if (!deepEqual(getPath(settings, def.key), next)) {
      setPath(settings as unknown as JsonObject, def.key, cloneJson(next));
      changed.push(def.key);
    }
  }
  return { extras, issues, changed };
}

/** Whether a preference differs from its default. */
export function isModified(settings: unknown, def: SettingDefinition): boolean {
  return !deepEqual(getPath(settings, def.key), def.default);
}

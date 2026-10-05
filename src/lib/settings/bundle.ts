/*
 * Export / import of a JET Pilot setup in one file (Settings › General ›
 * Your settings): preferences, workspaces, port-forward profiles, namespace
 * lists, pinned resources and user themes. Never credentials. Importing
 * merges: imported values win, everything else stays.
 *
 * A plain settings.json can be imported too (preferences only).
 */
import { MAX_WORKSPACES, parseWorkspaces } from "@/lib/workspaces";
import { parseProfiles } from "@/lib/portForwardProfiles";
import type { ThemeFile } from "@/lib/themes/types";
import { SETTINGS } from "./registry";
import { mergeContextSettings, preferencesFile, sanitizePreferences, migrate } from "./store";
import { contextKey } from "@/lib/contextKey";
import type { ClusterRecord } from "@/lib/clusters/meta";
import { cloneJson, deepEqual, deepMerge, deletePath, getPath, isPlainObject, type JsonObject } from "./paths";
import type { ContextSettings, Settings } from "./types";

export const BUNDLE_FORMAT = "jet-pilot-settings";
export const BUNDLE_VERSION = 1;

export interface SettingsBundle {
  format: typeof BUNDLE_FORMAT;
  version: number;
  exportedAt: string;
  appVersion: string;
  preferences?: JsonObject;
  workspaces?: unknown[];
  portForwardProfiles?: unknown[];
  /** Cluster details (aliases, colours, folders, guardrails). */
  clusters?: ClusterRecord[];
  /** Exports before 1.41: namespace lists per context name. */
  contextSettings?: ContextSettings[];
  pinnedResources?: { name: string; kind: string }[];
  themes?: ThemeFile[];
}

export type BundlePart =
  | "preferences"
  | "workspaces"
  | "portForwardProfiles"
  | "clusters"
  | "pinnedResources"
  | "themes";

export const BUNDLE_PARTS: { part: BundlePart; label: string }[] = [
  { part: "preferences", label: "Preferences" },
  { part: "workspaces", label: "Workspaces" },
  { part: "portForwardProfiles", label: "Port-forward profiles" },
  { part: "clusters", label: "Cluster details" },
  { part: "pinnedResources", label: "Pinned resources" },
  { part: "themes", label: "Your themes" },
];

/** Preferences specific to this machine (paths, shells). */
export const MACHINE_KEYS = SETTINGS.filter((def) => def.machine).map((def) => def.key);

export interface ExportOptions {
  parts: ReadonlySet<BundlePart>;
  /** Also export machine-specific preferences (kubeconfig paths, shells). */
  includeMachine: boolean;
  appVersion: string;
  themes: ThemeFile[];
  now?: Date;
}

/** Number of items per part, for the export dialog. */
export function exportCounts(settings: Settings, themes: number): Record<BundlePart, number> {
  const preferences = SETTINGS.filter(
    (def) => !deepEqual(getPath(settings, def.key), def.default)
  ).length;
  return {
    preferences,
    workspaces: settings.workspaces.length,
    portForwardProfiles: settings.portForwardProfiles.length,
    clusters: settings.clusters.length,
    pinnedResources: settings.pinnedResources.length,
    themes,
  };
}

export function buildBundle(settings: Settings, options: ExportOptions): SettingsBundle {
  const bundle: SettingsBundle = {
    format: BUNDLE_FORMAT,
    version: BUNDLE_VERSION,
    exportedAt: (options.now ?? new Date()).toISOString(),
    appVersion: options.appVersion,
  };
  const { parts } = options;
  if (parts.has("preferences")) {
    const preferences = preferencesFile(settings);
    delete preferences.version;
    if (!options.includeMachine) {
      for (const key of MACHINE_KEYS) deletePath(preferences, key);
    }
    bundle.preferences = preferences;
  }
  if (parts.has("workspaces")) bundle.workspaces = cloneJson(settings.workspaces);
  if (parts.has("portForwardProfiles")) bundle.portForwardProfiles = cloneJson(settings.portForwardProfiles);
  if (parts.has("clusters")) bundle.clusters = cloneJson(settings.clusters);
  if (parts.has("pinnedResources")) bundle.pinnedResources = cloneJson(settings.pinnedResources);
  if (parts.has("themes") && options.themes.length) bundle.themes = cloneJson(options.themes);
  return bundle;
}

export type ParsedBundle = { ok: true; bundle: SettingsBundle } | { ok: false; message: string };

/** Reads an exported bundle, or a settings.json (as a preferences-only bundle). */
export function parseBundle(text: string): ParsedBundle {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, message: "This file isn't valid JSON." };
  }
  if (!isPlainObject(data)) return { ok: false, message: "This file isn't a JET Pilot settings file." };
  if (data.format === BUNDLE_FORMAT) {
    if (typeof data.version !== "number" || data.version > BUNDLE_VERSION) {
      return { ok: false, message: "This file was exported by a newer JET Pilot. Update JET Pilot to import it." };
    }
    return { ok: true, bundle: data as unknown as SettingsBundle };
  }
  // A settings.json (any version): only its preferences.
  const { preferences } = migrate(data, undefined);
  if (!SETTINGS.some((def) => getPath(preferences, def.key) !== undefined)) {
    return { ok: false, message: "This file isn't a JET Pilot settings file." };
  }
  return {
    ok: true,
    bundle: {
      format: BUNDLE_FORMAT,
      version: BUNDLE_VERSION,
      exportedAt: "",
      appVersion: "",
      preferences,
    },
  };
}

export interface PartSummary {
  part: BundlePart;
  label: string;
  /** Items in the file. */
  count: number;
  /** What importing changes, e.g. "3 new, 1 replaced". */
  detail: string;
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

/** What importing each part of `bundle` would do to `settings`. */
export function summarizeBundle(settings: Settings, bundle: SettingsBundle): PartSummary[] {
  const summaries: PartSummary[] = [];
  const add = (part: BundlePart, count: number, detail: string) =>
    count > 0 && summaries.push({ part, label: BUNDLE_PARTS.find((p) => p.part === part)!.label, count, detail });

  if (bundle.preferences) {
    const merged = mergedPreferences(settings, bundle.preferences);
    const { values } = sanitizePreferences(migrate(merged, undefined).preferences);
    const changed = SETTINGS.filter((def) => !deepEqual(getPath(settings, def.key), getPath(values, def.key))).length;
    const count = SETTINGS.filter((def) => getPath(bundle.preferences, def.key) !== undefined).length;
    add("preferences", count, changed ? `${plural(changed, "value")} change` : "Nothing changes");
  }
  const byId = <T extends { id: string }>(incoming: T[], current: { id: string }[]) => {
    const replaced = incoming.filter((item) => current.some((c) => c.id === item.id)).length;
    return [incoming.length - replaced ? `${incoming.length - replaced} new` : "", replaced ? `${replaced} replaced` : ""]
      .filter(Boolean)
      .join(", ");
  };
  const workspaces = parseWorkspaces(bundle.workspaces);
  add("workspaces", workspaces.length, byId(workspaces, settings.workspaces));
  const profiles = parseProfiles(bundle.portForwardProfiles);
  add("portForwardProfiles", profiles.length, byId(profiles, settings.portForwardProfiles));
  const clusters = bundleClusters(bundle);
  add(
    "clusters",
    clusters.length,
    byId(
      clusters.map((c) => ({ id: contextKey(c.context, c.kubeConfig) })),
      settings.clusters.map((c) => ({ id: contextKey(c.context, c.kubeConfig) }))
    )
  );
  const pinned = parsePinned(bundle.pinnedResources);
  const newPins = pinned.filter((p) => !settings.pinnedResources.some((c) => c.name === p.name && c.kind === p.kind));
  add("pinnedResources", pinned.length, newPins.length ? `${newPins.length} new` : "Already pinned");
  const themes = bundleThemes(bundle);
  add("themes", themes.length, plural(themes.length, "theme"));
  return summaries;
}

/** The current preferences with those of a bundle on top (a settings.json document). */
export const mergedPreferences = (settings: Settings, incoming: JsonObject) =>
  deepMerge(preferencesFile(settings), cloneJson(incoming));

/** Cluster records of a bundle (and the namespace lists of older exports). */
function bundleClusters(bundle: SettingsBundle): ClusterRecord[] {
  const records = (Array.isArray(bundle.clusters) ? bundle.clusters : []).filter(
    (r): r is ClusterRecord =>
      isPlainObject(r) && typeof r.context === "string" && typeof r.kubeConfig === "string"
  );
  return mergeContextSettings(cloneJson(records), bundle.contextSettings) as ClusterRecord[];
}

function parsePinned(value: unknown): { name: string; kind: string }[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((p) => isPlainObject(p) && typeof p.name === "string" && typeof p.kind === "string")
    .map((p) => ({ name: p.name as string, kind: p.kind as string }));
}

const upsertById = <T extends { id: string }>(current: T[], incoming: T[]) => {
  const next = [...current];
  for (const item of incoming) {
    const index = next.findIndex((c) => c.id === item.id);
    if (index >= 0) next[index] = item;
    else next.push(item);
  }
  return next;
};

/**
 * Merges the chosen collections of `bundle` into `settings`. Preferences go
 * through SettingsFileApi.applyPreferences(mergedPreferences(...)) and
 * themes through the theme runtime.
 */
export function applyBundleCollections(
  settings: Settings,
  bundle: SettingsBundle,
  parts: ReadonlySet<BundlePart>
): void {
  if (parts.has("workspaces")) {
    settings.workspaces = upsertById(settings.workspaces, parseWorkspaces(bundle.workspaces)).slice(
      0,
      MAX_WORKSPACES
    );
  }
  if (parts.has("portForwardProfiles")) {
    settings.portForwardProfiles = upsertById(settings.portForwardProfiles, parseProfiles(bundle.portForwardProfiles));
  }
  if (parts.has("clusters")) {
    const next = [...settings.clusters];
    for (const item of bundleClusters(bundle)) {
      const index = next.findIndex((c) => c.context === item.context && c.kubeConfig === item.kubeConfig);
      if (index >= 0) next[index] = item;
      else next.push(item);
    }
    settings.clusters = next;
  }
  if (parts.has("pinnedResources")) {
    const next = [...settings.pinnedResources];
    for (const pin of parsePinned(bundle.pinnedResources)) {
      if (!next.some((c) => c.name === pin.name && c.kind === pin.kind)) next.push(pin);
    }
    settings.pinnedResources = next;
  }
}

/** Themes in a bundle (validated when they are installed). */
export const bundleThemes = (bundle: SettingsBundle): ThemeFile[] =>
  Array.isArray(bundle.themes) ? (bundle.themes.filter(isPlainObject) as unknown as ThemeFile[]) : [];

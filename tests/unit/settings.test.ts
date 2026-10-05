import { describe, expect, it } from "vitest";
import { SETTINGS, SETTINGS_BY_KEY, preferenceDefaults } from "@/lib/settings/registry";
import { CATEGORIES } from "@/lib/settings/categories";
import { STATE_KEYS, stateDefaults } from "@/lib/settings/state";
import {
  applyPreferences,
  buildSettings,
  isModified,
  migrate,
  preferencesFile,
  sanitizePreferences,
  stateFile,
} from "@/lib/settings/store";
import { validateSetting, formatSettingValue } from "@/lib/settings/values";
import { buildSettingsSchema } from "@/lib/settings/schema";
import { parseSearchQuery, searchSettings } from "@/lib/settings/search";
import {
  applyBundleCollections,
  buildBundle,
  mergedPreferences,
  parseBundle,
  summarizeBundle,
} from "@/lib/settings/bundle";
import { deletePath, getPath, setPath } from "@/lib/settings/paths";
import { mergeKubeconfigPaths } from "@/lib/kubeconfigSources";
import type { Settings } from "@/lib/settings/types";

/* A settings.json as JET Pilot 1.38 wrote it. */
const V1 = {
  lastKubeConfig: "/home/me/.kube/config",
  lastContext: "prod",
  lastNamespace: "",
  activeContexts: [{ context: "prod", kubeConfig: "/home/me/.kube/config", namespaces: ["all"] }],
  PanelProvider: { height: 40 },
  shell: { executable: "/bin/bash" },
  logs: { tail_lines: 15 },
  kubeConfigs: ["/home/me/.kube/config", "/home/me/clusters/lab.yaml", ""],
  contextSettings: [{ context: "prod", namespaces: ["payments"] }],
  collapsedNavigationGroups: ["Policies"],
  pinnedResources: [{ name: "pods", kind: "Pod" }],
  appearance: { colorScheme: "dark", lightTheme: "jet", darkTheme: "dracula" },
  updates: { checkOnStartup: false, whatsNew: "1.38.0", dismissedAnnouncements: ["a1"] },
  logLevel: "debug",
  openTabs: null,
  portForwardProfiles: [],
  workspaces: [],
  activeWorkspaceId: null,
  recentCommands: ["nav:Pods"],
  experimental: { useKubectlPolling: true },
  someFutureKey: { kept: true },
};

const load = (settingsFile: unknown, state?: unknown) => {
  const migrated = migrate(settingsFile, state, { home: "/home/me" });
  const sanitized = sanitizePreferences(migrated.preferences);
  return { migrated, sanitized, settings: buildSettings(sanitized.values, migrated.state) };
};

describe("settings registry", () => {
  it("has unique keys and valid defaults", () => {
    expect(new Set(SETTINGS.map((def) => def.key)).size).toBe(SETTINGS.length);
    for (const def of SETTINGS) {
      const result = validateSetting(def, def.default);
      expect(result.ok, def.key).toBe(true);
      if (result.ok) expect(result.value).toEqual(def.default);
    }
  });

  it("places every setting in an existing category section", () => {
    for (const def of SETTINGS) {
      const category = CATEGORIES.find((c) => c.id === def.category);
      expect(category, def.key).toBeTruthy();
      expect(category!.sections.some((s) => s.id === def.section), def.key).toBe(true);
    }
  });

  it("never overlaps with the session state", () => {
    for (const def of SETTINGS) {
      for (const key of STATE_KEYS) {
        expect(def.key === key || def.key.startsWith(`${key}.`) || key.startsWith(`${def.key}.`)).toBe(false);
      }
    }
  });

  it("names no other products in labels and descriptions", () => {
    const text = SETTINGS.map((def) => `${def.label} ${def.description ?? ""}`).join(" ");
    expect(text).not.toMatch(/\b(t3|lens|k9s|headlamp|vs ?code)\b/i);
  });
});

describe("validateSetting", () => {
  const fontSize = SETTINGS_BY_KEY.get("terminal.fontSize")!;
  const cursor = SETTINGS_BY_KEY.get("terminal.cursorStyle")!;
  it("clamps and coerces numbers", () => {
    expect(validateSetting(fontSize, 99)).toEqual({ ok: true, value: 32 });
    expect(validateSetting(fontSize, "14")).toEqual({ ok: true, value: 14 });
    expect(validateSetting(fontSize, 13.26)).toEqual({ ok: true, value: 13.3 });
    expect(validateSetting(fontSize, "big").ok).toBe(false);
  });
  it("checks enum values", () => {
    expect(validateSetting(cursor, "block").ok).toBe(true);
    expect(validateSetting(cursor, "beam").ok).toBe(false);
  });
  it("formats values", () => {
    expect(formatSettingValue(fontSize, 13)).toBe("13 px");
    expect(formatSettingValue(cursor, "underline")).toBe("Underline");
    expect(formatSettingValue(SETTINGS_BY_KEY.get("logs.wrap")!, false)).toBe("Off");
  });
});

describe("migrate (v1 → v2)", () => {
  it("moves session state to state.json and renames preferences", () => {
    const { migrated, settings } = load(V1);
    expect(migrated.changed).toBe(true);
    expect(migrated.state.lastContext).toBe("prod");
    expect(getPath(migrated.state, "updates.whatsNew")).toBe("1.38.0");
    expect(migrated.preferences.lastContext).toBeUndefined();
    expect(getPath(migrated.preferences, "updates.whatsNew")).toBeUndefined();

    expect(settings.terminal.containerShell).toBe("/bin/bash");
    expect(settings.diagnostics.logLevel).toBe("debug");
    expect(settings.tables.liveUpdates).toBe("poll");
    expect(settings.updates.checkOnStartup).toBe(false);
    expect(settings.updates.whatsNew).toBe("1.38.0");
    expect(settings.appearance.darkTheme).toBe("dracula");
    expect(settings.contextSettings).toEqual([{ context: "prod", namespaces: ["payments"] }]);
  });

  it("drops the always-added ~/.kube/config and empty rows", () => {
    const { settings } = load(V1);
    expect(settings.kubeconfig.sources).toEqual(["/home/me/clusters/lab.yaml"]);
  });

  it("gives users of the old tail default the new one", () => {
    expect(load(V1).settings.logs.tailLines).toBe(200);
    expect(load({ ...V1, logs: { tail_lines: 50 } }).settings.logs.tailLines).toBe(50);
  });

  it("is idempotent", () => {
    const first = migrate(V1, undefined, { home: "/home/me" });
    const second = migrate(first.preferences, first.state, { home: "/home/me" });
    expect(second.changed).toBe(false);
    expect(second.preferences).toEqual(first.preferences);
    expect(second.state).toEqual(first.state);
  });

  it("prefers state.json over session keys a downgraded release wrote back", () => {
    const migrated = migrate({ lastContext: "old", kubeConfigs: ["/a"] }, { lastContext: "new" });
    expect(migrated.state.lastContext).toBe("new");
    expect(getPath(migrated.preferences, "kubeconfig.sources")).toEqual(["/a"]);
    expect(migrated.preferences.kubeConfigs).toBeUndefined();
  });

  it("keeps an already-migrated key over a stale old one", () => {
    const migrated = migrate({ logLevel: "trace", diagnostics: { logLevel: "warn" } }, undefined);
    expect(getPath(migrated.preferences, "diagnostics.logLevel")).toBe("warn");
  });
});

describe("sanitizePreferences", () => {
  it("falls back to defaults for invalid values and reports them", () => {
    const { values, issues } = sanitizePreferences({ terminal: { fontSize: "huge", cursorStyle: "block" } });
    expect(getPath(values, "terminal.fontSize")).toBe(13);
    expect(getPath(values, "terminal.cursorStyle")).toBe("block");
    expect(issues.map((issue) => issue.key)).toEqual(["terminal.fontSize"]);
  });

  it("keeps unknown keys as extras", () => {
    const { extras } = sanitizePreferences({ someFutureKey: { kept: true }, terminal: { ligatures: true } });
    expect(extras).toEqual({ someFutureKey: { kept: true }, terminal: { ligatures: true } });
  });

  it("drops a known section of the wrong type", () => {
    const { extras, issues } = sanitizePreferences({ terminal: 12 });
    expect(extras.terminal).toBeUndefined();
    expect(issues.some((issue) => issue.key === "terminal")).toBe(true);
  });
});

describe("settings files", () => {
  it("writes only non-default preferences, then unknown keys", () => {
    const { settings, sanitized } = load(V1);
    const file = preferencesFile(settings, sanitized.extras);
    expect(Object.keys(file)[0]).toBe("version");
    expect(file).toMatchObject({
      version: 2,
      updates: { checkOnStartup: false },
      appearance: { colorScheme: "dark", darkTheme: "dracula" },
      someFutureKey: { kept: true },
    });
    expect(getPath(file, "appearance.lightTheme")).toBeUndefined();
    expect(getPath(file, "logs")).toBeUndefined();
  });

  it("round-trips through the files", () => {
    const { settings, sanitized } = load(V1);
    const again = load(preferencesFile(settings, sanitized.extras), stateFile(settings));
    expect(again.settings).toEqual(settings);
    expect(again.migrated.changed).toBe(false);
  });

  it("writes every state key", () => {
    const { settings } = load(V1);
    const file = stateFile(settings);
    for (const key of STATE_KEYS) expect(getPath(file, key), key).not.toBeUndefined();
  });

  it("first start: defaults everywhere", () => {
    const { settings } = load(undefined);
    expect(settings).toEqual(buildSettings(preferenceDefaults(), stateDefaults()));
    expect(preferencesFile(settings)).toEqual({ version: 2 });
  });
});

describe("applyPreferences", () => {
  it("applies a document: missing keys mean default", () => {
    const { settings } = load(V1);
    const result = applyPreferences(settings, { terminal: { fontSize: 15 }, logs: { wrap: "yes" } });
    expect(settings.terminal.fontSize).toBe(15);
    expect(settings.updates.checkOnStartup).toBe(true);
    expect(settings.appearance.darkTheme).toBe("jet");
    expect(settings.lastContext).toBe("prod");
    expect(result.issues.map((issue) => issue.key)).toEqual(["logs.wrap"]);
    expect(result.changed).toContain("terminal.fontSize");
  });

  it("isModified compares with the default", () => {
    const { settings } = load({});
    const def = SETTINGS_BY_KEY.get("editor.minimap")!;
    expect(isModified(settings, def)).toBe(false);
    setPath(settings as never, "editor.minimap", true);
    expect(isModified(settings, def)).toBe(true);
  });
});

describe("settings schema", () => {
  it("describes every preference", () => {
    const schema = buildSettingsSchema() as unknown as { properties: Record<string, { additionalProperties?: boolean; properties: Record<string, Record<string, unknown>> }> };
    expect(schema.properties.terminal.properties.fontSize).toMatchObject({
      type: "number",
      minimum: 8,
      maximum: 32,
      default: 13,
    });
    expect(schema.properties.terminal.additionalProperties).toBe(false);
    expect(schema.properties.editor.properties.diffMode.enum).toEqual(["sideBySide", "inline"]);
    expect(schema.properties.kubeconfig.properties.sources.type).toBe("array");
  });
});

describe("settings search", () => {
  it("finds settings by label, keyword and key", () => {
    const keys = (query: string) =>
      searchSettings(query).flatMap((hit) => (hit.kind === "setting" ? [hit.def.key] : []));
    expect(keys("font size")).toContain("terminal.fontSize");
    expect(keys("polling")[0]).toBe("tables.liveUpdates");
    expect(keys("editor.minimap")).toContain("editor.minimap");
  });

  it("finds bespoke sections", () => {
    const sections = searchSettings("gallery").filter((hit) => hit.kind === "section");
    expect(sections.map((hit) => hit.section.id)).toContain("themes");
  });

  it("@modified lists changed preferences", () => {
    const { settings } = load(V1);
    expect(parseSearchQuery("@modified terminal")).toEqual({ text: "terminal", modifiedOnly: true });
    const keys = searchSettings("@modified", settings).map((hit) => (hit.kind === "setting" ? hit.def.key : ""));
    expect(keys).toContain("terminal.containerShell");
    expect(keys).not.toContain("terminal.fontSize");
  });

  it("returns nothing for an empty query", () => {
    expect(searchSettings("  ")).toEqual([]);
  });
});

describe("settings bundle", () => {
  const settingsWith = () => {
    const { settings } = load(V1);
    settings.terminal.localShell = "/usr/bin/fish";
    settings.workspaces = [
      { id: "ws-1", name: "Prod", contexts: [], tabs: null, portForwardProfileIds: [], route: null, updatedAt: 1 },
    ] as Settings["workspaces"];
    return settings;
  };

  it("exports preferences without machine-specific ones by default", () => {
    const bundle = buildBundle(settingsWith(), {
      parts: new Set(["preferences", "workspaces"]),
      includeMachine: false,
      appVersion: "1.40.0",
      themes: [],
      now: new Date(0),
    });
    expect(bundle.format).toBe("jet-pilot-settings");
    expect(getPath(bundle.preferences, "terminal.localShell")).toBeUndefined();
    expect(getPath(bundle.preferences, "kubeconfig.sources")).toBeUndefined();
    expect(getPath(bundle.preferences, "terminal.containerShell")).toBe("/bin/bash");
    expect(bundle.workspaces).toHaveLength(1);
    expect(bundle.portForwardProfiles).toBeUndefined();
    expect(JSON.stringify(bundle)).not.toMatch(/token|password|secret/i);
  });

  it("summarizes and merges an import", () => {
    const target = load({}).settings;
    const source = settingsWith();
    const bundle = buildBundle(source, {
      parts: new Set(["preferences", "workspaces", "pinnedResources"]),
      includeMachine: true,
      appVersion: "1.40.0",
      themes: [],
    });
    const parsed = parseBundle(JSON.stringify(bundle));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const summary = summarizeBundle(target, parsed.bundle);
    expect(summary.map((part) => part.part)).toEqual(["preferences", "workspaces", "pinnedResources"]);
    expect(summary.find((part) => part.part === "workspaces")?.detail).toBe("1 new");

    applyPreferences(target, mergedPreferences(target, parsed.bundle.preferences!));
    applyBundleCollections(target, parsed.bundle, new Set(["workspaces", "pinnedResources"]));
    expect(target.terminal.localShell).toBe("/usr/bin/fish");
    expect(target.workspaces.map((w) => w.id)).toEqual(["ws-1"]);
    expect(target.pinnedResources).toEqual([{ name: "pods", kind: "Pod" }]);
  });

  it("imports a plain settings.json as preferences", () => {
    const parsed = parseBundle(JSON.stringify({ version: 2, editor: { minimap: true } }));
    expect(parsed.ok && getPath(parsed.bundle.preferences, "editor.minimap")).toBe(true);
    expect(parseBundle("{}").ok).toBe(false);
    expect(parseBundle("not json").ok).toBe(false);
    expect(parseBundle(JSON.stringify({ format: "jet-pilot-settings", version: 99 })).ok).toBe(false);
  });
});

describe("paths", () => {
  it("deletePath removes emptied parents", () => {
    const object = { a: { b: { c: 1 } }, d: 2 };
    deletePath(object, "a.b.c");
    expect(object).toEqual({ d: 2 });
  });
});

describe("mergeKubeconfigPaths", () => {
  const detected = [
    { path: "/home/me/.kube/config", origin: "default" as const, readable: true, contextCount: 2, contextNames: [] },
    { path: "/home/me/.kube/broken.yaml", origin: "directory" as const, readable: false, contextCount: 0, contextNames: [] },
    { path: "/home/me/clusters/lab.yaml", origin: "env" as const, readable: true, contextCount: 1, contextNames: [] },
  ];
  it("lists added files first, then readable detected ones, without duplicates", () => {
    expect(mergeKubeconfigPaths(["/home/me/clusters/lab.yaml/", " "], detected, "/home/me/.kube/config")).toEqual([
      "/home/me/clusters/lab.yaml/",
      "/home/me/.kube/config",
    ]);
  });
  it("falls back to ~/.kube/config", () => {
    expect(mergeKubeconfigPaths([], null, "/home/me/.kube/config")).toEqual(["/home/me/.kube/config"]);
    expect(mergeKubeconfigPaths([], [], "")).toEqual([]);
  });
});

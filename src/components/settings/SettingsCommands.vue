<script setup lang="ts">
/*
 * Command palette entries for settings: "Change a setting…" (every
 * preference by category: switches toggle, choices drill down, the rest
 * opens the setting), one search-only item per preference (type "font size"
 * in the palette), and settings.json / import / export.
 */
import { useRouter } from "vue-router";
import type { Command } from "@/command-palette";
import { injectStrict } from "@/lib/utils";
import { useToast } from "@/components/ui/toast";
import { RegisterCommandStateKey } from "@/providers/CommandPaletteProvider";
import { SettingsContextStateKey } from "@/providers/SettingsContextProvider";
import { CATEGORIES } from "@/lib/settings/categories";
import { SETTINGS } from "@/lib/settings/registry";
import { formatSettingValue, validateSetting } from "@/lib/settings/values";
import { getPath, setPath, type JsonObject } from "@/lib/settings/paths";
import type { SettingDefinition } from "@/lib/settings/types";
import { openWelcome } from "@/lib/welcome";
import { openAddCluster } from "@/lib/clusters/managed";
import { CLOUD_PROVIDERS } from "@/lib/clusters/providers";
import { type as getOsType } from "@tauri-apps/plugin-os";

const isMac = getOsType() === "macos";

const registerCommand = injectStrict(RegisterCommandStateKey);
const { settings } = injectStrict(SettingsContextStateKey);
const router = useRouter();
const { toast } = useToast();

const visible = SETTINGS.filter((def) => !def.hidden);
const categoryTitle = (def: SettingDefinition) =>
  CATEGORIES.find((category) => category.id === def.category)?.title ?? "";
const sectionTitle = (def: SettingDefinition) =>
  CATEGORIES.find((category) => category.id === def.category)?.sections.find((s) => s.id === def.section)
    ?.title ?? "";

const current = (def: SettingDefinition) => getPath(settings.value, def.key);

const set = (def: SettingDefinition, value: unknown) => {
  const result = validateSetting(def, value);
  if (!result.ok) return;
  setPath(settings.value as unknown as JsonObject, def.key, result.value);
  toast({ title: `${def.label}: ${formatSettingValue(def, result.value)}` });
};

const reveal = (def: SettingDefinition) =>
  router.push({ name: "SettingsCategory", params: { category: def.category }, query: { setting: def.key } });

/* What choosing a setting does: toggle, pick a value, or open it. */
const behaviour = (def: SettingDefinition): Pick<Command, "execute" | "commands"> => {
  if (def.type === "boolean") {
    return { execute: () => set(def, !current(def)) };
  }
  if (def.type === "enum") {
    return {
      commands: async () =>
        def.options.map((option) => ({
          id: `setting:${def.key}:${option.value}`,
          name: option.label,
          description: option.description,
          badge: current(def) === option.value ? "Current" : undefined,
          execute: () => set(def, option.value),
        })),
    } as Pick<Command, "execute" | "commands">;
  }
  return { execute: () => reveal(def) };
};

const settingCommand = (def: SettingDefinition, extra: Partial<Command>): Command =>
  ({
    id: `setting:${def.key}`,
    name: def.label,
    description: `${categoryTitle(def)} › ${sectionTitle(def)}`,
    keywords: [def.key, ...(def.keywords ?? []), categoryTitle(def), "setting", "preference"],
    get badge() {
      return formatSettingValue(def, current(def));
    },
    ...behaviour(def),
    ...extra,
  }) as Command;

registerCommand({
  id: "change-setting",
  name: "Change a setting…",
  description: "Every preference, by category",
  keywords: ["settings", "preferences", "options", "configure"],
  cacheKey: () => visible.map((def) => JSON.stringify(current(def))).join("|"),
  commands: async () => visible.map((def) => settingCommand(def, { id: `option:${def.key}`, group: categoryTitle(def), description: sectionTitle(def) })),
});

for (const def of visible) {
  registerCommand(settingCommand(def, { searchOnly: true }));
}

registerCommand({
  id: "add-cluster",
  name: "Add cluster…",
  description: "Connect AWS, paste a kubeconfig, import a file or enter a cluster",
  keywords: ["kubeconfig", "import", "paste", "new cluster", "connect", "context"],
  shortcut: [isMac ? "⌘" : "Ctrl", "N"],
  execute: () => openAddCluster(),
});

registerCommand({
  id: "connect-cloud",
  name: "Connect a cloud account…",
  description: "AWS, Google Cloud, Azure, DigitalOcean and more: find and add their clusters",
  keywords: ["cloud", "account", "aws", "gcp", "azure", "digitalocean", "linode", "civo", "scaleway", "vultr", "exoscale"],
  execute: () => openAddCluster("cloud"),
});

/* One searchable "Connect <cloud>…" per provider. */
for (const cloud of CLOUD_PROVIDERS) {
  registerCommand({
    id: `connect-${cloud.id}`,
    name: `Connect ${cloud.name}…`,
    description: `Find and add ${cloud.product} clusters`,
    keywords: [cloud.id, cloud.product.toLowerCase(), "cloud", "account", ...(cloud.cli ? [cloud.cli.tool] : [])],
    searchOnly: true,
    execute: () => openAddCluster("cloud", { provider: cloud.id }),
  });
}

registerCommand({
  id: "cloud-accounts",
  name: "Cloud accounts",
  description: "The cloud accounts JET Pilot finds clusters in",
  keywords: ["cloud", "aws", "gcp", "azure", "accounts", "connections", "sign in", "catalog"],
  execute: () => router.push({ name: "ClustersHub", query: { tab: "accounts" } }),
});

registerCommand({
  id: "open-setup-guide",
  name: "Open setup guide",
  description: "Kubeconfig files, tools, appearance and cloud accounts",
  keywords: ["welcome", "onboarding", "setup", "getting started", "tour"],
  execute: openWelcome,
});

registerCommand({
  id: "open-settings-json",
  name: "Open settings.json",
  description: "Edit your preferences as JSON",
  keywords: ["settings", "json", "preferences", "config"],
  execute: () => router.push({ name: "SettingsJson" }),
});

registerCommand({
  id: "export-settings",
  name: "Export settings…",
  description: "Preferences, workspaces and themes in one file",
  keywords: ["settings", "backup", "export", "migrate"],
  execute: () => router.push({ name: "SettingsCategory", params: { category: "general" }, query: { action: "export" } }),
});

registerCommand({
  id: "import-settings",
  name: "Import settings…",
  description: "From an exported file or a settings.json",
  keywords: ["settings", "restore", "import"],
  execute: () => router.push({ name: "SettingsCategory", params: { category: "general" }, query: { action: "import" } }),
});
</script>

<template>
  <slot />
</template>

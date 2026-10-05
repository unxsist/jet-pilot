<script setup lang="ts">
/*
 * Settings › General › Your settings: open settings.json, export / import a
 * settings file (preferences, workspaces, port-forward profiles, themes...)
 * and reset every preference. `?action=import|export` (palette) opens the
 * dialogs.
 */
import { useRoute, useRouter } from "vue-router";
import { getVersion } from "@tauri-apps/api/app";
import { open, save } from "@tauri-apps/plugin-dialog";
import { readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";
import { Braces, Download, RotateCcw, Upload } from "lucide-vue-next";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import SettingsSection from "@/components/settings/SettingsSection.vue";
import { settingsRow } from "@/components/settings/styles";
import { useToast } from "@/components/ui/toast";
import { useTheme } from "@/providers/ThemeProvider";
import {
  SettingsContextStateKey,
  SettingsFileApiKey,
} from "@/providers/SettingsContextProvider";
import { injectStrict } from "@/lib/utils";
import {
  BUNDLE_PARTS,
  applyBundleCollections,
  buildBundle,
  bundleThemes,
  exportCounts,
  mergedPreferences,
  parseBundle,
  summarizeBundle,
  type BundlePart,
  type PartSummary,
  type SettingsBundle,
} from "@/lib/settings/bundle";
import { serializeJson } from "@/lib/settings/store";
import type { ThemeFile } from "@/lib/themes/types";

const route = useRoute();
const router = useRouter();
const { settings } = injectStrict(SettingsContextStateKey);
const settingsApi = injectStrict(SettingsFileApiKey);
const theme = useTheme();
const { toast } = useToast();

const message = (e: unknown) => (e as { message?: string })?.message ?? String(e);

/* ------------------------------------------------------------ export -- */

const userThemes = computed<ThemeFile[]>(() =>
  theme.themes.value.filter((entry) => entry.source !== "builtin" && entry.file).map((entry) => entry.file!)
);

const exportOpen = ref(false);
const exportParts = ref(new Set<BundlePart>(BUNDLE_PARTS.map(({ part }) => part)));
const includeMachine = ref(false);
const counts = computed(() => exportCounts(settings.value, userThemes.value.length));

const toggle = (parts: Set<BundlePart>, part: BundlePart, on: boolean) => {
  const next = new Set(parts);
  if (on) next.add(part);
  else next.delete(part);
  return next;
};

const runExport = async () => {
  try {
    const path = await save({
      title: "Export settings",
      defaultPath: "jet-pilot-settings.json",
      filters: [{ name: "JET Pilot settings", extensions: ["json"] }],
    });
    if (!path) return;
    const bundle = buildBundle(settings.value, {
      parts: exportParts.value,
      includeMachine: includeMachine.value,
      appVersion: await getVersion(),
      themes: userThemes.value,
    });
    await writeTextFile(path, serializeJson(bundle));
    exportOpen.value = false;
    toast({ title: "Settings exported", description: path, variant: "success" });
  } catch (e) {
    toast({ title: "Couldn't export your settings", description: message(e), variant: "destructive" });
  }
};

/* ------------------------------------------------------------ import -- */

const importOpen = ref(false);
const importing = ref(false);
const importFile = ref<{ path: string; bundle: SettingsBundle; summary: PartSummary[] } | null>(null);
const importParts = ref(new Set<BundlePart>());

const pickImport = async () => {
  const path = await open({
    title: "Import settings",
    multiple: false,
    filters: [{ name: "JET Pilot settings", extensions: ["json"] }],
  });
  if (!path || Array.isArray(path)) return;
  try {
    const parsed = parseBundle(await readTextFile(path));
    if (!parsed.ok) {
      toast({ title: "Couldn't import this file", description: parsed.message, variant: "destructive" });
      return;
    }
    const summary = summarizeBundle(settings.value, parsed.bundle);
    if (summary.length === 0) {
      toast({ title: "Nothing to import", description: "The file has no settings JET Pilot can use." });
      return;
    }
    importFile.value = { path, bundle: parsed.bundle, summary };
    importParts.value = new Set(summary.map((item) => item.part));
    importOpen.value = true;
  } catch (e) {
    toast({ title: "Couldn't read the file", description: message(e), variant: "destructive" });
  }
};

const runImport = async () => {
  const file = importFile.value;
  if (!file) return;
  importing.value = true;
  const parts = importParts.value;
  try {
    let ignored = 0;
    if (parts.has("preferences") && file.bundle.preferences) {
      ignored = settingsApi.applyPreferences(mergedPreferences(settings.value, file.bundle.preferences)).length;
    }
    applyBundleCollections(settings.value, file.bundle, parts);
    if (parts.has("themes")) {
      const themes = bundleThemes(file.bundle);
      if (themes.length) await theme.install(themes, "user");
    }
    importOpen.value = false;
    toast({
      title: "Settings imported",
      description: ignored ? `${ignored} invalid ${ignored === 1 ? "value was" : "values were"} skipped.` : undefined,
      variant: "success",
    });
  } catch (e) {
    toast({ title: "Import failed partway", description: message(e), variant: "destructive" });
  } finally {
    importing.value = false;
  }
};

/* ------------------------------------------------------------- reset -- */

const resetOpen = ref(false);
const resetAll = () => {
  settingsApi.resetPreferences();
  resetOpen.value = false;
  toast({ title: "Preferences reset", description: "Workspaces, themes and port forwards were kept." });
};

/* Palette: Settings › Import / Export. */
watch(
  () => route.query.action,
  (action) => {
    if (action !== "import" && action !== "export") return;
    router.replace({ query: { ...route.query, action: undefined } });
    if (action === "export") exportOpen.value = true;
    else void pickImport();
  },
  { immediate: true }
);
</script>

<template>
  <SettingsSection
    title="Your settings"
    description="Edit settings.json directly, move your setup to another machine, or start over"
  >
    <div :class="settingsRow">
      <div class="space-y-1">
        <p class="text-sm font-medium">settings.json</p>
        <p class="text-xs text-muted-foreground">
          Every preference as JSON, with validation and completion. Only values you changed are stored.
        </p>
      </div>
      <div class="flex sm:justify-end">
        <Button size="sm" variant="outline" @click="router.push({ name: 'SettingsJson' })">
          <Braces class="h-3.5 w-3.5" />
          Open settings.json
        </Button>
      </div>
    </div>
    <div :class="settingsRow">
      <div class="space-y-1">
        <p class="text-sm font-medium">Export and import</p>
        <p class="text-xs text-muted-foreground">
          Preferences, workspaces, port-forward profiles and your themes in one file. Never credentials.
        </p>
      </div>
      <div class="flex gap-2 sm:justify-end">
        <Button size="sm" variant="outline" @click="pickImport">
          <Upload class="h-3.5 w-3.5" />
          Import…
        </Button>
        <Button size="sm" variant="outline" @click="exportOpen = true">
          <Download class="h-3.5 w-3.5" />
          Export…
        </Button>
      </div>
    </div>
    <div :class="settingsRow">
      <div class="space-y-1">
        <p class="text-sm font-medium">Reset preferences</p>
        <p class="text-xs text-muted-foreground">
          Every preference back to its default. Workspaces, themes and port forwards stay.
        </p>
      </div>
      <div class="flex sm:justify-end">
        <Button size="sm" variant="outline" class="text-destructive" @click="resetOpen = true">
          <RotateCcw class="h-3.5 w-3.5" />
          Reset…
        </Button>
      </div>
    </div>
  </SettingsSection>

  <Dialog v-model:open="exportOpen">
    <DialogContent class="max-w-md">
      <DialogHeader>
        <DialogTitle>Export settings</DialogTitle>
        <DialogDescription>Choose what goes into the file. Credentials are never included.</DialogDescription>
      </DialogHeader>
      <div class="space-y-2.5 py-1">
        <label
          v-for="{ part, label } in BUNDLE_PARTS"
          :key="part"
          class="flex items-center gap-3 text-sm"
          :class="counts[part] === 0 ? 'text-muted-foreground' : ''"
        >
          <Checkbox
            :checked="exportParts.has(part) && counts[part] > 0"
            :disabled="counts[part] === 0"
            @update:checked="(on: boolean) => (exportParts = toggle(exportParts, part, on))"
          />
          <span class="flex-1">{{ label }}</span>
          <span class="text-xs tabular-nums text-muted-foreground">
            {{ part === "preferences" ? `${counts[part]} changed` : counts[part] }}
          </span>
        </label>
        <label class="flex items-start gap-3 border-t border-border-subtle pt-3 text-sm">
          <Checkbox v-model:checked="includeMachine" class="mt-0.5" />
          <span class="space-y-0.5">
            <span class="block">Include machine-specific preferences</span>
            <span class="block text-xs text-muted-foreground">Kubeconfig paths and the local shell.</span>
          </span>
        </label>
      </div>
      <DialogFooter>
        <Button variant="ghost" @click="exportOpen = false">Cancel</Button>
        <Button @click="runExport">Export…</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>

  <Dialog v-model:open="importOpen">
    <DialogContent class="max-w-md">
      <DialogHeader>
        <DialogTitle>Import settings</DialogTitle>
        <DialogDescription class="truncate" :title="importFile?.path">
          From {{ importFile?.path }}. Imported values win; everything else stays as it is.
        </DialogDescription>
      </DialogHeader>
      <div class="space-y-2.5 py-1">
        <label v-for="item in importFile?.summary ?? []" :key="item.part" class="flex items-center gap-3 text-sm">
          <Checkbox
            :checked="importParts.has(item.part)"
            @update:checked="(on: boolean) => (importParts = toggle(importParts, item.part, on))"
          />
          <span class="flex-1">{{ item.label }}</span>
          <span class="text-xs text-muted-foreground">{{ item.detail }}</span>
        </label>
      </div>
      <DialogFooter>
        <Button variant="ghost" @click="importOpen = false">Cancel</Button>
        <Button :disabled="importParts.size === 0 || importing" @click="runImport">Import</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>

  <AlertDialog v-model:open="resetOpen">
    <AlertDialogContent>
      <AlertDialogHeader>
        <AlertDialogTitle>Reset every preference?</AlertDialogTitle>
        <AlertDialogDescription>
          Appearance, terminal, editor, tables, logs, kubeconfig and advanced preferences go back to
          their defaults. Workspaces, themes, port forwards and open tabs are kept.
        </AlertDialogDescription>
      </AlertDialogHeader>
      <AlertDialogFooter>
        <AlertDialogCancel>Cancel</AlertDialogCancel>
        <AlertDialogAction class="bg-destructive text-destructive-foreground hover:bg-destructive/90" @click="resetAll">
          Reset preferences
        </AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>
</template>

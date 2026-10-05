<script setup lang="ts">
/*
 * Settings › Clusters › Kubeconfig files: the files contexts are loaded
 * from. Files the user added (kubeconfig.sources) and, with auto-detection
 * on (kubeconfig.autoDetect), ~/.kube/config, $KUBECONFIG, ~/.kube/*.yaml
 * and ~/.kube/config.d. JET Pilot only reads these files.
 */
import { homeDir, join } from "@tauri-apps/api/path";
import { open } from "@tauri-apps/plugin-dialog";
import { FolderOpen, Plus, RefreshCw } from "lucide-vue-next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import SettingsSection from "@/components/settings/SettingsSection.vue";
import SettingRow from "@/components/settings/SettingRow.vue";
import KubeconfigFileRow from "@/components/settings/sections/KubeconfigFileRow.vue";
import { settingsBlock } from "@/components/settings/styles";
import { SETTINGS_BY_KEY } from "@/lib/settings/registry";
import { SettingsContextStateKey } from "@/providers/SettingsContextProvider";
import { Kubernetes } from "@/services/Kubernetes";
import { injectStrict } from "@/lib/utils";
import {
  ORIGIN_LABELS,
  discoverKubeconfigs,
  discoveredKubeconfigs,
  expandHome,
  normalizeKubeconfigPath,
} from "@/lib/kubeconfigSources";

const { settings } = injectStrict(SettingsContextStateKey);
const autoDetectDef = SETTINGS_BY_KEY.get("kubeconfig.autoDetect")!;

const sources = computed(() => settings.value.kubeconfig.sources);
const autoDetect = computed(() => settings.value.kubeconfig.autoDetect);

/* Context counts of the added files (list_contexts), by path. */
const status = reactive(new Map<string, { count: number | null; error: string | null }>());
const checkSource = async (path: string) => {
  status.set(path, { count: null, error: null });
  try {
    const contexts = await Kubernetes.getContexts(await expandHome(path));
    status.set(path, { count: contexts.length, error: null });
  } catch (e) {
    status.set(path, { count: null, error: (e as { message?: string })?.message ?? String(e) });
  }
};
watch(
  sources,
  (paths) => {
    for (const path of paths) if (!status.has(path)) void checkSource(path);
  },
  { immediate: true, deep: true }
);

const scanning = ref(false);
const scan = async () => {
  scanning.value = true;
  try {
    await discoverKubeconfigs(true);
    for (const path of sources.value) void checkSource(path);
  } finally {
    scanning.value = false;
  }
};
onMounted(() => {
  if (autoDetect.value) void discoverKubeconfigs();
});
watch(autoDetect, (on) => on && void discoverKubeconfigs());

const added = computed(() => new Set(sources.value.map(normalizeKubeconfigPath)));
const detected = computed(() => discoveredKubeconfigs.value ?? []);

const addPaths = (paths: string[]) => {
  for (const path of paths) {
    const trimmed = path.trim();
    if (trimmed && !added.value.has(normalizeKubeconfigPath(trimmed))) {
      settings.value.kubeconfig.sources.push(trimmed);
    }
  }
};

const browse = async () => {
  const selected = await open({
    multiple: true,
    title: "Add kubeconfig files",
    defaultPath: await join(await homeDir(), ".kube"),
  });
  if (selected) addPaths(Array.isArray(selected) ? selected : [selected]);
};

const typing = ref(false);
const typedPath = ref("");
const typedInput = ref<InstanceType<typeof Input> | null>(null);
const startTyping = () => {
  typing.value = true;
  typedPath.value = "";
  nextTick(() => typedInput.value?.focus());
};
const addTyped = () => {
  addPaths([typedPath.value]);
  typing.value = false;
};

const remove = (index: number) => {
  const [path] = settings.value.kubeconfig.sources.splice(index, 1);
  if (path) status.delete(path);
};
</script>

<template>
  <SettingsSection
    title="Kubeconfig files"
    description="Where your contexts come from. JET Pilot reads these files and never changes them."
  >
    <template #actions>
      <Button size="sm" variant="ghost" :disabled="scanning" @click="scan">
        <RefreshCw class="h-3.5 w-3.5" :class="scanning ? 'animate-spin' : ''" />
        Check again
      </Button>
    </template>

    <SettingRow :def="autoDetectDef" />

    <div :class="settingsBlock">
      <div class="flex items-baseline justify-between gap-4">
        <h3 class="text-xs font-medium text-muted-foreground">Added by you</h3>
      </div>
      <div v-if="sources.length" class="overflow-hidden rounded-md border">
        <KubeconfigFileRow
          v-for="(path, index) in sources"
          :key="path"
          :path="path"
          :context-count="status.get(path)?.count ?? null"
          :error="status.get(path)?.error"
          removable
          @remove="remove(index)"
        />
      </div>
      <p v-else class="text-xs text-muted-foreground">
        No extra files. Add kubeconfig files that aren't found automatically.
      </p>
      <form v-if="typing" class="flex items-center gap-2" @submit.prevent="addTyped">
        <Input
          ref="typedInput"
          v-model="typedPath"
          placeholder="~/clusters/staging.yaml"
          aria-label="Path to a kubeconfig file"
          spellcheck="false"
          class="flex-1 font-mono text-xs"
          @keydown.esc.stop="typing = false"
        />
        <Button size="sm" type="submit" :disabled="!typedPath.trim()">Add</Button>
        <Button size="sm" variant="ghost" type="button" @click="typing = false">Cancel</Button>
      </form>
      <div v-else class="flex justify-end gap-2">
        <Button size="sm" variant="ghost" @click="startTyping">Type a path</Button>
        <Button size="sm" variant="outline" @click="browse">
          <FolderOpen class="h-3.5 w-3.5" />
          Add files…
        </Button>
      </div>
    </div>

    <div v-if="autoDetect" :class="settingsBlock">
      <h3 class="text-xs font-medium text-muted-foreground">Found automatically</h3>
      <div v-if="detected.length" class="overflow-hidden rounded-md border">
        <KubeconfigFileRow
          v-for="file in detected"
          :key="file.path"
          :path="file.path"
          :origin="ORIGIN_LABELS[file.origin]"
          :context-count="file.readable ? file.contextCount : null"
          :error="file.readable ? null : (file.error ?? 'Not readable')"
          :duplicate="added.has(normalizeKubeconfigPath(file.path))"
        />
      </div>
      <p v-else-if="discoveredKubeconfigs" class="flex items-center gap-2 text-xs text-muted-foreground">
        <Plus class="h-3.5 w-3.5" />
        No kubeconfig files in ~/.kube or $KUBECONFIG yet.
      </p>
      <p v-else class="text-xs text-muted-foreground">Looking for kubeconfig files…</p>
    </div>
  </SettingsSection>
</template>

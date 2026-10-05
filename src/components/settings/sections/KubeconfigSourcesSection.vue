<script setup lang="ts">
/*
 * Settings › Clusters › Kubeconfig files: the files contexts are loaded
 * from. Files the user added (kubeconfig.sources) and, with auto-detection
 * on (kubeconfig.autoDetect), ~/.kube/config, $KUBECONFIG, ~/.kube/*.yaml
 * and ~/.kube/config.d. JET Pilot only reads these files.
 */
import { homeDir, join } from "@tauri-apps/api/path";
import { open } from "@tauri-apps/plugin-dialog";
import { Loader2, Plus, RefreshCw } from "lucide-vue-next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import SettingsSection from "@/components/settings/SettingsSection.vue";
import SettingRow from "@/components/settings/SettingRow.vue";
import KubeconfigFileRow from "@/components/settings/sections/KubeconfigFileRow.vue";
import { SETTINGS_BY_KEY } from "@/lib/settings/registry";
import { SettingsContextStateKey } from "@/providers/SettingsContextProvider";
import { Kubernetes } from "@/services/Kubernetes";
import { injectStrict } from "@/lib/utils";
import {
  discoverKubeconfigs,
  discoveredKubeconfigs,
  expandHome,
  normalizeKubeconfigPath,
  type KubeconfigOrigin,
} from "@/lib/kubeconfigSources";

const { settings } = injectStrict(SettingsContextStateKey);

/* Where a file was found, as its row's subtitle. */
const ORIGINS: Record<KubeconfigOrigin, string> = {
  managed: "Added in JET Pilot",
  default: "Default kubeconfig",
  env: "From $KUBECONFIG",
  directory: "In ~/.kube",
  configD: "In ~/.kube/config.d",
};
const home = ref("");
onMounted(() => homeDir().then((dir) => (home.value = dir.replace(/[\\/]+$/, "")), () => undefined));

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
    description="Where your contexts come from. JET Pilot only reads these files."
  >
    <template #actions>
      <Button
        size="icon-sm"
        variant="ghost"
        class="text-muted-foreground"
        :disabled="scanning"
        title="Check the files again"
        aria-label="Check the files again"
        @click="scan"
      >
        <RefreshCw class="h-3.5 w-3.5" :class="scanning ? 'animate-spin' : ''" />
      </Button>
      <Button size="sm" variant="outline" @click="browse">
        <Plus class="h-3.5 w-3.5" />
        Add files…
      </Button>
    </template>

    <SettingRow :def="autoDetectDef" />

    <div class="space-y-6 py-5">
      <div class="space-y-1">
        <div class="flex h-7 items-center justify-between gap-4">
          <h3 class="text-xs font-medium text-muted-foreground">
            Added by you<span v-if="sources.length" class="ml-1.5 font-normal tabular-nums">{{ sources.length }}</span>
          </h3>
          <button
            v-if="!typing"
            type="button"
            class="-mr-1.5 rounded-md px-1.5 py-0.5 text-xs text-muted-foreground transition-colors duration-fast hover:bg-accent/50 hover:text-foreground focus-ring"
            @click="startTyping"
          >
            Type a path
          </button>
        </div>
        <div v-if="sources.length" class="-mx-3 space-y-px">
          <KubeconfigFileRow
            v-for="(path, index) in sources"
            :key="path"
            :path="path"
            :home="home"
            :context-count="status.get(path)?.count ?? null"
            :error="status.get(path)?.error"
            removable
            @remove="remove(index)"
          />
        </div>
        <p v-else-if="!typing" class="text-xs text-muted-foreground">
          None yet. Add files that aren't found automatically.
        </p>
        <form v-if="typing" class="flex items-center gap-2 pt-1" @submit.prevent="addTyped">
          <Input
            ref="typedInput"
            v-model="typedPath"
            placeholder="~/clusters/staging.yaml"
            aria-label="Path to a kubeconfig file"
            spellcheck="false"
            class="flex-1 font-mono text-xs"
            @keydown.esc.stop="typing = false"
          />
          <Button size="sm" variant="ghost" type="button" @click="typing = false">Cancel</Button>
          <Button size="sm" type="submit" :disabled="!typedPath.trim()">Add</Button>
        </form>
      </div>

      <div v-if="autoDetect" class="space-y-1">
        <h3 class="flex h-7 items-center text-xs font-medium text-muted-foreground">
          Found automatically<span v-if="detected.length" class="ml-1.5 font-normal tabular-nums">{{ detected.length }}</span>
        </h3>
        <div v-if="detected.length" class="-mx-3 space-y-px">
          <KubeconfigFileRow
            v-for="file in detected"
            :key="file.path"
            :path="file.path"
            :home="home"
            :origin="ORIGINS[file.origin]"
            :context-count="file.readable ? file.contextCount : null"
            :error="file.readable ? null : (file.error ?? 'Not readable')"
            :duplicate="added.has(normalizeKubeconfigPath(file.path))"
          />
        </div>
        <p v-else-if="discoveredKubeconfigs" class="text-xs text-muted-foreground">
          No kubeconfig files in ~/.kube or $KUBECONFIG yet.
        </p>
        <p v-else class="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 class="h-3.5 w-3.5 animate-spin" /> Looking for kubeconfig files…
        </p>
      </div>
    </div>
  </SettingsSection>
</template>

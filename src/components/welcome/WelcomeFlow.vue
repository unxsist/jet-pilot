<script setup lang="ts">
/*
 * The setup guide (fresh installs; reopen from the palette): the kubeconfig
 * files JET Pilot found, the command-line tools it uses, how it looks, and
 * the cloud accounts to find clusters in.
 * Everything here can be changed later in Settings; every step can be
 * skipped.
 */
import { useRouter } from "vue-router";
import { homeDir, join } from "@tauri-apps/api/path";
import { open } from "@tauri-apps/plugin-dialog";
import { type as getOsType } from "@tauri-apps/plugin-os";
import { ArrowLeft, ArrowRight, Check, CheckCircle2, FolderOpen, Loader2, Sparkles } from "lucide-vue-next";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import KubeconfigFileRow from "@/components/settings/sections/KubeconfigFileRow.vue";
import { openAddCluster } from "@/lib/clusters/managed";
import ProviderMark from "@/components/clusters/ProviderMark.vue";
import { CONNECTION_KIND_LABELS } from "@/lib/clusters/cloud";
import { connections, loadCloud, watchCloud } from "@/lib/clusters/catalogStore";
import ToolsSection from "@/components/settings/sections/ToolsSection.vue";
import ColorSchemeSection from "@/components/settings/sections/ColorSchemeSection.vue";
import ThemeLibrary from "@/components/settings/themes/ThemeLibrary.vue";
import { injectStrict, cn } from "@/lib/utils";
import { SettingsContextStateKey } from "@/providers/SettingsContextProvider";
import {
  ORIGIN_LABELS,
  discoverKubeconfigs,
  discoveredKubeconfigs,
  normalizeKubeconfigPath,
} from "@/lib/kubeconfigSources";

const emit = defineEmits<{ finish: [] }>();

const router = useRouter();
const { settings } = injectStrict(SettingsContextStateKey);
const isMac = getOsType() === "macos";
const mod = isMac ? "⌘" : "Ctrl";

const STEPS = [
  { id: "clusters", title: "Your clusters" },
  { id: "tools", title: "Tools" },
  { id: "appearance", title: "Appearance" },
  { id: "cloud", title: "Cloud accounts" },
  { id: "done", title: "Ready" },
] as const;
const step = ref(0);
const next = () => (step.value = Math.min(STEPS.length - 1, step.value + 1));
const back = () => (step.value = Math.max(0, step.value - 1));

onMounted(() => {
  void discoverKubeconfigs(true);
  watchCloud();
  void loadCloud();
});
const detected = computed(() => discoveredKubeconfigs.value ?? null);
const readable = computed(() => (detected.value ?? []).filter((file) => file.readable));
const contextCount = computed(() => readable.value.reduce((count, file) => count + file.contextCount, 0));

const added = computed(() => settings.value.kubeconfig.sources);
const addFiles = async () => {
  const picked = await open({ multiple: true, title: "Add kubeconfig files", defaultPath: await join(await homeDir(), ".kube") });
  if (!picked) return;
  for (const path of Array.isArray(picked) ? picked : [picked]) {
    const key = normalizeKubeconfigPath(path);
    if (!added.value.some((source) => normalizeKubeconfigPath(source) === key)) settings.value.kubeconfig.sources.push(path);
  }
};

const finish = (goToHub: boolean) => {
  emit("finish");
  if (goToHub) router.push({ name: "ClustersHub" });
};
</script>

<template>
  <div class="absolute inset-0 z-[45] flex flex-col bg-background" role="dialog" aria-modal="true" aria-label="Set up JET Pilot">
    <header class="flex h-12 shrink-0 items-center gap-4 border-b px-6" data-tauri-drag-region>
      <Sparkles class="h-4 w-4 text-primary" />
      <span class="text-sm font-semibold">Set up JET Pilot</span>
      <ol class="ml-6 flex items-center gap-1" aria-label="Steps">
        <li v-for="(item, index) in STEPS" :key="item.id" class="flex items-center gap-1">
          <button
            type="button"
            :class="
              cn(
                'flex h-6 items-center gap-1.5 rounded-full px-2.5 text-xs transition-colors duration-fast focus-ring',
                index === step ? 'bg-primary/10 font-medium text-link' : index < step ? 'text-foreground hover:bg-accent' : 'text-muted-foreground hover:bg-accent'
              )
            "
            :aria-current="index === step ? 'step' : undefined"
            @click="step = index"
          >
            <Check v-if="index < step" class="h-3 w-3 text-success" />
            <span v-else class="tabular-nums">{{ index + 1 }}</span>
            {{ item.title }}
          </button>
          <span v-if="index < STEPS.length - 1" class="h-px w-4 bg-border" aria-hidden="true" />
        </li>
      </ol>
      <Button variant="ghost" size="sm" class="ml-auto text-muted-foreground" @click="finish(false)">Skip setup</Button>
    </header>

    <main class="min-h-0 flex-1 overflow-auto">
      <div class="mx-auto max-w-3xl space-y-6 px-8 py-10">
        <!-- 1. Clusters -->
        <template v-if="STEPS[step]!.id === 'clusters'">
          <div class="space-y-2">
            <h1 class="text-2xl font-semibold tracking-tight">Welcome to JET Pilot</h1>
            <p class="text-sm text-muted-foreground">
              JET Pilot works with the kubeconfig files you already have. It reads them and never changes them.
            </p>
          </div>
          <div class="overflow-hidden rounded-lg border bg-card shadow-xs">
            <div class="flex items-center justify-between gap-4 border-b px-5 py-3.5">
              <div class="space-y-0.5">
                <h2 class="text-sm font-semibold">
                  <template v-if="detected === null">Looking for kubeconfig files…</template>
                  <template v-else-if="readable.length">
                    Found {{ contextCount }} {{ contextCount === 1 ? "context" : "contexts" }} in
                    {{ readable.length }} {{ readable.length === 1 ? "file" : "files" }}
                  </template>
                  <template v-else>No kubeconfig files found yet</template>
                </h2>
                <p class="text-xs text-muted-foreground">
                  ~/.kube/config, the files in $KUBECONFIG, ~/.kube/*.yaml and ~/.kube/config.d are picked up automatically.
                </p>
              </div>
              <Loader2 v-if="detected === null" class="h-4 w-4 animate-spin text-muted-foreground" />
            </div>
            <div v-if="detected?.length || added.length" class="divide-y divide-border-subtle">
              <KubeconfigFileRow
                v-for="file in detected ?? []"
                :key="file.path"
                :path="file.path"
                :origin="ORIGIN_LABELS[file.origin]"
                :context-count="file.readable ? file.contextCount : null"
                :error="file.readable ? null : (file.error ?? 'Not readable')"
              />
              <KubeconfigFileRow v-for="path in added" :key="path" :path="path" origin="Added" :context-count="null" />
            </div>
            <div class="flex items-center justify-between gap-4 border-t px-5 py-3">
              <p class="text-xs text-muted-foreground">Keep kubeconfigs somewhere else? Add them here; you can manage them later in Settings › Clusters.</p>
              <div class="flex shrink-0 gap-2">
                <Button size="sm" variant="ghost" @click="openAddCluster('choose')">Add a cluster…</Button>
                <Button size="sm" variant="outline" @click="addFiles">
                  <FolderOpen class="h-3.5 w-3.5" /> Add files…
                </Button>
              </div>
            </div>
          </div>
        </template>

        <!-- 2. Tools -->
        <template v-else-if="STEPS[step]!.id === 'tools'">
          <div class="space-y-2">
            <h1 class="text-2xl font-semibold tracking-tight">Command-line tools</h1>
            <p class="text-sm text-muted-foreground">
              JET Pilot uses kubectl for shells, logs and port forwards, Helm for releases, and your cloud's CLI to sign
              in. Anything missing that JET Pilot can download is verified against its official checksum.
            </p>
          </div>
          <ToolsSection />
        </template>

        <!-- 3. Appearance -->
        <template v-else-if="STEPS[step]!.id === 'appearance'">
          <div class="space-y-2">
            <h1 class="text-2xl font-semibold tracking-tight">Make it yours</h1>
            <p class="text-sm text-muted-foreground">Pick a mode and a theme. Hover a theme to preview it on the whole app.</p>
          </div>
          <ColorSchemeSection />
          <ThemeLibrary />
        </template>

        <!-- 4. Cloud accounts -->
        <template v-else-if="STEPS[step]!.id === 'cloud'">
          <div class="space-y-2">
            <h1 class="text-2xl font-semibold tracking-tight">Connect a cloud account</h1>
            <p class="text-sm text-muted-foreground">
              JET Pilot finds the clusters in your cloud accounts, keeps the list current and signs in to them for you, in
              the app and in your terminal. Optional: kubeconfig files keep working as they are.
            </p>
          </div>
          <div class="overflow-hidden rounded-lg border bg-card shadow-xs">
            <div class="flex items-center gap-4 px-5 py-4">
              <span class="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-surface-1">
                <ProviderMark provider="aws" :size="24" />
              </span>
              <div class="min-w-0 flex-1 space-y-0.5">
                <h2 class="text-sm font-semibold">Amazon Web Services</h2>
                <p class="text-xs text-muted-foreground">
                  EKS clusters in every account and region you can reach. Sign in with IAM Identity Center, an AWS profile
                  or access keys.
                </p>
              </div>
              <Button size="sm" :variant="connections?.length ? 'outline' : 'default'" @click="openAddCluster('aws')">
                {{ connections?.length ? "Connect another" : "Connect AWS" }}
              </Button>
            </div>
            <ul v-if="connections?.length" class="divide-y divide-border-subtle border-t">
              <li v-for="connection in connections" :key="connection.id" class="flex items-center gap-3 px-5 py-2.5 text-sm">
                <CheckCircle2 class="h-4 w-4 text-success" />
                <span class="font-medium">{{ connection.label }}</span>
                <span class="text-xs text-muted-foreground">{{ CONNECTION_KIND_LABELS[connection.kind] }}</span>
              </li>
            </ul>
          </div>
          <p class="text-xs text-muted-foreground">You can connect accounts any time from the Clusters hub.</p>
        </template>

        <!-- 5. Done -->
        <template v-else>
          <div class="space-y-2">
            <h1 class="text-2xl font-semibold tracking-tight">You're all set</h1>
            <p class="text-sm text-muted-foreground">A few things worth knowing:</p>
          </div>
          <ul class="grid gap-3 sm:grid-cols-2">
            <li class="rounded-lg border bg-card p-4 shadow-xs">
              <p class="text-sm font-medium">Clusters hub</p>
              <p class="mt-1 text-xs text-muted-foreground">
                Every cluster in one list, with status. Give them names and colours, and mark production as protected.
              </p>
            </li>
            <li class="rounded-lg border bg-card p-4 shadow-xs">
              <p class="flex items-center gap-2 text-sm font-medium">Command palette <Kbd :keys="[mod, 'K']" size="sm" /></p>
              <p class="mt-1 text-xs text-muted-foreground">Jump to any resource, switch clusters, or type : and a kind (:po, :deploy).</p>
            </li>
            <li class="rounded-lg border bg-card p-4 shadow-xs">
              <p class="flex items-center gap-2 text-sm font-medium">Settings <Kbd :keys="[mod, ',']" size="sm" /></p>
              <p class="mt-1 text-xs text-muted-foreground">Every setting is searchable, and settings.json is there if you prefer text.</p>
            </li>
            <li class="rounded-lg border bg-card p-4 shadow-xs">
              <p class="flex items-center gap-2 text-sm font-medium">Terminal <Kbd :keys="['Ctrl', '`']" size="sm" /></p>
              <p class="mt-1 text-xs text-muted-foreground">A local shell with kubectl set up for the current cluster.</p>
            </li>
          </ul>
        </template>
      </div>
    </main>

    <footer class="flex h-14 shrink-0 items-center justify-between border-t px-6">
      <Button v-if="step > 0" variant="ghost" size="sm" @click="back">
        <ArrowLeft class="h-3.5 w-3.5" /> Back
      </Button>
      <span v-else />
      <div class="flex items-center gap-2">
        <template v-if="STEPS[step]!.id === 'done'">
          <Button variant="outline" size="sm" @click="finish(false)">Start using JET Pilot</Button>
          <Button size="sm" @click="finish(true)">Open the Clusters hub <ArrowRight class="h-3.5 w-3.5" /></Button>
        </template>
        <Button v-else size="sm" @click="next">Continue <ArrowRight class="h-3.5 w-3.5" /></Button>
      </div>
    </footer>
  </div>
</template>

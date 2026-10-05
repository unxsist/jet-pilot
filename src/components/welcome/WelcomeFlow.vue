<script setup lang="ts">
/*
 * The setup guide (fresh installs; reopen from the palette): the kubeconfig
 * files JET Pilot found, the command-line tools it uses, how it looks, and
 * the cloud accounts to find clusters in. One calm column per step under a
 * numbered progress row; everything can be changed later in Settings and
 * every step can be skipped.
 */
import { useRouter } from "vue-router";
import { homeDir, join } from "@tauri-apps/api/path";
import { open } from "@tauri-apps/plugin-dialog";
import { type as getOsType } from "@tauri-apps/plugin-os";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  CheckCircle2,
  Cloud,
  Command,
  FolderOpen,
  LayoutGrid,
  Loader2,
  Palette,
  PartyPopper,
  Settings2,
  SquareTerminal,
} from "lucide-vue-next";
import Logo from "@/assets/logo-64.png";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import KubeconfigFileRow from "@/components/settings/sections/KubeconfigFileRow.vue";
import WelcomeTools from "@/components/welcome/WelcomeTools.vue";
import ProviderMark from "@/components/clusters/ProviderMark.vue";
import { openAddCluster } from "@/lib/clusters/managed";
import { CLOUD_PROVIDERS } from "@/lib/clusters/providers";
import { connections, loadCloud, watchCloud } from "@/lib/clusters/catalogStore";
import ColorSchemeSection from "@/components/settings/sections/ColorSchemeSection.vue";
import ThemeLibrary from "@/components/settings/themes/ThemeLibrary.vue";
import { Kubernetes } from "@/services/Kubernetes";
import { injectStrict } from "@/lib/utils";
import { SettingsContextStateKey } from "@/providers/SettingsContextProvider";
import {
  ORIGIN_LABELS,
  discoverKubeconfigs,
  discoveredKubeconfigs,
  expandHome,
  normalizeKubeconfigPath,
} from "@/lib/kubeconfigSources";

const emit = defineEmits<{ finish: [] }>();

const router = useRouter();
const { settings } = injectStrict(SettingsContextStateKey);
const mod = getOsType() === "macos" ? "⌘" : "Ctrl";

const STEPS = [
  {
    id: "clusters",
    title: "Your clusters",
    icon: null,
    heading: "Welcome to JET Pilot",
    lead: "It works with the kubeconfig files you already have. It reads them and never changes them.",
  },
  {
    id: "tools",
    title: "Tools",
    icon: SquareTerminal,
    heading: "The tools behind it",
    lead: "kubectl runs shells, logs and port forwards; Helm handles releases. Missing ones download checksum-verified.",
  },
  {
    id: "appearance",
    title: "Appearance",
    icon: Palette,
    heading: "Make it yours",
    lead: "Pick a mode and a theme. Hover a theme to preview it on the whole app.",
  },
  {
    id: "cloud",
    title: "Cloud accounts",
    icon: Cloud,
    heading: "Connect a cloud account",
    lead: "JET Pilot finds the clusters in your accounts, keeps the list current and signs in for you. Optional.",
  },
  {
    id: "done",
    title: "Ready",
    icon: PartyPopper,
    heading: "You're all set",
    lead: "A few things worth knowing before you dive in.",
  },
] as const;
const step = ref(0);
const current = computed(() => STEPS[step.value]!);
const next = () => (step.value = Math.min(STEPS.length - 1, step.value + 1));
const back = () => (step.value = Math.max(0, step.value - 1));

const home = ref("");
onMounted(() => {
  void discoverKubeconfigs(true);
  watchCloud();
  void loadCloud();
  homeDir().then((dir) => (home.value = dir.replace(/[\\/]+$/, "")), () => undefined);
});
const connectedProviders = computed(() => new Set((connections.value ?? []).map((c) => c.provider)));
const detected = computed(() => discoveredKubeconfigs.value ?? null);
const readable = computed(() => (detected.value ?? []).filter((file) => file.readable));
const contextCount = computed(() => readable.value.reduce((count, file) => count + file.contextCount, 0));
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

/* Files added here (kubeconfig.sources), with their context counts. */
const added = computed(() => settings.value.kubeconfig.sources);
const addedStatus = reactive(new Map<string, { count: number | null; error?: string }>());
watch(
  added,
  (paths) => {
    for (const path of paths) {
      if (addedStatus.has(path)) continue;
      addedStatus.set(path, { count: null });
      expandHome(path)
        .then((file) => Kubernetes.getContexts(file))
        .then((contexts) => addedStatus.set(path, { count: contexts.length }))
        .catch((e) => addedStatus.set(path, { count: null, error: (e as { message?: string })?.message ?? String(e) }));
    }
  },
  { immediate: true, deep: true }
);
const addFiles = async () => {
  const picked = await open({ multiple: true, title: "Add kubeconfig files", defaultPath: await join(await homeDir(), ".kube") });
  if (!picked) return;
  for (const path of Array.isArray(picked) ? picked : [picked]) {
    const key = normalizeKubeconfigPath(path);
    if (!added.value.some((source) => normalizeKubeconfigPath(source) === key)) settings.value.kubeconfig.sources.push(path);
  }
};
const removeFile = (index: number) => settings.value.kubeconfig.sources.splice(index, 1);

const TIPS = [
  { icon: LayoutGrid, title: "Clusters hub", keys: null, text: "Every cluster in one place. Name and colour them, and protect production." },
  { icon: Command, title: "Command palette", keys: [mod, "K"], text: "Jump to any resource or cluster, or type : and a kind (:po, :deploy)." },
  { icon: Settings2, title: "Settings", keys: [mod, ","], text: "Every setting is searchable, and settings.json is there if you prefer text." },
  { icon: SquareTerminal, title: "Terminal", keys: ["Ctrl", "`"], text: "A local shell with kubectl set up for the current cluster." },
];

const finish = (goToHub: boolean) => {
  emit("finish");
  if (goToHub) router.push({ name: "ClustersHub" });
};
</script>

<template>
  <div class="absolute inset-0 z-[45] flex flex-col bg-background" role="dialog" aria-modal="true" aria-label="Set up JET Pilot">
    <header class="relative flex h-14 shrink-0 items-center justify-center px-6" data-tauri-drag-region>
      <ol class="flex items-center gap-1" aria-label="Steps">
        <li v-for="(item, index) in STEPS" :key="item.id" class="flex items-center gap-1">
          <button
            type="button"
            class="group flex h-7 items-center gap-2 rounded-full p-1 text-xs transition-colors duration-fast hover:bg-accent/60 focus-ring"
            :aria-label="item.title"
            :aria-current="index === step ? 'step' : undefined"
            @click="step = index"
          >
            <span
              class="flex h-5 w-5 items-center justify-center rounded-full text-2xs font-semibold tabular-nums transition-colors duration-base"
              :class="
                index === step
                  ? 'bg-primary text-primary-foreground'
                  : index < step
                    ? 'bg-primary/15 text-primary'
                    : 'border text-muted-foreground'
              "
            >
              <Check v-if="index < step" class="h-3 w-3" />
              <template v-else>{{ index + 1 }}</template>
            </span>
            <!-- Narrow windows: only the current step is named. -->
            <span
              class="pr-1.5"
              :class="index === step ? 'font-medium text-foreground' : 'hidden text-muted-foreground group-hover:text-foreground xl:inline'"
            >
              {{ item.title }}
            </span>
          </button>
          <span v-if="index < STEPS.length - 1" class="h-px w-5 bg-border" aria-hidden="true" />
        </li>
      </ol>
      <Button variant="ghost" size="sm" class="absolute right-4 text-muted-foreground" @click="finish(false)">Skip setup</Button>
    </header>

    <!-- Long steps fade out above the buttons instead of being cut off. -->
    <main
      class="min-h-0 flex-1 overflow-y-auto"
      style="mask-image: linear-gradient(#000 calc(100% - 2.5rem), transparent); -webkit-mask-image: linear-gradient(#000 calc(100% - 2.5rem), transparent)"
    >
      <div
        :key="current.id"
        class="mx-auto flex w-full animate-slide-up-fade flex-col gap-10 px-8 py-12"
        :class="current.id === 'appearance' ? 'max-w-3xl' : 'max-w-2xl'"
      >
        <div class="flex flex-col items-center gap-2 text-center">
          <img v-if="!current.icon" :src="Logo" alt="" class="mb-3 h-14 w-14 rounded-xl shadow-md" />
          <span v-else class="mb-3 flex h-14 w-14 items-center justify-center rounded-xl border bg-card text-primary shadow-sm">
            <component :is="current.icon" class="h-6 w-6" />
          </span>
          <h1 class="text-3xl font-semibold">{{ current.heading }}</h1>
          <p class="max-w-lg text-balance text-base text-muted-foreground">{{ current.lead }}</p>
        </div>

        <!-- 1. Clusters -->
        <div v-if="current.id === 'clusters'" class="space-y-4">
          <div class="flex items-end justify-between gap-4">
            <div class="min-w-0">
              <h2 class="flex items-center gap-2 text-sm font-medium">
                <template v-if="detected === null">
                  <Loader2 class="h-3.5 w-3.5 animate-spin text-muted-foreground" /> Looking for kubeconfig files…
                </template>
                <template v-else-if="readable.length">
                  <CheckCircle2 class="h-4 w-4 text-success" />
                  Found {{ plural(contextCount, "context") }} in {{ plural(readable.length, "file") }}
                </template>
                <template v-else>No kubeconfig files found yet</template>
              </h2>
              <p class="mt-0.5 text-xs text-muted-foreground">In ~/.kube/config, $KUBECONFIG, ~/.kube/*.yaml and ~/.kube/config.d</p>
            </div>
            <Button size="sm" variant="outline" @click="addFiles"><FolderOpen class="h-3.5 w-3.5" /> Add files…</Button>
          </div>
          <div v-if="detected?.length || added.length" class="rounded-xl border bg-card p-1.5 shadow-xs">
            <KubeconfigFileRow
              v-for="file in detected ?? []"
              :key="file.path"
              :path="file.path"
              :home="home"
              :origin="ORIGIN_LABELS[file.origin]"
              :context-count="file.readable ? file.contextCount : null"
              :error="file.readable ? null : (file.error ?? 'Not readable')"
            />
            <KubeconfigFileRow
              v-for="(path, index) in added"
              :key="path"
              :path="path"
              :home="home"
              origin="Added by you"
              :context-count="addedStatus.get(path)?.count ?? null"
              :error="addedStatus.get(path)?.error"
              removable
              @remove="removeFile(index)"
            />
          </div>
          <p class="pt-2 text-center text-xs text-muted-foreground">
            Cluster not in a kubeconfig?
            <button type="button" class="rounded-sm font-medium text-link hover:underline focus-ring" @click="openAddCluster('choose')">
              Add a cluster
            </button>
          </p>
        </div>

        <!-- 2. Tools -->
        <WelcomeTools v-else-if="current.id === 'tools'" />

        <!-- 3. Appearance -->
        <div v-else-if="current.id === 'appearance'" class="space-y-6">
          <ColorSchemeSection />
          <ThemeLibrary />
        </div>

        <!-- 4. Cloud accounts -->
        <div v-else-if="current.id === 'cloud'" class="space-y-5">
          <div class="grid grid-cols-3 gap-2.5">
            <button
              v-for="cloud in CLOUD_PROVIDERS"
              :key="cloud.id"
              type="button"
              class="group flex min-w-0 items-center gap-3 rounded-xl border bg-card px-3.5 py-3 text-left shadow-xs transition-[border-color,box-shadow] duration-fast hover:border-border-strong hover:shadow-sm focus-ring"
              :title="cloud.blurb"
              @click="openAddCluster('cloud', { provider: cloud.id })"
            >
              <span class="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-surface-1 ring-1 ring-inset ring-border/60">
                <ProviderMark :provider="cloud.id" :size="20" />
              </span>
              <span class="min-w-0 flex-1">
                <span class="block truncate text-sm font-medium">{{ cloud.short }}</span>
                <span class="block truncate text-xs text-muted-foreground">
                  <template v-if="connectedProviders.has(cloud.id)">
                    <CheckCircle2 class="mr-0.5 inline h-3 w-3 -translate-y-px text-success" /> Connected
                  </template>
                  <template v-else>{{ cloud.product }}</template>
                </span>
              </span>
            </button>
          </div>
          <p class="text-center text-xs text-muted-foreground">Optional. You can connect accounts any time from the Clusters hub.</p>
        </div>

        <!-- 5. Done -->
        <ul v-else class="grid gap-x-8 gap-y-5 sm:grid-cols-2">
          <li v-for="tip in TIPS" :key="tip.title" class="flex gap-3">
            <span class="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-muted text-muted-foreground">
              <component :is="tip.icon" class="h-4 w-4" />
            </span>
            <div class="min-w-0">
              <p class="flex items-center gap-2 text-sm font-medium">
                {{ tip.title }} <Kbd v-if="tip.keys" :keys="tip.keys" size="sm" />
              </p>
              <p class="mt-1 text-xs text-muted-foreground">{{ tip.text }}</p>
            </div>
          </li>
        </ul>
      </div>
    </main>

    <!-- Back and Continue stay put in the corners (Continue never moves under the pointer). -->
    <footer class="flex shrink-0 items-center justify-between px-6 py-4">
      <Button v-if="step > 0" variant="ghost" @click="back"><ArrowLeft class="h-4 w-4" /> Back</Button>
      <span v-else />
      <div class="flex items-center gap-2">
        <template v-if="current.id === 'done'">
          <Button variant="ghost" @click="finish(false)">Start using JET Pilot</Button>
          <Button size="lg" @click="finish(true)">Open the Clusters hub <ArrowRight class="h-4 w-4" /></Button>
        </template>
        <Button v-else size="lg" @click="next">Continue <ArrowRight class="h-4 w-4" /></Button>
      </div>
    </footer>
  </div>
</template>

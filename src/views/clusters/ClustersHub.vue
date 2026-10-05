<script setup lang="ts">
/*
 * Clusters hub: every context of every kubeconfig, grouped, with live
 * status (probes never trigger a sign-in), metadata (alias, colour,
 * environment, guardrails, folders, tags) and keyboard-first actions.
 *
 * Shown as the /clusters page and, `embedded`, in place of a view that
 * needs a context while none is active. `?edit=<context key>` opens the
 * details of a cluster.
 */
import { useRoute, useRouter } from "vue-router";
import { useEventListener, useLocalStorage } from "@vueuse/core";
import { type as getOsType } from "@tauri-apps/plugin-os";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import {
  ChevronRight,
  CircleAlert,
  EyeOff,
  FolderInput,
  Loader2,
  Plus,
  RefreshCw,
  Search,
  ServerOff,
  Star,
  X,
} from "lucide-vue-next";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { EmptyState } from "@/components/ui/empty-state";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/components/ui/toast";
import HubRow from "@/views/clusters/HubRow.vue";
import ClusterEditDialog from "@/views/clusters/ClusterEditDialog.vue";
import { injectStrict } from "@/lib/utils";
import { SettingsContextStateKey } from "@/providers/SettingsContextProvider";
import {
  KubeContextIsContextActiveKey,
  KubeContextSetActiveNamespacesKey,
  KubeContextStateKey,
  KubeContextSwitchContextKey,
} from "@/providers/KubeContextProvider";
import { useClusters } from "@/lib/clusters/useClusters";
import { isSameContext, parseContextKey } from "@/lib/contextKey";
import { inventory, inventoryErrors, loadInventory } from "@/lib/clusters/inventory";
import { discoverKubeconfigs, discoveredKubeconfigs } from "@/lib/kubeconfigSources";
import {
  GROUP_BY_OPTIONS,
  buildSections,
  folderNames,
  parseHubFilter,
  type GroupBy,
  type HubCluster,
} from "@/lib/clusters/hubModel";
import { cachedStatuses, cancelProbe, probeClusters, type ClusterStatus } from "@/lib/clusters/status";
import { errorMessage, openAddCluster, removeManaged } from "@/lib/clusters/managed";
import ExportDialog from "@/views/clusters/ExportDialog.vue";
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

const props = defineProps<{ embedded?: boolean }>();

const route = useRoute();
const router = useRouter();
const { toast } = useToast();
const { settings } = injectStrict(SettingsContextStateKey);
const { contexts: activeContexts } = injectStrict(KubeContextStateKey);
const switchContext = injectStrict(KubeContextSwitchContextKey);
const setActiveNamespaces = injectStrict(KubeContextSetActiveNamespacesKey);
const isContextActive = injectStrict(KubeContextIsContextActiveKey);
const clusters = useClusters();

const isMac = getOsType() === "macos";
const modKey = isMac ? "⌘" : "Ctrl+";

/* ------------------------------------------------------------ data -- */

const loading = ref(false);
const reload = async () => {
  loading.value = true;
  try {
    await loadInventory(settings.value);
  } finally {
    loading.value = false;
  }
};
onMounted(reload);
watch(
  () => [settings.value.kubeconfig.sources.join("\n"), settings.value.kubeconfig.autoDetect, discoveredKubeconfigs.value],
  reload
);

const statuses = reactive(new Map<string, ClusterStatus>());
const statusKey = (s: { context: string; kubeConfig: string }) => `${s.kubeConfig}\u0000${s.context}`;
const putStatus = (status: ClusterStatus) => statuses.set(statusKey(status), status);

const checking = ref(false);
let batch: number | null = null;
/*
 * Explicit checks also try clusters with an unknown sign-in method. Clusters
 * that sign in with a device code or browser stay skipped: nobody would see
 * the code (the sign-in flow comes with the auth center).
 */
const check = async (targets?: HubCluster[], explicit = false) => {
  const includeInteractive = explicit && !!targets?.every((c) => c.entry.auth.interactive !== "interactive");
  const list = targets ?? hubClusters.value.filter((c) => !c.meta.hidden);
  if (!list.length) return;
  if (!targets && batch !== null) void cancelProbe(batch).catch(() => undefined);
  checking.value = true;
  try {
    const id = await probeClusters(
      list.map((c) => ({ context: c.entry.context, kubeConfig: c.entry.kubeConfig })),
      putStatus,
      {
        includeInteractive,
        onDone: () => {
          if (!targets) checking.value = false;
        },
      }
    );
    if (!targets) batch = id;
    else checking.value = false;
  } catch (e) {
    checking.value = false;
    toast({ title: "Couldn't check the clusters", description: String(e), variant: "destructive" });
  }
};

/* Cached statuses right away, then a fresh check. */
watch(
  inventory,
  async (entries, previous) => {
    if (!entries) return;
    const refs = entries.map((e) => ({ context: e.context, kubeConfig: e.kubeConfig }));
    (await cachedStatuses(refs).catch(() => [])).forEach(putStatus);
    if (!previous || previous.length !== entries.length) void check();
  },
  { immediate: true }
);
onBeforeUnmount(() => {
  if (batch !== null) void cancelProbe(batch).catch(() => undefined);
});

const hubClusters = computed<HubCluster[]>(() =>
  (inventory.value ?? []).map((entry) => ({
    entry,
    meta: clusters.resolve(entry.context, entry.kubeConfig),
    status: statuses.get(statusKey(entry)),
    active: isContextActive(entry.context, entry.kubeConfig),
  }))
);

/* ------------------------------------------------------ list state -- */

const query = ref("");
const filter = computed(() => parseHubFilter(query.value));
const storedGroupBy = useLocalStorage<GroupBy | "auto">("jet.clusters.groupBy", "auto");
const groupBy = computed<GroupBy>(() =>
  storedGroupBy.value !== "auto"
    ? storedGroupBy.value
    : hubClusters.value.some((c) => c.meta.folder)
      ? "folder"
      : "provider"
);
const showHidden = ref(false);
const collapsed = reactive(new Set<string>());

const sections = computed(() => buildSections(hubClusters.value, groupBy.value, filter.value, showHidden.value));
const hiddenCount = computed(() => hubClusters.value.filter((c) => c.meta.hidden).length);
const fileCount = computed(() => new Set((inventory.value ?? []).map((e) => e.kubeConfig)).size);

/* Rows in display order (keyboard navigation). */
const visibleRows = computed<HubCluster[]>(() => [
  ...(collapsed.has("favorites") ? [] : sections.value.favorites),
  ...sections.value.groups.flatMap((group) => (collapsed.has(group.id) ? [] : group.clusters)),
  ...(collapsed.has("hidden") ? [] : sections.value.hidden),
]);

const selection = reactive(new Set<string>());
const selected = computed(() => hubClusters.value.filter((c) => selection.has(c.entry.key)));
const toggleSelect = (cluster: HubCluster, on: boolean) => {
  if (on) selection.add(cluster.entry.key);
  else selection.delete(cluster.entry.key);
};

const focusedKey = ref<string | null>(null);
const listElement = ref<HTMLElement | null>(null);
const focusRow = (key: string | undefined) => {
  if (!key) return;
  focusedKey.value = key;
  nextTick(() =>
    listElement.value
      ?.querySelector<HTMLElement>(`[data-cluster-key="${CSS.escape(encodeURIComponent(key))}"]`)
      ?.focus()
  );
};

/* --------------------------------------------------------- actions -- */

const connect = (cluster: HubCluster) => {
  switchContext(cluster.entry.context, cluster.entry.kubeConfig, "");
  // Embedded, the view that needed a context renders itself now.
  if (!props.embedded) router.push("/");
};
const addToActive = (cluster: HubCluster) => {
  setActiveNamespaces(cluster.entry.context, cluster.entry.kubeConfig, ["all"]);
  toast({ title: `${cluster.meta.displayName} added to the active clusters` });
};
const disconnect = (cluster: HubCluster) => setActiveNamespaces(cluster.entry.context, cluster.entry.kubeConfig, []);
const toggleFavorite = (cluster: HubCluster) =>
  clusters.update(cluster.entry.context, cluster.entry.kubeConfig, { favorite: !cluster.meta.favorite || undefined });
const toggleHidden = (cluster: HubCluster) => {
  clusters.update(cluster.entry.context, cluster.entry.kubeConfig, { hidden: !cluster.meta.hidden || undefined });
  if (!cluster.meta.hidden) toast({ title: `${cluster.meta.displayName} is hidden`, description: "Show hidden clusters to bring it back." });
};
const copyName = (cluster: HubCluster) =>
  writeText(cluster.entry.context).then(() => toast({ title: "Context name copied" }), () => undefined);

const editOpen = ref(false);
const editing = ref<HubCluster[]>([]);
const edit = (targets: HubCluster[]) => {
  editing.value = targets;
  editOpen.value = true;
};
const folders = computed(() => folderNames(hubClusters.value));

/* ?edit=<context key> (e.g. from a read-only notice). */
watch(
  () => [route.query.edit, inventory.value] as const,
  ([key]) => {
    if (typeof key !== "string" || !inventory.value) return;
    // Callers that only know the context name pass an empty kubeconfig.
    const wanted = parseContextKey(key);
    const target =
      hubClusters.value.find((c) => c.entry.key === key) ??
      hubClusters.value.find((c) => isSameContext(wanted, { context: c.entry.context, kubeConfig: c.entry.kubeConfig }));
    if (target) edit([target]);
    router.replace({ query: { ...route.query, edit: undefined } });
  },
  { immediate: true }
);

/* Clusters added in JET Pilot: export and remove. */
const exportOpen = ref(false);
const exportTargets = ref<string[]>([]);
const removing = ref<HubCluster | null>(null);
const removeCluster = async () => {
  const cluster = removing.value;
  removing.value = null;
  if (!cluster) return;
  try {
    if (cluster.active) setActiveNamespaces(cluster.entry.context, cluster.entry.kubeConfig, []);
    await removeManaged([cluster.entry.context], true);
    clusters.update(cluster.entry.context, cluster.entry.kubeConfig, {
      alias: undefined, color: undefined, env: undefined, folder: undefined, tags: undefined,
      favorite: undefined, hidden: undefined, protected: undefined, readOnly: undefined, namespaces: undefined,
    });
    await discoverKubeconfigs(true);
    toast({ title: `Removed ${cluster.meta.displayName}` });
  } catch (e) {
    toast({ title: "Couldn't remove the cluster", description: errorMessage(e), variant: "destructive" });
  }
};

const bulk = (patch: Parameters<typeof clusters.updateMany>[1]) => {
  clusters.updateMany(
    selected.value.map((c) => ({ context: c.entry.context, kubeConfig: c.entry.kubeConfig })),
    patch
  );
};

/* ------------------------------------------------------- keyboard -- */

const filterInput = ref<HTMLInputElement | null>(null);
const onListKeydown = (event: KeyboardEvent) => {
  const rows = visibleRows.value;
  const index = rows.findIndex((c) => c.entry.key === focusedKey.value);
  const current = rows[index];
  const mod = isMac ? event.metaKey : event.ctrlKey;
  switch (event.key) {
    case "ArrowDown":
    case "j":
      event.preventDefault();
      focusRow(rows[Math.min(rows.length - 1, index + 1)]?.entry.key);
      return;
    case "ArrowUp":
    case "k":
      event.preventDefault();
      if (index <= 0) filterInput.value?.focus();
      else focusRow(rows[index - 1]?.entry.key);
      return;
    case "Enter":
      if (!current) return;
      event.preventDefault();
      if (mod) addToActive(current);
      else connect(current);
      return;
    case " ":
      if (!current) return;
      event.preventDefault();
      toggleSelect(current, !selection.has(current.entry.key));
      return;
  }
  if (!current || mod || event.altKey) return;
  const key = event.key.toLowerCase();
  if (key === "f") toggleFavorite(current);
  else if (key === "e") edit([current]);
  else if (key === "h") toggleHidden(current);
  else return;
  event.preventDefault();
};
const onFilterKeydown = (event: KeyboardEvent) => {
  if (event.key === "ArrowDown") {
    event.preventDefault();
    focusRow(visibleRows.value[0]?.entry.key);
  } else if (event.key === "Enter" && visibleRows.value.length) {
    event.preventDefault();
    connect(visibleRows.value[0]!);
  } else if (event.key === "Escape" && query.value) {
    event.stopPropagation();
    query.value = "";
  }
};
useEventListener(window, "keydown", (event: KeyboardEvent) => {
  if (event.key !== "/" || event.metaKey || event.ctrlKey) return;
  const target = event.target as HTMLElement | null;
  if (target?.closest("input, textarea, [contenteditable=true], .monaco-editor, .xterm, [role=dialog]")) return;
  event.preventDefault();
  filterInput.value?.focus();
});
onMounted(() => {
  if (!props.embedded) nextTick(() => filterInput.value?.focus());
});

const sectionList = computed(() => [
  ...(sections.value.favorites.length
    ? [{ id: "favorites", title: "Favourites", detail: undefined as string | undefined, clusters: sections.value.favorites }]
    : []),
  ...sections.value.groups,
  ...(sections.value.hidden.length
    ? [{ id: "hidden", title: "Hidden", detail: undefined as string | undefined, clusters: sections.value.hidden }]
    : []),
]);
</script>

<template>
  <div class="h-full overflow-auto" :class="embedded ? 'bg-background' : ''">
    <div class="mx-auto max-w-6xl space-y-5 px-8 py-7">
      <header class="flex flex-wrap items-end justify-between gap-4">
        <div class="space-y-1">
          <h1 class="text-xl font-semibold tracking-tight">
            {{ embedded ? "Pick a cluster to get started" : "Clusters" }}
          </h1>
          <p class="text-sm text-muted-foreground">
            <template v-if="inventory">
              {{ hubClusters.length }} {{ hubClusters.length === 1 ? "cluster" : "clusters" }} from
              {{ fileCount }} kubeconfig {{ fileCount === 1 ? "file" : "files" }}
              <template v-if="activeContexts.size"> · {{ activeContexts.size }} connected</template>
            </template>
            <template v-else>Reading your kubeconfig files…</template>
          </p>
        </div>
        <div class="flex items-center gap-2">
          <Button variant="ghost" size="sm" :disabled="checking || !inventory" @click="check()">
            <RefreshCw class="h-3.5 w-3.5" :class="checking ? 'animate-spin' : ''" />
            {{ checking ? "Checking…" : "Check status" }}
          </Button>
          <Button size="sm" @click="openAddCluster()">
            <Plus class="h-3.5 w-3.5" />
            Add cluster
          </Button>
        </div>
      </header>

      <div class="flex flex-wrap items-center gap-3">
        <div class="relative min-w-[16rem] flex-1">
          <Search class="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            ref="filterInput"
            v-model="query"
            type="text"
            spellcheck="false"
            placeholder="Filter clusters…  env:prod  provider:aws  tag:payments  is:favorite"
            aria-label="Filter clusters"
            class="h-8 w-full rounded-md border bg-background pl-8 pr-8 text-sm placeholder:text-muted-foreground focus-ring"
            @keydown="onFilterKeydown"
          />
          <button
            v-if="query"
            type="button"
            class="absolute right-1.5 top-1/2 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
            aria-label="Clear filter"
            @click="query = ''"
          >
            <X class="h-3 w-3" />
          </button>
        </div>
        <Select :model-value="storedGroupBy === 'auto' ? groupBy : storedGroupBy" @update:model-value="(v) => (storedGroupBy = v as GroupBy)">
          <SelectTrigger class="h-8 w-48" aria-label="Group by">
            <span class="text-muted-foreground">Group:</span>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem v-for="option in GROUP_BY_OPTIONS" :key="option.value" :value="option.value">
              {{ option.label }}
            </SelectItem>
          </SelectContent>
        </Select>
        <label v-if="hiddenCount" class="flex items-center gap-2 text-sm text-muted-foreground">
          <Switch v-model:checked="showHidden" />
          Show hidden ({{ hiddenCount }})
        </label>
      </div>

      <div
        v-for="error in inventoryErrors"
        :key="error.path"
        class="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive"
        role="alert"
      >
        <CircleAlert class="mt-px h-3.5 w-3.5 shrink-0" />
        <span><span class="font-mono">{{ error.path }}</span>: {{ error.message }}</span>
      </div>

      <div v-if="!inventory" class="flex items-center justify-center gap-2 py-24 text-sm text-muted-foreground">
        <Loader2 class="h-4 w-4 animate-spin" /> Reading your kubeconfig files…
      </div>

      <EmptyState
        v-else-if="hubClusters.length === 0"
        :icon="ServerOff"
        title="No clusters yet"
        description="JET Pilot didn't find any contexts in ~/.kube/config, $KUBECONFIG or ~/.kube/*.yaml. Add a cluster to get going: paste a kubeconfig, import a file or enter one by hand."
      >
        <template #action>
          <div class="flex gap-2">
            <Button size="sm" @click="openAddCluster()"><Plus class="h-3.5 w-3.5" /> Add cluster</Button>
            <Button size="sm" variant="outline" @click="router.push({ name: 'SettingsCategory', params: { category: 'clusters' } })">
              Kubeconfig settings
            </Button>
          </div>
        </template>
      </EmptyState>

      <EmptyState
        v-else-if="sections.total === 0"
        :icon="Search"
        size="sm"
        title="No matching clusters"
        :description="hiddenCount && !showHidden ? 'Some clusters are hidden; turn on Show hidden to include them.' : 'Try another word or token.'"
      />

      <div
        v-else
        ref="listElement"
        role="grid"
        aria-label="Clusters"
        class="overflow-hidden rounded-lg border bg-card shadow-xs"
        @keydown="onListKeydown"
      >
        <template v-for="section in sectionList" :key="section.id">
          <button
            type="button"
            class="flex h-9 w-full items-center gap-2 border-b border-border-subtle bg-surface-1/60 px-3 text-left text-xs font-medium text-muted-foreground hover:text-foreground"
            :aria-expanded="!collapsed.has(section.id)"
            @click="collapsed.has(section.id) ? collapsed.delete(section.id) : collapsed.add(section.id)"
          >
            <ChevronRight class="h-3.5 w-3.5 transition-transform duration-fast" :class="collapsed.has(section.id) ? '' : 'rotate-90'" />
            <Star v-if="section.id === 'favorites'" class="h-3.5 w-3.5 fill-current text-warning" />
            <EyeOff v-else-if="section.id === 'hidden'" class="h-3.5 w-3.5" />
            <FolderInput v-else-if="groupBy === 'folder' && section.id.startsWith('folder:')" class="h-3.5 w-3.5" />
            <span class="text-foreground">{{ section.title }}</span>
            <span v-if="section.detail" class="truncate font-mono text-2xs">{{ section.detail }}</span>
            <span class="ml-auto tabular-nums">{{ section.clusters.length }}</span>
          </button>
          <div v-if="!collapsed.has(section.id)" class="divide-y divide-border-subtle border-b border-border-subtle last:border-b-0">
            <HubRow
              v-for="cluster in section.clusters"
              :key="cluster.entry.key"
              :cluster="cluster"
              :selected="selection.has(cluster.entry.key)"
              :selecting="selection.size > 0"
              :focused="focusedKey ? focusedKey === cluster.entry.key : cluster === visibleRows[0]"
              :mod-key="modKey"
              @focus="focusedKey = cluster.entry.key"
              @connect="connect(cluster)"
              @add-to-active="addToActive(cluster)"
              @disconnect="disconnect(cluster)"
              @edit="edit([cluster])"
              @favorite="toggleFavorite(cluster)"
              @hide="toggleHidden(cluster)"
              @check="check([cluster], true)"
              @copy="copyName(cluster)"
              @export="exportTargets = [cluster.entry.context]; exportOpen = true"
              @remove="removing = cluster"
              @select="(on) => toggleSelect(cluster, on)"
            />
          </div>
        </template>
      </div>

      <p v-if="inventory && hubClusters.length" class="text-xs text-muted-foreground">
        <kbd class="font-sans">↑</kbd>/<kbd class="font-sans">↓</kbd> move · Enter connects · {{ modKey }}Enter adds to the active clusters ·
        Space selects · E edits · F favourites · H hides · / filters. Clusters that need you to sign in aren't checked automatically.
      </p>
    </div>

    <Transition
      enter-from-class="translate-y-4 opacity-0"
      leave-to-class="translate-y-4 opacity-0"
      enter-active-class="transition duration-base"
      leave-active-class="transition duration-fast"
    >
      <div
        v-if="selection.size"
        class="sticky bottom-4 mx-auto flex w-fit items-center gap-1 rounded-lg border bg-popover p-1.5 shadow-lg"
        role="toolbar"
        aria-label="Selected clusters"
      >
        <span class="px-2 text-sm tabular-nums">{{ selection.size }} selected</span>
        <Button size="sm" variant="ghost" @click="edit(selected)">Edit…</Button>
        <Button size="sm" variant="ghost" @click="bulk({ favorite: true })">Favourite</Button>
        <Button size="sm" variant="ghost" @click="bulk({ hidden: true })">Hide</Button>
        <Button size="sm" variant="ghost" @click="check(selected, true)">Check status</Button>
        <Button size="sm" variant="ghost" class="text-muted-foreground" @click="selection.clear()">
          <X class="h-3.5 w-3.5" /> Clear
        </Button>
      </div>
    </Transition>

    <ClusterEditDialog v-model:open="editOpen" :clusters="editing" :folders="folders" />
    <ExportDialog v-if="exportOpen" v-model:open="exportOpen" :contexts="exportTargets" />
    <AlertDialog :open="!!removing" @update:open="(value) => !value && (removing = null)">
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Remove {{ removing?.meta.displayName }} from JET Pilot?</AlertDialogTitle>
          <AlertDialogDescription>
            The cluster and its stored credentials are deleted from JET Pilot's kubeconfig and your keychain. The cluster
            itself isn't touched; you can add it again later.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction class="bg-destructive text-destructive-foreground hover:bg-destructive/90" @click="removeCluster">
            Remove
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </div>
</template>

<script setup lang="ts">
/*
 * Clusters hub: every context of every kubeconfig, grouped, with live
 * status (probes never trigger a sign-in), metadata (alias, colour,
 * environment, guardrails, folders, tags) and keyboard-first actions.
 *
 * Calm by design: a row says what a cluster is called, where it runs and
 * only what needs you; clicking it opens its details next to the list.
 * Clusters in your cloud accounts that aren't added yet are offered in one
 * prompt ("Review"); the Cloud accounts tab manages the accounts.
 *
 * Shown as the /clusters page and, `embedded`, in place of a view that
 * needs a context while none is active. `?edit=<context key>` opens the
 * details editor of a cluster, `?tab=accounts` the accounts.
 */
import { useRoute, useRouter } from "vue-router";
import { useEventListener, useLocalStorage } from "@vueuse/core";
import { type as getOsType } from "@tauri-apps/plugin-os";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import {
  ChevronRight,
  CircleAlert,
  Cloud,
  Loader2,
  Plus,
  Search,
  ServerOff,
  SlidersHorizontal,
  X,
} from "lucide-vue-next";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useToast } from "@/components/ui/toast";
import PageHeader from "@/components/page/PageHeader.vue";
import PageTabs from "@/components/page/PageTabs.vue";
import ProviderMark from "@/components/clusters/ProviderMark.vue";
import HubRow from "@/views/clusters/HubRow.vue";
import ClusterDetailPanel from "@/views/clusters/ClusterDetailPanel.vue";
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
import { contextKey, isSameContext, parseContextKey } from "@/lib/contextKey";
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
import type { ProviderId } from "@/lib/clusters/provider";
import { cachedStatuses, cancelProbe, probeClusters, type ClusterStatus } from "@/lib/clusters/status";
import { errorMessage, openAddCluster, removeManaged, withVault } from "@/lib/clusters/managed";
import { catalogAdd, catalogSetState, type CatalogCluster } from "@/lib/clusters/cloud";
import { availableInHub } from "@/lib/clusters/cloudModel";
import {
  catalog,
  catalogRefreshedAt,
  connections,
  discovery,
  loadCloud,
  refreshCloud,
  watchCloud,
} from "@/lib/clusters/catalogStore";
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

const AccountsPanel = defineAsyncComponent(() => import("@/views/clusters/AccountsPanel.vue"));
const AvailableDialog = defineAsyncComponent(() => import("@/views/clusters/AvailableDialog.vue"));
const ExportDialog = defineAsyncComponent(() => import("@/views/clusters/ExportDialog.vue"));

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

/* The cluster whose details are open (click a row). */
const detailKey = ref<string | null>(null);
const detail = computed(() => hubClusters.value.find((c) => c.entry.key === detailKey.value) ?? null);
const onRowClick = (cluster: HubCluster, event: MouseEvent) => {
  focusedKey.value = cluster.entry.key;
  if (event.metaKey || event.ctrlKey || event.shiftKey || selection.size) {
    toggleSelect(cluster, !selection.has(cluster.entry.key));
    return;
  }
  detailKey.value = detailKey.value === cluster.entry.key ? null : cluster.entry.key;
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

/* ------------------------------------------------- cloud accounts -- */

const tab = ref<"clusters" | "accounts">(route.query.tab === "accounts" && !props.embedded ? "accounts" : "clusters");
watch(tab, (value) => {
  if (!props.embedded) router.replace({ query: { ...route.query, tab: value === "accounts" ? value : undefined } });
});
watch(
  () => route.query.tab,
  (value) => {
    if (!props.embedded) tab.value = value === "accounts" ? "accounts" : "clusters";
  }
);

/* The catalog is refreshed when the hub opens, at most every 30 minutes (never signs in). */
const CATALOG_STALE_MS = 30 * 60_000;
onMounted(async () => {
  watchCloud();
  await loadCloud();
  const signedIn = (connections.value ?? []).some((c) => c.status === "signedIn");
  const stale = !catalogRefreshedAt.value || Date.now() - catalogRefreshedAt.value > CATALOG_STALE_MS;
  if (signedIn && stale && !discovery.value) void refreshCloud().catch(() => undefined);
});

/* Added clusters by context key: their account, role, and whether they're gone. */
const cloudByContext = computed(() => {
  const map = new Map<string, CatalogCluster>();
  for (const cluster of catalog.value ?? []) {
    if (cluster.addedContext) map.set(contextKey(cluster.addedContext.context, cluster.addedContext.kubeConfig), cluster);
  }
  return map;
});

/* Clusters in the accounts that aren't added yet: one prompt, reviewed in a dialog. */
const available = computed(() => availableInHub(catalog.value ?? [], parseHubFilter(""), true));
const reviewOpen = ref(false);
const adding = ref(false);

/* New clusters join the folder their account's clusters are in. */
const accountFolder = (connectionId: string) => {
  for (const cluster of catalog.value ?? []) {
    if (cluster.connectionId !== connectionId || !cluster.addedContext) continue;
    const folder = clusters.resolve(cluster.addedContext.context, cluster.addedContext.kubeConfig).folder;
    if (folder) return folder;
  }
  return null;
};

const addAvailable = async (targets: CatalogCluster[]) => {
  if (!targets.length) return;
  adding.value = true;
  const accounts = new Set(targets.map((c) => c.connectionId));
  const folder = accounts.size === 1 ? accountFolder(targets[0]!.connectionId) : null;
  try {
    const result = await withVault(() => catalogAdd(targets.map((c) => c.key), folder));
    if (folder) clusters.updateMany(result.added, { folder });
    if (result.added.length) {
      toast({ title: result.added.length === 1 ? `Added ${result.added[0]!.context}` : `Added ${result.added.length} clusters` });
    }
    if (result.failed.length) {
      toast({
        title: `Couldn't add ${result.failed.length} ${result.failed.length === 1 ? "cluster" : "clusters"}`,
        description: result.failed.map((f) => f.message).join("\n"),
        variant: "destructive",
      });
    }
    await Promise.all([discoverKubeconfigs(true), loadCloud()]);
    if (!available.value.available.length) reviewOpen.value = false;
  } catch (e) {
    toast({ title: "Couldn't add the clusters", description: errorMessage(e), variant: "destructive" });
  } finally {
    adding.value = false;
  }
};

const setAvailableState = async (targets: CatalogCluster[], state: "available" | "ignored") => {
  try {
    await catalogSetState(targets.map((c) => c.key), state);
    await loadCloud();
  } catch (e) {
    toast({ title: "Couldn't update the list", description: errorMessage(e), variant: "destructive" });
  }
};

const refreshAvailable = () =>
  refreshCloud().catch((e) => toast({ title: "Couldn't look for clusters", description: errorMessage(e), variant: "destructive" }));
const discoveryText = computed(() => {
  const state = discovery.value;
  if (!state) return null;
  const running = state.scopes.filter((s) => s.state === "running" && s.scope !== "regions");
  const latest = running[running.length - 1];
  return latest ? `Checking ${latest.scope}…` : "Looking for clusters…";
});
const newNames = computed(() => {
  const names = available.value.available.map((c) => c.name);
  return names.length <= 3 ? names.join(", ") : `${names.slice(0, 3).join(", ")} and ${names.length - 3} more`;
});
const availableProviders = computed(() => [...new Set(available.value.available.map((c) => c.provider))]);

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
      if (detailKey.value) detailKey.value = focusedKey.value;
      return;
    case "ArrowUp":
    case "k":
      event.preventDefault();
      if (index <= 0) filterInput.value?.focus();
      else focusRow(rows[index - 1]?.entry.key);
      if (detailKey.value) detailKey.value = focusedKey.value;
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
    case "ArrowRight":
    case "i":
      if (!current) return;
      event.preventDefault();
      detailKey.value = current.entry.key;
      return;
    case "Escape":
      if (detailKey.value) {
        event.stopPropagation();
        detailKey.value = null;
      } else if (selection.size) {
        event.stopPropagation();
        selection.clear();
      }
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

/* Sections in display order; the heading of a provider group shows its mark. */
const sectionList = computed(() => [
  ...(sections.value.favorites.length
    ? [{ id: "favorites", title: "Favourites", detail: undefined as string | undefined, clusters: sections.value.favorites }]
    : []),
  ...sections.value.groups,
  ...(sections.value.hidden.length
    ? [{ id: "hidden", title: "Hidden", detail: undefined as string | undefined, clusters: sections.value.hidden }]
    : []),
]);
const providerOf = (sectionId: string) =>
  groupBy.value === "provider" && sectionId.startsWith("provider:") ? (sectionId.split(":")[1] as ProviderId) : null;
const singleSection = computed(() => sectionList.value.length === 1 && groupBy.value === "none");

const subtitle = computed(() => {
  if (!inventory.value) return "Reading your kubeconfig files…";
  const parts = [`${hubClusters.value.length} ${hubClusters.value.length === 1 ? "cluster" : "clusters"}`];
  if (activeContexts.value.size) parts.push(`${activeContexts.value.size} connected`);
  if (discoveryText.value) parts.push("looking for new clusters…");
  return parts.join(" · ");
});
</script>
<template>
  <div class="h-full overflow-auto bg-background">
    <div class="mx-auto space-y-6 px-10 pb-16 pt-10" :class="detail ? 'max-w-6xl' : 'max-w-5xl'">
      <PageHeader :title="embedded ? 'Pick a cluster to get started' : 'Clusters'" :description="subtitle">
        <template #actions>
          <Button v-if="tab === 'clusters'" @click="openAddCluster()">
            <Plus class="h-4 w-4" /> Add cluster
          </Button>
          <Button v-else @click="openAddCluster('aws')">
            <Plus class="h-4 w-4" /> Connect an account
          </Button>
        </template>
        <template v-if="!embedded" #tabs>
          <PageTabs
            v-model="tab"
            label="Clusters hub"
            :tabs="[
              { id: 'clusters', label: 'Clusters' },
              { id: 'accounts', label: 'Cloud accounts', count: connections?.length || null },
            ]"
          />
        </template>
      </PageHeader>

      <AccountsPanel v-if="tab === 'accounts'" />

      <template v-else>
        <div class="flex items-center gap-2">
          <div class="relative flex-1">
            <Search class="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <input
              ref="filterInput"
              v-model="query"
              type="text"
              spellcheck="false"
              placeholder="Search clusters"
              aria-label="Search clusters"
              title="Also: env:prod  provider:aws  tag:payments  folder:team  is:favorite  is:unreachable"
              class="h-9 w-full rounded-lg border border-transparent bg-muted/60 pl-9 pr-9 text-sm transition-colors duration-fast placeholder:text-muted-foreground hover:bg-muted focus:border-input focus:bg-background focus:outline-none focus:ring-[3px] focus:ring-ring/15"
              @keydown="onFilterKeydown"
            />
            <button
              v-if="query"
              type="button"
              class="absolute right-2 top-1/2 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
              aria-label="Clear search"
              @click="query = ''"
            >
              <X class="h-3 w-3" />
            </button>
          </div>
          <DropdownMenu>
            <DropdownMenuTrigger as-child>
              <Button variant="ghost" class="h-9 text-muted-foreground" aria-label="View options">
                <SlidersHorizontal class="h-4 w-4" /> View
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" class="w-56">
              <DropdownMenuLabel>Group by</DropdownMenuLabel>
              <DropdownMenuRadioGroup :model-value="groupBy" @update:model-value="(v) => (storedGroupBy = v as GroupBy)">
                <DropdownMenuRadioItem v-for="option in GROUP_BY_OPTIONS" :key="option.value" :value="option.value">
                  {{ option.label }}
                </DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>
              <DropdownMenuSeparator />
              <DropdownMenuCheckboxItem v-model:checked="showHidden">
                Show hidden<span v-if="hiddenCount" class="ml-auto pl-3 text-xs tabular-nums text-muted-foreground">{{ hiddenCount }}</span>
              </DropdownMenuCheckboxItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem :disabled="checking || !inventory" @select="check()">
                {{ checking ? "Checking status…" : "Check status now" }}
              </DropdownMenuItem>
              <DropdownMenuItem @select="router.push({ name: 'SettingsCategory', params: { category: 'clusters' } })">
                Kubeconfig files…
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        <!-- New clusters in the cloud accounts -->
        <button
          v-if="available.available.length"
          type="button"
          class="flex w-full items-center gap-3.5 rounded-xl border bg-card px-4 py-3 text-left shadow-xs transition-colors duration-fast hover:border-border-strong focus-ring"
          @click="reviewOpen = true"
        >
          <span class="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-surface-1">
            <ProviderMark v-if="availableProviders.length === 1" :provider="availableProviders[0]!" :size="20" />
            <Cloud v-else class="h-4 w-4 text-muted-foreground" />
          </span>
          <span class="min-w-0 flex-1">
            <span class="block text-sm font-medium">
              {{ available.available.length }} new {{ available.available.length === 1 ? "cluster" : "clusters" }} in your cloud accounts
            </span>
            <span class="block truncate text-xs text-muted-foreground">{{ newNames }}</span>
          </span>
          <span class="flex items-center gap-1 text-sm font-medium text-link">Review <ChevronRight class="h-4 w-4" /></span>
        </button>

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
          description="JET Pilot didn't find any contexts in ~/.kube/config, $KUBECONFIG or ~/.kube/*.yaml. Connect a cloud account, paste a kubeconfig, import a file or enter a cluster by hand."
        >
          <template #action>
            <Button @click="openAddCluster()"><Plus class="h-4 w-4" /> Add cluster</Button>
          </template>
        </EmptyState>

        <EmptyState
          v-else-if="sections.total === 0"
          :icon="Search"
          size="sm"
          title="No matching clusters"
          :description="hiddenCount && !showHidden ? 'Some clusters are hidden; View › Show hidden includes them.' : 'Try another word.'"
        />

        <div v-else class="flex items-start gap-6">
          <div ref="listElement" role="grid" aria-label="Clusters" class="min-w-0 flex-1 space-y-6" @keydown="onListKeydown">
            <section v-for="section in sectionList" :key="section.id" :aria-label="section.title">
              <button
                v-if="!singleSection"
                type="button"
                class="group/heading mb-1 flex h-7 w-full items-center gap-2 px-3 text-left text-xs font-medium text-muted-foreground hover:text-foreground"
                :aria-expanded="!collapsed.has(section.id)"
                @click="collapsed.has(section.id) ? collapsed.delete(section.id) : collapsed.add(section.id)"
              >
                <ProviderMark v-if="providerOf(section.id)" :provider="providerOf(section.id)!" :size="14" />
                <span class="text-foreground/80">{{ section.title }}</span>
                <span v-if="section.detail" class="truncate font-normal">{{ section.detail }}</span>
                <span class="font-normal tabular-nums">{{ section.clusters.length }}</span>
                <ChevronRight
                  class="h-3.5 w-3.5 opacity-0 transition-[transform,opacity] duration-fast group-hover/heading:opacity-100"
                  :class="collapsed.has(section.id) ? 'opacity-100' : 'rotate-90'"
                />
              </button>
              <div v-if="!collapsed.has(section.id)" class="space-y-px">
                <HubRow
                  v-for="cluster in section.clusters"
                  :key="cluster.entry.key"
                  :cluster="cluster"
                  :selected="selection.has(cluster.entry.key)"
                  :selecting="selection.size > 0"
                  :focused="focusedKey ? focusedKey === cluster.entry.key : cluster === visibleRows[0]"
                  :open="detailKey === cluster.entry.key"
                  :mod-key="modKey"
                  :cloud="cloudByContext.get(cluster.entry.key)"
                  @open="(event) => onRowClick(cluster, event)"
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
            </section>
          </div>

          <Transition
            enter-from-class="translate-x-2 opacity-0"
            leave-to-class="translate-x-2 opacity-0"
            enter-active-class="transition duration-base ease-out"
            leave-active-class="transition duration-fast ease-in"
          >
            <ClusterDetailPanel
              v-if="detail"
              :key="detail.entry.key"
              class="sticky top-0 w-[22rem] shrink-0"
              :cluster="detail"
              :cloud="cloudByContext.get(detail.entry.key)"
              @close="detailKey = null"
              @connect="connect(detail)"
              @add-to-active="addToActive(detail)"
              @disconnect="disconnect(detail)"
              @edit="edit([detail])"
              @favorite="toggleFavorite(detail)"
              @hide="toggleHidden(detail)"
              @check="check([detail], true)"
              @export="exportTargets = [detail.entry.context]; exportOpen = true"
              @remove="removing = detail"
            />
          </Transition>
        </div>

        <p v-if="inventory && hubClusters.length && !embedded" class="px-3 text-xs text-muted-foreground/80">
          Click a cluster for its details · double-click or ↵ to connect · {{ modKey }}click to select several
        </p>
      </template>
    </div>

    <Transition
      enter-from-class="translate-y-4 opacity-0"
      leave-to-class="translate-y-4 opacity-0"
      enter-active-class="transition duration-base"
      leave-active-class="transition duration-fast"
    >
      <div
        v-if="selection.size"
        class="sticky bottom-6 mx-auto flex w-fit items-center gap-1 rounded-xl border bg-popover p-1.5 shadow-lg"
        role="toolbar"
        aria-label="Selected clusters"
      >
        <span class="px-2.5 text-sm tabular-nums">{{ selection.size }} selected</span>
        <Button size="sm" variant="ghost" @click="edit(selected)">Edit…</Button>
        <Button size="sm" variant="ghost" @click="bulk({ favorite: true })">Favourite</Button>
        <Button size="sm" variant="ghost" @click="bulk({ hidden: true })">Hide</Button>
        <Button size="sm" variant="ghost" @click="check(selected, true)">Check status</Button>
        <Button size="sm" variant="ghost" class="text-muted-foreground" aria-label="Clear selection" @click="selection.clear()">
          <X class="h-3.5 w-3.5" />
        </Button>
      </div>
    </Transition>

    <ClusterEditDialog v-model:open="editOpen" :clusters="editing" :folders="folders" />
    <ExportDialog v-if="exportOpen" v-model:open="exportOpen" :contexts="exportTargets" />
    <AvailableDialog
      v-if="reviewOpen"
      v-model:open="reviewOpen"
      :available="available.available"
      :ignored="available.ignored"
      :discovering="discoveryText"
      :busy="adding"
      @add="addAvailable"
      @ignore="(list) => setAvailableState(list, 'ignored')"
      @restore="(list) => setAvailableState(list, 'available')"
      @refresh="refreshAvailable"
    />
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

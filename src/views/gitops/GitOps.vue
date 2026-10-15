<script setup lang="ts">
/*
 * GitOps: every Flux Kustomization and HelmRelease and every Argo CD
 * Application of the active clusters, live. Problems first (failing, out of
 * sync, waiting), then what's in progress, what's healthy and what's
 * suspended. A row says what a delivery is called, where it comes from (or
 * what's wrong) and its state in words; clicking it opens its details in the
 * side panel. Reconcile, sync and refresh are a hover or a key away.
 */
import { useEventListener, useIntervalFn } from "@vueuse/core";
import { ChevronRight, CircleAlert, CircleCheck, GitMerge, Info, Search, X } from "lucide-vue-next";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import PageHeader from "@/components/page/PageHeader.vue";
import PageTabs from "@/components/page/PageTabs.vue";
import DeliveryRow from "@/views/gitops/DeliveryRow.vue";
import { injectStrict } from "@/lib/utils";
import {
  PanelProviderAddTabKey,
  PanelProviderSetSidePanelComponentKey,
  PanelProviderStateKey,
} from "@/providers/PanelProvider";
import { DialogProviderSpawnDialogKey } from "@/providers/DialogProvider";
import { KubeContextStateKey } from "@/providers/KubeContextProvider";
import { useGitOps } from "@/lib/gitops/useGitOps";
import { reconcile, refresh, setSuspended } from "@/lib/gitops/actions";
import { openDeliveryPanel, openSyncDialog } from "@/lib/gitops/ui";
import {
  DELIVERY_KINDS,
  buildSections,
  matchesFilter,
  matchesQuery,
  summarize,
  type Delivery,
  type DeliveryFilter,
  type SectionId,
} from "@/lib/gitops/model";

const setSidePanelComponent = injectStrict(PanelProviderSetSidePanelComponentKey);
const { sidePanel } = injectStrict(PanelProviderStateKey);
const addTab = injectStrict(PanelProviderAddTabKey);
const spawnDialog = injectStrict(DialogProviderSpawnDialogKey);

const { context: primaryContext } = injectStrict(KubeContextStateKey);
const gitops = useGitOps();
const { deliveries, errors, loading, limited } = gitops;

/* "argocd", "argocd and flux-system", "a, b and c". */
const namespaceList = (names: string[]) =>
  new Intl.ListFormat("en", { style: "long", type: "conjunction" }).format(names);

/* Relative times stay current. */
const now = ref(Date.now());
useIntervalFn(() => (now.value = Date.now()), 30_000);

const multiContext = computed(() => gitops.detections.value.length > 1);
const bothTools = computed(() => gitops.flux.value && gitops.argo.value);

/* ------------------------------------------------------ list state -- */

const query = ref("");
const filter = ref<DeliveryFilter>("all");
const visible = computed(() =>
  deliveries.value.filter((d) => matchesFilter(d, filter.value) && matchesQuery(d, query.value))
);
const sections = computed(() => buildSections(visible.value));
const collapsed = reactive(new Set<SectionId>());
const singleSection = computed(() => sections.value.length === 1);

const count = (f: DeliveryFilter) => deliveries.value.filter((d) => matchesFilter(d, f)).length;
const tabs = computed(() => [
  { id: "all" as const, label: "All", count: deliveries.value.length || null },
  { id: "attention" as const, label: "Needs attention", count: count("attention") || null },
  ...(bothTools.value
    ? [
        { id: "flux" as const, label: "Flux", count: count("flux") || null },
        { id: "argo" as const, label: "Argo CD", count: count("argo") || null },
      ]
    : []),
]);
/* A tool filter without the tool (its cluster was deactivated): back to all. */
watch(bothTools, (both) => {
  if (!both && (filter.value === "flux" || filter.value === "argo")) filter.value = "all";
});

const rows = computed<Delivery[]>(() =>
  sections.value.flatMap((section) => (collapsed.has(section.id) && !singleSection.value ? [] : section.deliveries))
);

const subtitle = computed(() => {
  if (!gitops.installed.value) return loading.value ? "Looking for Flux and Argo CD…" : "Flux and Argo CD deliveries";
  if (loading.value && !deliveries.value.length) return "Loading deliveries…";
  return summarize(deliveries.value);
});

/* ------------------------------------------------- panel + focus -- */

const openKey = ref<string | null>(null);
const focusedKey = ref<string | null>(null);
const listElement = ref<HTMLElement | null>(null);

const open = (delivery: Delivery) => {
  focusedKey.value = delivery.key;
  openKey.value = delivery.key;
  openDeliveryPanel(setSidePanelComponent, delivery.object);
};
/* Closing the side panel (or opening something else) ends the selection. */
watch(sidePanel, (panel) => {
  const resource = panel?.props?.resource;
  const key = resource?.metadata ? `${resource.metadata.context ?? ""}/${resource.metadata.uid}` : null;
  if (!panel || key !== openKey.value) openKey.value = key && deliveries.value.some((d) => d.key === key) ? key : null;
});

const focusRow = (key: string | undefined) => {
  if (!key) return;
  focusedKey.value = key;
  nextTick(() =>
    listElement.value?.querySelector<HTMLElement>(`[data-delivery-key="${CSS.escape(key)}"]`)?.focus()
  );
};

/* --------------------------------------------------------- actions -- */

const doReconcile = (d: Delivery, withSource: boolean) => void reconcile(d.object, { withSource });
const doSuspend = (d: Delivery, suspend: boolean) => void setSuspended(d.object, suspend);
const doSync = (d: Delivery) => openSyncDialog(spawnDialog, d.object);
const doRefresh = (d: Delivery, hard: boolean) => void refresh(d.object, hard);
const editYaml = (d: Delivery) => {
  const group = DELIVERY_KINDS[d.kind].group;
  addTab(
    ["edit", d.context, d.namespace, d.kind, d.name].join("_"),
    d.name,
    defineAsyncComponent(() => import("@/views/ObjectEditor.vue")),
    {
      context: d.context,
      namespace: d.namespace,
      kubeConfig: d.kubeConfig,
      type: `${d.kind.toLowerCase()}.${group}`,
      name: d.name,
      useKubeCtl: true,
    },
    "edit"
  );
};

/* -------------------------------------------------------- keyboard -- */

const keyHint = computed(() =>
  gitops.flux.value && gitops.argo.value
    ? "R to reconcile or refresh · S to sync"
    : gitops.argo.value
      ? "R to refresh · S to sync"
      : "R to reconcile"
);
const filterInput = ref<HTMLInputElement | null>(null);

const onListKeydown = (event: KeyboardEvent) => {
  const target = event.target as HTMLElement | null;
  if (target && target.closest("[data-delivery-key]") !== target) return;
  const list = rows.value;
  const index = list.findIndex((d) => d.key === focusedKey.value);
  const current = list[index];
  switch (event.key) {
    case "ArrowDown":
    case "j":
      event.preventDefault();
      focusRow(list[Math.min(list.length - 1, index + 1)]?.key);
      if (openKey.value && focusedKey.value) {
        const next = list.find((d) => d.key === focusedKey.value);
        if (next) open(next);
      }
      return;
    case "ArrowUp":
    case "k":
      event.preventDefault();
      if (index <= 0) filterInput.value?.focus();
      else {
        focusRow(list[index - 1]?.key);
        if (openKey.value) open(list[index - 1]!);
      }
      return;
    case "Enter":
    case "ArrowRight":
      if (!current) return;
      event.preventDefault();
      open(current);
      return;
    case "Escape":
      if (openKey.value) {
        event.stopPropagation();
        setSidePanelComponent(null);
      }
      return;
  }
  if (!current || event.metaKey || event.ctrlKey || event.altKey) return;
  const key = event.key.toLowerCase();
  if (key === "r") {
    if (current.tool === "flux") doReconcile(current, false);
    else doRefresh(current, false);
  } else if (key === "s" && current.tool === "argo") doSync(current);
  else return;
  event.preventDefault();
};

const onFilterKeydown = (event: KeyboardEvent) => {
  if (event.key === "ArrowDown") {
    event.preventDefault();
    focusRow(rows.value[0]?.key);
  } else if (event.key === "Enter" && rows.value.length) {
    event.preventDefault();
    open(rows.value[0]!);
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

/* ------------------------------------------------------ empty states -- */

const noResults = computed(() => deliveries.value.length > 0 && visible.value.length === 0);
const emptyFilter = computed(() => noResults.value && !query.value.trim() && filter.value === "attention");
</script>

<template>
  <div class="h-full overflow-auto bg-background">
    <div class="mx-auto max-w-5xl space-y-6 px-10 pb-16 pt-10">
      <PageHeader title="GitOps" :description="subtitle">
        <template v-if="gitops.installed.value && deliveries.length" #tabs>
          <PageTabs v-model="filter" label="Show deliveries" :tabs="tabs" />
        </template>
      </PageHeader>

      <!-- Discovery / first snapshot -->
      <div v-if="loading && !deliveries.length" class="space-y-px" aria-label="Loading deliveries">
        <div v-for="index in 6" :key="index" class="flex h-14 items-center gap-3 px-3">
          <Skeleton class="h-6 w-6 rounded-full" />
          <div class="flex-1 space-y-1.5">
            <Skeleton class="h-3.5 w-40" />
            <Skeleton class="h-3 w-64" />
          </div>
          <Skeleton class="h-3 w-24" />
        </div>
      </div>

      <EmptyState
        v-else-if="!gitops.installed.value"
        :icon="GitMerge"
        title="No GitOps in these clusters"
        description="Deliveries show up here when Flux or Argo CD runs in one of your active clusters."
      />

      <EmptyState
        v-else-if="!deliveries.length && !errors.length && !limited.length"
        :icon="GitMerge"
        title="Nothing delivered yet"
        description="Flux Kustomizations, HelmReleases and Argo CD applications show up here as soon as they exist."
      />

      <template v-else>
        <div
          v-for="scope in limited"
          :key="scope.context"
          class="flex items-start gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground"
        >
          <Info class="mt-px h-3.5 w-3.5 shrink-0" />
          <span v-if="scope.namespaces.length">
            In {{ scope.context }} you can read deliveries in {{ namespaceList(scope.namespaces) }} only, so those are
            listed. To include more, select their namespaces for this cluster.
          </span>
          <span v-else>
            You can't read deliveries in {{ scope.context }} across all namespaces, nor in the ones Argo CD and Flux
            usually use. Select the namespaces they use for this cluster to list them.
          </span>
        </div>

        <div
          v-for="error in errors"
          :key="error.kind"
          class="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive"
          role="alert"
        >
          <CircleAlert class="mt-px h-3.5 w-3.5 shrink-0" />
          <span>Couldn't list {{ error.kind }}s: {{ error.message }}</span>
        </div>

        <div v-if="deliveries.length" class="relative">
          <Search class="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input
            ref="filterInput"
            v-model="query"
            type="text"
            spellcheck="false"
            placeholder="Search deliveries"
            aria-label="Search deliveries"
            title="Matches names, namespaces, clusters, repositories, charts and states"
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

        <EmptyState
          v-if="emptyFilter"
          :icon="CircleCheck"
          size="sm"
          title="Nothing needs attention"
          description="Every delivery is healthy or on its way."
        />
        <EmptyState
          v-else-if="noResults"
          :icon="Search"
          size="sm"
          title="No matching deliveries"
          description="Try another word."
        />

        <div v-else ref="listElement" role="grid" aria-label="Deliveries" class="space-y-6" @keydown="onListKeydown">
          <section v-for="section in sections" :key="section.id" :aria-label="section.title">
            <button
              v-if="!singleSection"
              type="button"
              class="group/heading mb-1 flex h-7 w-full items-center gap-2 px-3 text-left text-xs font-medium text-muted-foreground hover:text-foreground"
              :aria-expanded="!collapsed.has(section.id)"
              @click="collapsed.has(section.id) ? collapsed.delete(section.id) : collapsed.add(section.id)"
            >
              <span class="text-foreground/80">{{ section.title }}</span>
              <span class="font-normal tabular-nums">{{ section.deliveries.length }}</span>
              <ChevronRight
                class="h-3.5 w-3.5 opacity-0 transition-[transform,opacity] duration-fast group-hover/heading:opacity-100"
                :class="collapsed.has(section.id) ? 'opacity-100' : 'rotate-90'"
              />
            </button>
            <div v-if="singleSection || !collapsed.has(section.id)" class="space-y-px">
              <DeliveryRow
                v-for="delivery in section.deliveries"
                :key="delivery.key"
                :delivery="delivery"
                :focused="focusedKey ? focusedKey === delivery.key : delivery === rows[0]"
                :open="openKey === delivery.key"
                :show-context="multiContext && delivery.context !== primaryContext"
                :now="now"
                @open="open(delivery)"
                @focus="focusedKey = delivery.key"
                @reconcile="(withSource) => doReconcile(delivery, withSource)"
                @suspend="(suspend) => doSuspend(delivery, suspend)"
                @sync="doSync(delivery)"
                @refresh="(hard) => doRefresh(delivery, hard)"
                @edit-yaml="editYaml(delivery)"
              />
            </div>
          </section>
        </div>

        <p v-if="visible.length" class="px-3 text-xs text-muted-foreground/80">Click a delivery for its details · {{ keyHint }} · / to search</p>
      </template>
    </div>
  </div>
</template>

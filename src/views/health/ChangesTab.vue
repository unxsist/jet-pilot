<script setup lang="ts">
/*
 * Changes: what changed on the active clusters, newest first and grouped
 * by day, one line per change: what, how in words, who and when. Rollouts,
 * config edits, scaling, releases and syncs, restarts, node conditions and
 * warnings. Live changes come from the recorder (while the app is open),
 * older ones from the cluster's own history; the footnote says which is
 * which, and each time's tooltip where it came from.
 *
 * Search filters by name, kind, namespace, cluster, words or author
 * (`?q=` presets it). A click opens the diff, or the object.
 */
import { useRoute } from "vue-router";
import { useEventListener, useIntervalFn } from "@vueuse/core";
import { History, Layers, RefreshCw, Search, X } from "lucide-vue-next";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import ChangeRow from "@/views/health/changes/ChangeRow.vue";
import { openChange, openObject } from "@/views/health/changes/openChange";
import { injectStrict } from "@/lib/utils";
import { SettingsContextStateKey } from "@/providers/SettingsContextProvider";
import {
  PanelProviderAddTabKey,
  PanelProviderSetSidePanelComponentKey,
  PanelProviderStateKey,
} from "@/providers/PanelProvider";
import { resolveCluster } from "@/lib/clusters/meta";
import { useChanges } from "@/lib/changes/useChanges";
import { dayTitle, groupByDay, matchesChange, timeOfDay, type Change } from "@/lib/changes/model";
import type { HealthTarget } from "@/lib/health/tabs";

const props = defineProps<{ targets: HealthTarget[] }>();

const route = useRoute();
const { settings } = injectStrict(SettingsContextStateKey);
const addTab = injectStrict(PanelProviderAddTabKey);
const setSidePanel = injectStrict(PanelProviderSetSidePanelComponentKey);
const { sidePanel } = injectStrict(PanelProviderStateKey);

const timeline = useChanges(() => props.targets);
const { changes, loading, reading } = timeline;

/* Day titles and times stay current. */
const now = ref(new Date());
useIntervalFn(() => (now.value = new Date()), 60_000);

const multiCluster = computed(() => new Set(props.targets.map((t) => t.context)).size > 1);
const clusterNames = computed(
  () =>
    new Map(
      props.targets.map((t) => [t.context, resolveCluster(settings.value.clusters, t.context, t.kubeConfig).displayName])
    )
);

/* ---------------------------------------------------------- search -- */

const query = ref("");
watch(
  () => route.query.q,
  (q) => {
    if (typeof q === "string") query.value = q;
  },
  { immediate: true }
);
const visible = computed(() =>
  changes.value.filter((c) => matchesChange(c, query.value, clusterNames.value.get(c.target.context)))
);

/* Long histories render a page at a time. */
const PAGE = 150;
const limit = ref(PAGE);
watch(query, () => (limit.value = PAGE));
const shown = computed(() => visible.value.slice(0, limit.value));
const days = computed(() => groupByDay(shown.value, now.value));

/* ------------------------------------------------------ open + keys -- */

const focusedKey = ref<string | null>(null);
const listElement = ref<HTMLElement | null>(null);
const searchInput = ref<HTMLInputElement | null>(null);

const open = (change: Change) => {
  focusedKey.value = change.key;
  openChange(addTab, setSidePanel, sidePanel.value, change);
};

const focusRow = (key: string | undefined) => {
  if (!key) return;
  focusedKey.value = key;
  nextTick(() => listElement.value?.querySelector<HTMLElement>(`[data-change-key="${CSS.escape(key)}"]`)?.focus());
};

const onListKeydown = (event: KeyboardEvent) => {
  const list = shown.value;
  const index = list.findIndex((c) => c.key === focusedKey.value);
  if (event.key === "ArrowDown" || event.key === "j") {
    event.preventDefault();
    focusRow(list[Math.min(list.length - 1, index + 1)]?.key);
  } else if (event.key === "ArrowUp" || event.key === "k") {
    event.preventDefault();
    if (index <= 0) searchInput.value?.focus();
    else focusRow(list[index - 1]?.key);
  }
};

const onSearchKeydown = (event: KeyboardEvent) => {
  if (event.key === "ArrowDown") {
    event.preventDefault();
    focusRow(shown.value[0]?.key);
  } else if (event.key === "Enter" && shown.value.length) {
    event.preventDefault();
    open(shown.value[0]);
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
  searchInput.value?.focus();
});

/* -------------------------------------------------------- footnote -- */

/* Honest about what is what: recorded while open, else read from the cluster. */
const footnote = computed(() => {
  const since = timeline.recordingSince.value;
  const history = "older ones come from the cluster's own history";
  if (!since) return `Changes are recorded live while JET Pilot is open, ${history}`;
  const date = new Date(since);
  const day = dayTitle(date, now.value);
  const when = day === "Today" ? timeOfDay(since) : `${day === "Yesterday" ? "yesterday" : day} ${timeOfDay(since)}`;
  return `Recorded live since ${when}, ${history}`;
});
</script>

<template>
  <EmptyState
    v-if="!targets.length"
    :icon="Layers"
    title="No active clusters"
    description="Pick a cluster in the sidebar to see what changed on it."
  />

  <div v-else-if="loading" class="space-y-px" aria-label="Loading changes">
    <Skeleton class="mb-6 h-9 w-full rounded-lg" />
    <div v-for="index in 8" :key="index" class="flex h-10 items-center gap-3 px-3">
      <Skeleton class="h-4 w-4 rounded" />
      <Skeleton class="h-3.5" :class="index % 3 ? 'w-28' : 'w-40'" />
      <Skeleton class="h-3.5" :class="index % 2 ? 'w-56' : 'w-72'" />
      <span class="flex-1" />
      <Skeleton class="h-3 w-16" />
      <Skeleton class="h-3 w-10" />
    </div>
  </div>

  <EmptyState
    v-else-if="!changes.length"
    :icon="History"
    title="No recent changes"
    description="Rollouts, config edits, scaling and warnings on the active clusters show up here, newest first."
  />

  <div v-else class="space-y-6">
    <div class="flex items-center gap-2">
      <div class="relative flex-1">
        <Search class="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <input
          ref="searchInput"
          v-model="query"
          type="text"
          spellcheck="false"
          placeholder="Search changes"
          aria-label="Search changes"
          title="Matches names, kinds, namespaces, clusters, what changed and who changed it"
          class="h-9 w-full rounded-lg border border-transparent bg-muted/60 pl-9 pr-9 text-sm transition-colors duration-fast placeholder:text-muted-foreground hover:bg-muted focus:border-input focus:bg-background focus:outline-none focus:ring-[3px] focus:ring-ring/15"
          @keydown="onSearchKeydown"
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
      <Button
        variant="ghost"
        size="icon-sm"
        class="shrink-0 text-muted-foreground"
        title="Read the history again"
        aria-label="Refresh"
        :disabled="reading"
        @click="timeline.refresh()"
      >
        <RefreshCw class="h-3.5 w-3.5" :class="{ 'animate-spin': reading }" />
      </Button>
    </div>

    <EmptyState v-if="!visible.length" :icon="Search" size="sm" title="No matching changes" description="Try another word." />

    <div v-else ref="listElement" role="grid" aria-label="Changes" class="space-y-6" @keydown="onListKeydown">
      <section v-for="day in days" :key="day.id" :aria-label="day.title">
        <h3 class="mb-1 flex h-7 items-center gap-2 px-3 text-xs font-medium text-foreground/80">
          {{ day.title }}
          <span class="font-normal tabular-nums text-muted-foreground">{{ day.changes.length }}</span>
        </h3>
        <div class="space-y-px">
          <ChangeRow
            v-for="change in day.changes"
            :key="change.key"
            :change="change"
            :show-context="multiCluster"
            :focused="focusedKey ? focusedKey === change.key : change === shown[0]"
            @open="open(change)"
            @open-object="openObject(setSidePanel, sidePanel, change)"
            @focus="focusedKey = change.key"
          />
        </div>
      </section>
      <div v-if="visible.length > shown.length" class="px-3">
        <Button variant="ghost" size="sm" class="text-muted-foreground" @click="limit += PAGE * 2">
          Show older changes
        </Button>
      </div>
    </div>

    <p class="px-3 text-xs text-muted-foreground/80">{{ footnote }} · / to search</p>
  </div>
</template>

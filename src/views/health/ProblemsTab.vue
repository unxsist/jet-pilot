<script setup lang="ts">
/*
 * Problems: what is broken on the active clusters right now, live. One row
 * per workload, node, job or claim in trouble (a bad rollout is one row,
 * "3 of 3 pods"), the most severe and newest first. Clicking a row opens
 * its evidence and fixes in the side panel; fixes, logs and snoozing are
 * also a hover or a key away. Snoozed problems wait, folded, at the end.
 */
import { useEventListener } from "@vueuse/core";
import { ChevronRight, CircleAlert, CircleCheck, Search, X } from "lucide-vue-next";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import ProblemRow from "@/views/health/problems/ProblemRow.vue";
import { injectStrict } from "@/lib/utils";
import {
  PanelProviderAddTabKey,
  PanelProviderSetSidePanelComponentKey,
  PanelProviderStateKey,
} from "@/providers/PanelProvider";
import { DialogProviderSpawnDialogKey } from "@/providers/DialogProvider";
import { SettingsContextStateKey } from "@/providers/SettingsContextProvider";
import { useAskAi } from "@/lib/ai/askAi";
import { resolveCluster } from "@/lib/clusters/meta";
import { useProblemFeed } from "@/lib/health/problems/feed";
import { partition, prune, snooze, unsnooze, type Snooze } from "@/lib/health/problems/snooze";
import { logSource } from "@/lib/health/problems/evidence";
import { podsWords } from "@/lib/health/problems/group";
import { askAbout, openLogs, openSubject } from "@/lib/health/problems/actions";
import { openProblemPanel, panelProblem, runFix } from "@/views/health/problems/panel";
import type { FixId } from "@/lib/health/problems/fixes";
import type { Problem } from "@/lib/health/problems/model";
import type { HealthTarget } from "@/lib/health/tabs";

const props = defineProps<{ targets: HealthTarget[] }>();

const setSidePanelComponent = injectStrict(PanelProviderSetSidePanelComponentKey);
const { sidePanel } = injectStrict(PanelProviderStateKey);
const addTab = injectStrict(PanelProviderAddTabKey);
const spawnDialog = injectStrict(DialogProviderSpawnDialogKey);
const { settings } = injectStrict(SettingsContextStateKey);
const askAi = useAskAi();

const feed = useProblemFeed({ targets: () => props.targets, events: true });
const { problems, loading, errors, now } = feed;

const multiCluster = computed(() => props.targets.length > 1);
const clusterName = (problem: Problem) =>
  multiCluster.value ? resolveCluster(settings.value.clusters, problem.context, problem.kubeConfig).displayName : undefined;

/* ------------------------------------------------------- snoozes -- */

const snoozes = computed<Snooze[]>(() => settings.value.snoozedProblems ?? []);
const setSnoozes = (next: Snooze[]) => {
  if (next !== settings.value.snoozedProblems) settings.value.snoozedProblems = next;
};

/* Acknowledged problems that were resolved show again when they come back. */
watch([problems, loading, now], () => {
  if (loading.value || !snoozes.value.length) return;
  setSnoozes(prune(snoozes.value, new Set(problems.value.map((p) => p.fingerprint)), feed.watches, Date.now()));
});

const doSnooze = (problem: Problem, ms?: number) => setSnoozes(snooze(snoozes.value, problem.fingerprint, Date.now(), ms));
const doUnsnooze = (problem: Problem) => setSnoozes(unsnooze(snoozes.value, problem.fingerprint));

/* ------------------------------------------------------ list state -- */

const query = ref("");
const matches = (problem: Problem, words: string[]) => {
  const text = [problem.subject.name, problem.namespace, problem.label, problem.short, problem.context, clusterName(problem), podsWords(problem)]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return words.every((word) => text.includes(word));
};
const visible = computed(() => {
  const words = query.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return words.length ? problems.value.filter((p) => matches(p, words)) : problems.value;
});
const lists = computed(() => partition(visible.value, snoozes.value, now.value));
const snoozedOpen = ref(false);

/* Searching pays off in a long list only. */
const searchable = computed(() => problems.value.length > 8);

const rows = computed<Problem[]>(() => [
  ...lists.value.open,
  ...(snoozedOpen.value ? lists.value.snoozed.map((s) => s.problem) : []),
]);

/* ------------------------------------------------- panel + focus -- */

const openKey = ref<string | null>(null);
const focusedKey = ref<string | null>(null);
const listElement = ref<HTMLElement | null>(null);

const open = (problem: Problem) => {
  focusedKey.value = problem.fingerprint;
  openKey.value = problem.fingerprint;
  openProblemPanel(setSidePanelComponent, problem);
};
/* Closing the side panel (or opening something else) ends the selection. */
watch(sidePanel, (panel) => {
  const key = panelProblem(panel);
  if (key !== openKey.value) openKey.value = key;
});

const focusRow = (key: string | undefined) => {
  if (!key) return;
  focusedKey.value = key;
  nextTick(() => listElement.value?.querySelector<HTMLElement>(`[data-problem-key="${CSS.escape(key)}"]`)?.focus());
};

/* --------------------------------------------------------- actions -- */

const doFix = (problem: Problem, fix: FixId) => runFix(problem, fix, spawnDialog);
const doLogs = (problem: Problem) => {
  const source = logSource(problem, feed.items("pods"), feed.items("jobs"));
  if (source) openLogs(problem, source, addTab);
};
const doOpenSubject = (problem: Problem) => openSubject(problem, setSidePanelComponent, sidePanel.value);
const doAsk = (problem: Problem) => askAbout(problem, askAi);

/* -------------------------------------------------------- keyboard -- */

const filterInput = ref<HTMLInputElement | null>(null);

const onListKeydown = (event: KeyboardEvent) => {
  const target = event.target as HTMLElement | null;
  if (target && target.closest("[data-problem-key]") !== target) return;
  const list = rows.value;
  const index = list.findIndex((p) => p.fingerprint === focusedKey.value);
  const current = list[index];
  switch (event.key) {
    case "ArrowDown":
    case "j": {
      event.preventDefault();
      const next = list[Math.min(list.length - 1, index + 1)];
      focusRow(next?.fingerprint);
      if (openKey.value && next) open(next);
      return;
    }
    case "ArrowUp":
    case "k": {
      event.preventDefault();
      if (index <= 0) filterInput.value?.focus();
      else {
        focusRow(list[index - 1]?.fingerprint);
        if (openKey.value) open(list[index - 1]!);
      }
      return;
    }
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
  if (current && event.key.toLowerCase() === "l" && !event.metaKey && !event.ctrlKey && !event.altKey) {
    event.preventDefault();
    doLogs(current);
  }
};

const onFilterKeydown = (event: KeyboardEvent) => {
  if (event.key === "ArrowDown") {
    event.preventDefault();
    focusRow(rows.value[0]?.fingerprint);
  } else if (event.key === "Enter" && rows.value.length) {
    event.preventDefault();
    open(rows.value[0]!);
  } else if (event.key === "Escape" && query.value) {
    event.stopPropagation();
    query.value = "";
  }
};

useEventListener(window, "keydown", (event: KeyboardEvent) => {
  if (event.key !== "/" || event.metaKey || event.ctrlKey || !searchable.value) return;
  const target = event.target as HTMLElement | null;
  if (target?.closest("input, textarea, [contenteditable=true], .monaco-editor, .xterm, [role=dialog]")) return;
  event.preventDefault();
  filterInput.value?.focus();
});

/* ------------------------------------------------------ empty states -- */

const noResults = computed(() => problems.value.length > 0 && visible.value.length === 0);
</script>

<template>
  <div class="space-y-6">
    <div
      v-for="error in errors"
      :key="error.kind"
      class="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive"
      role="alert"
    >
      <CircleAlert class="mt-px h-3.5 w-3.5 shrink-0" />
      <span>Couldn't watch {{ error.kind }}s: {{ error.message }}</span>
    </div>

    <!-- The first snapshot of every list -->
    <div v-if="loading && !problems.length" class="space-y-px" aria-label="Looking for problems">
      <div v-for="index in 4" :key="index" class="flex h-14 items-center gap-3 px-3">
        <Skeleton class="h-6 w-6 rounded-md" />
        <div class="flex-1 space-y-1.5">
          <Skeleton class="h-3.5 w-40" />
          <Skeleton class="h-3 w-64" />
        </div>
        <Skeleton class="h-3 w-24" />
      </div>
    </div>

    <EmptyState
      v-else-if="!problems.length"
      :icon="CircleCheck"
      title="Nothing is broken"
      description="Crash loops, failed jobs and nodes in trouble show up here the moment they happen."
    />

    <template v-else>
      <div v-if="searchable" class="relative">
        <Search class="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <input
          ref="filterInput"
          v-model="query"
          type="text"
          spellcheck="false"
          placeholder="Search problems"
          aria-label="Search problems"
          title="Matches names, namespaces, clusters and what's wrong"
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

      <EmptyState v-if="noResults" :icon="Search" size="sm" title="No matching problems" description="Try another word." />

      <div v-else ref="listElement" role="grid" aria-label="Problems" class="space-y-6" @keydown="onListKeydown">
        <EmptyState
          v-if="!lists.open.length"
          :icon="CircleCheck"
          size="sm"
          title="Nothing else is broken"
          description="What you snoozed is below, and shows again when its time is up."
        />
        <div v-else class="space-y-px">
          <ProblemRow
            v-for="problem in lists.open"
            :key="problem.fingerprint"
            :problem="problem"
            :focused="focusedKey ? focusedKey === problem.fingerprint : problem === rows[0]"
            :open="openKey === problem.fingerprint"
            :cluster="clusterName(problem)"
            :now="now"
            :can-ask="askAi.available.value"
            @open="open(problem)"
            @focus="focusedKey = problem.fingerprint"
            @fix="(fix) => doFix(problem, fix)"
            @logs="doLogs(problem)"
            @open-subject="doOpenSubject(problem)"
            @ask="doAsk(problem)"
            @snooze="(ms) => doSnooze(problem, ms)"
          />
        </div>

        <section v-if="lists.snoozed.length" aria-label="Snoozed">
          <button
            type="button"
            class="group/heading mb-1 flex h-7 w-full items-center gap-2 px-3 text-left text-xs font-medium text-muted-foreground hover:text-foreground"
            :aria-expanded="snoozedOpen"
            @click="snoozedOpen = !snoozedOpen"
          >
            <span class="text-foreground/80">Snoozed</span>
            <span class="font-normal tabular-nums">{{ lists.snoozed.length }}</span>
            <ChevronRight
              class="h-3.5 w-3.5 opacity-0 transition-[transform,opacity] duration-fast group-hover/heading:opacity-100"
              :class="snoozedOpen ? 'rotate-90' : 'opacity-100'"
            />
          </button>
          <div v-if="snoozedOpen" class="space-y-px">
            <ProblemRow
              v-for="{ problem, snooze: entry } in lists.snoozed"
              :key="problem.fingerprint"
              :problem="problem"
              :snooze="entry"
              :focused="focusedKey === problem.fingerprint"
              :open="openKey === problem.fingerprint"
              :cluster="clusterName(problem)"
              :now="now"
              :can-ask="askAi.available.value"
              @open="open(problem)"
              @focus="focusedKey = problem.fingerprint"
              @fix="(fix) => doFix(problem, fix)"
              @logs="doLogs(problem)"
              @open-subject="doOpenSubject(problem)"
              @ask="doAsk(problem)"
              @unsnooze="doUnsnooze(problem)"
            />
          </div>
        </section>
      </div>

      <p v-if="lists.open.length" class="px-3 text-xs text-muted-foreground/80">
        Click a problem for its evidence and fixes · L for logs{{ searchable ? " · / to search" : "" }}
      </p>
    </template>
  </div>
</template>

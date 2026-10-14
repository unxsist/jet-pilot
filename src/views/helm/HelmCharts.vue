<script setup lang="ts">
/*
 * Charts: find a chart and install it. One search covers your Helm
 * repositories (instant, local index) and Artifact Hub (only once you
 * type: the query goes to artifacthub.io through the backend). Picking a
 * chart opens the install flow; repositories are managed on their own tab.
 */
import { useRoute } from "vue-router";
import { useDebounceFn } from "@vueuse/core";
import { CloudOff, Loader2, PackageSearch, Search, X } from "lucide-vue-next";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import PageHeader from "@/components/page/PageHeader.vue";
import PageTabs from "@/components/page/PageTabs.vue";
import ChartRow from "./ChartRow.vue";
import RepositoriesPanel from "./RepositoriesPanel.vue";
import { useHelmRepos } from "./repos";
import { injectStrict } from "@/lib/utils";
import { KubeContextStateKey } from "@/providers/KubeContextProvider";
import { PanelProviderAddTabKey } from "@/providers/PanelProvider";
import { artifactHubSearch, searchRepos } from "@/lib/helmApi";
import {
  chartsFromArtifactHub,
  chartsFromRepoSearch,
  mergeChartResults,
  type ArtifactHubChart,
  type ChartEntry,
} from "@/lib/helm";

const route = useRoute();
const addTab = injectStrict(PanelProviderAddTabKey);
const { context, kubeConfig, contexts } = injectStrict(KubeContextStateKey);
const { repos, loaded: reposLoaded } = useHelmRepos();

const tab = ref<"search" | "repositories">(route.query.tab === "repositories" ? "repositories" : "search");
const query = ref(typeof route.query.q === "string" ? route.query.q : "");
const searchInput = ref<HTMLInputElement | null>(null);

/* Your repositories: the local index, searched on every keystroke. */
const LOCAL_LIMIT = 40;
const local = shallowRef<ChartEntry[]>([]);
const localLoading = ref(false);
const localError = ref("");
let localSeq = 0;

const searchLocal = async () => {
  const seq = ++localSeq;
  if (!repos.value.length) {
    local.value = [];
    return;
  }
  localLoading.value = true;
  try {
    const rows = await searchRepos(query.value);
    if (seq !== localSeq) return;
    local.value = chartsFromRepoSearch(rows, repos.value).sort((a, b) => a.name.localeCompare(b.name));
    localError.value = "";
  } catch (e) {
    if (seq === localSeq) localError.value = e instanceof Error ? e.message : String(e);
  } finally {
    if (seq === localSeq) localLoading.value = false;
  }
};

/* Artifact Hub: only for a typed query of two characters or more. */
const HUB_PAGE = 20;
const hub = shallowRef<ArtifactHubChart[]>([]);
const hubTotal = ref(0);
const hubLoading = ref(false);
const hubError = ref("");
let hubSeq = 0;

const hubQuery = computed(() => query.value.trim());
const hubActive = computed(() => hubQuery.value.length >= 2);

const searchHub = async (append = false) => {
  const seq = ++hubSeq;
  if (!hubActive.value) {
    hub.value = [];
    hubTotal.value = 0;
    hubLoading.value = false;
    return;
  }
  hubLoading.value = true;
  try {
    const result = await artifactHubSearch(hubQuery.value, HUB_PAGE, append ? hub.value.length : 0);
    if (seq !== hubSeq) return;
    hub.value = append ? [...hub.value, ...result.charts] : result.charts;
    hubTotal.value = result.total;
    hubError.value = "";
  } catch (e) {
    if (seq === hubSeq) hubError.value = e instanceof Error ? e.message : String(e);
  } finally {
    if (seq === hubSeq) hubLoading.value = false;
  }
};

const debouncedLocal = useDebounceFn(searchLocal, 150);
const debouncedHub = useDebounceFn(() => searchHub(), 400);

watch(query, () => {
  debouncedLocal();
  if (hubActive.value) {
    hubLoading.value = true;
    debouncedHub();
  } else {
    searchHub();
  }
});
watch(repos, searchLocal, { immediate: true });
if (hubActive.value) searchHub();

const merged = computed(() =>
  mergeChartResults(local.value, chartsFromArtifactHub(hub.value, repos.value))
);
const hubEntries = computed(() => merged.value.hub);
/* Artifact Hub's total, without the charts listed under your repositories. */
const hubCount = computed(() => Math.max(0, hubTotal.value - (hub.value.length - hubEntries.value.length)));
const localShown = computed(() => merged.value.local.slice(0, LOCAL_LIMIT));

const subtitle = computed(() =>
  repos.value.length
    ? `${repos.value.length} ${repos.value.length === 1 ? "repository" : "repositories"} and Artifact Hub`
    : "Search Artifact Hub, or add your own repositories"
);

/* ------------------------------------------------------------ install -- */

/* The cluster to install into: the primary one, in its only namespace. */
const installTarget = () => {
  const namespaces = contexts.value.get(context.value) ?? [];
  return {
    context: context.value,
    kubeConfig: kubeConfig.value,
    namespace: namespaces.length === 1 && namespaces[0] !== "all" ? namespaces[0] : "",
  };
};

const openInstall = (chart: ChartEntry) => {
  addTab(
    `helm-install/${chart.source}/${chart.repo}/${chart.name}`,
    `Install ${chart.name}`,
    defineAsyncComponent(() => import("./HelmInstall.vue")),
    { chart, ...installTarget() },
    "helm"
  );
};

const clear = () => {
  query.value = "";
  searchInput.value?.focus();
};

const onSearchKeydown = (event: KeyboardEvent) => {
  if (event.key === "Escape" && query.value) {
    event.preventDefault();
    clear();
  } else if (event.key === "ArrowDown") {
    event.preventDefault();
    (document.querySelector("[data-chart]") as HTMLElement | null)?.focus();
  }
};

/* Arrow keys move between results. */
const onListKeydown = (event: KeyboardEvent) => {
  if (!["ArrowDown", "ArrowUp"].includes(event.key)) return;
  const rows = Array.from(document.querySelectorAll<HTMLElement>("[data-chart]"));
  const index = rows.indexOf(document.activeElement as HTMLElement);
  if (index === -1) return;
  event.preventDefault();
  if (event.key === "ArrowUp" && index === 0) {
    searchInput.value?.focus();
    return;
  }
  rows[Math.max(0, Math.min(rows.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)))]?.focus();
};

onMounted(() => {
  if (tab.value === "search") searchInput.value?.focus();
});
</script>

<template>
  <div class="h-full overflow-auto bg-background">
    <div class="mx-auto max-w-4xl space-y-6 px-10 pb-16 pt-10">
      <PageHeader title="Charts" :description="subtitle">
        <template #tabs>
          <PageTabs
            v-model="tab"
            label="Charts"
            :tabs="[
              { id: 'search', label: 'Search' },
              { id: 'repositories', label: 'Repositories', count: repos.length || null },
            ]"
          />
        </template>
      </PageHeader>

      <RepositoriesPanel v-if="tab === 'repositories'" />

      <template v-else>
        <div class="relative">
          <Search class="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input
            ref="searchInput"
            v-model="query"
            type="text"
            spellcheck="false"
            autocomplete="off"
            placeholder="Search charts, like redis or ingress-nginx"
            aria-label="Search charts"
            class="h-10 w-full rounded-lg border border-transparent bg-muted/60 pl-9 pr-9 text-sm transition-colors duration-fast placeholder:text-muted-foreground hover:bg-muted focus:border-input focus:bg-background focus:outline-none focus:ring-[3px] focus:ring-ring/15"
            @keydown="onSearchKeydown"
          />
          <button
            v-if="query"
            type="button"
            class="absolute right-2 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
            aria-label="Clear search"
            @click="clear"
          >
            <X class="h-3.5 w-3.5" />
          </button>
        </div>

        <!-- Nothing typed, no repositories: what this page is for -->
        <EmptyState
          v-if="reposLoaded && !repos.length && !hubActive"
          :icon="PackageSearch"
          title="Find a chart to install"
          description="Search Artifact Hub for charts like postgresql or cert-manager. Add your own repositories on the Repositories tab and they're searched too."
        />

        <div v-else class="space-y-8" @keydown="onListKeydown">
          <!-- Your repositories -->
          <section v-if="repos.length" aria-label="Your repositories">
            <h2 class="mb-1 flex h-7 items-center gap-2 px-3 text-xs font-medium text-muted-foreground">
              <span class="text-foreground/80">Your repositories</span>
              <span class="font-normal tabular-nums">{{ local.length }}</span>
              <Loader2 v-if="localLoading" class="h-3 w-3 animate-spin" />
            </h2>
            <p v-if="localError" class="px-3 text-xs text-destructive select-text">{{ localError }}</p>
            <p
              v-else-if="!localLoading && !local.length"
              class="px-3 py-2 text-sm text-muted-foreground"
            >
              No chart in your repositories matches “{{ query.trim() }}”.
            </p>
            <div class="space-y-px">
              <ChartRow v-for="chart in localShown" :key="chart.key" :chart="chart" @open="openInstall(chart)" />
            </div>
            <p v-if="local.length > localShown.length" class="px-3 pt-2 text-xs text-muted-foreground">
              {{ local.length - localShown.length }} more. Type to narrow it down.
            </p>
          </section>

          <!-- Artifact Hub -->
          <section v-if="hubActive" aria-label="Artifact Hub">
            <h2 class="mb-1 flex h-7 items-center gap-2 px-3 text-xs font-medium text-muted-foreground">
              <span class="text-foreground/80">Artifact Hub</span>
              <span v-if="!hubLoading || hub.length" class="font-normal tabular-nums">{{ hubCount }}</span>
            </h2>
            <div v-if="hubLoading && !hub.length" class="space-y-1 px-3 py-1" aria-label="Searching Artifact Hub">
              <div v-for="i in 3" :key="i" class="flex items-center gap-3.5 py-1.5">
                <Skeleton class="h-9 w-9 rounded-lg" />
                <div class="flex-1 space-y-1.5">
                  <Skeleton class="h-3.5 w-40" />
                  <Skeleton class="h-3 w-3/4" />
                </div>
              </div>
            </div>
            <EmptyState
              v-else-if="hubError"
              :icon="CloudOff"
              title="Can't reach Artifact Hub"
              size="sm"
            >
              <span class="block text-xs">{{ hubError }}</span>
              <template #action>
                <Button variant="outline" size="sm" @click="searchHub()">Retry</Button>
              </template>
            </EmptyState>
            <p v-else-if="!hubEntries.length" class="px-3 py-2 text-sm text-muted-foreground">
              {{
                hub.length
                  ? "Everything Artifact Hub found is in your repositories already."
                  : `Nothing on Artifact Hub matches “${hubQuery}”.`
              }}
            </p>
            <div class="space-y-px">
              <ChartRow v-for="chart in hubEntries" :key="chart.key" :chart="chart" @open="openInstall(chart)" />
            </div>
            <div v-if="hub.length && hub.length < hubTotal && !hubError" class="px-3 pt-2">
              <Button variant="ghost" size="sm" class="text-muted-foreground" :disabled="hubLoading" @click="searchHub(true)">
                <Loader2 v-if="hubLoading" class="h-3.5 w-3.5 animate-spin" />
                Show more
              </Button>
            </div>
          </section>
        </div>
      </template>
    </div>
  </div>
</template>

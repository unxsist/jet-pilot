<script setup lang="ts">
import { Loader2, RefreshCw, TriangleAlert, Undo2 } from "lucide-vue-next";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import KindIcon from "@/components/KindIcon.vue";
import DiffView from "@/components/workloads/DiffView.vue";
import { formatAge } from "@/components/tables/age";
import { formatDateTime, injectStrict } from "@/lib/utils";
import { errorText } from "@/lib/auth/classify";
import { DialogProviderSpawnDialogKey } from "@/providers/DialogProvider";
import { rollbackRelease } from "@/actions/helm-release";
import { releaseDetail, releaseHistory } from "@/lib/helmApi";
import {
  HelmRevision,
  helmStatusTone,
  releaseStatus,
  sortRevisionsDesc,
  valuesYaml,
} from "@/lib/helm";

/*
 * Revision history of a Helm release (read natively): status, chart, app
 * version and description per revision, the values / manifest of a
 * revision compared with the deployed one, its predecessor or a revision
 * picked in the release panel, and rollback with confirmation.
 */
const props = defineProps<{
  context: string;
  namespace: string;
  kubeConfig: string;
  release: {
    name: string;
    namespace: string;
    chart: string;
    chartVersion: string;
    appVersion: string;
    revision: number;
    status: string;
  };
  /** Two revisions to open on (from the release panel). */
  compare?: { revision: number; base: number; show?: "values" | "manifest" };
  tabId?: string;
}>();

const spawnDialog = injectStrict(DialogProviderSpawnDialogKey);
const target = computed(() => ({ context: props.context, kubeConfig: props.kubeConfig }));

const revisions = shallowRef<HelmRevision[]>([]);
const loading = ref(true);
const loadError = ref("");
const selected = ref<number | null>(props.compare?.revision ?? null);
const compareWith = ref<"deployed" | "previous" | "picked">(props.compare ? "picked" : "deployed");
const pickedBase = ref<number | null>(props.compare?.base ?? null);
const show = ref<"values" | "manifest">(props.compare?.show ?? "values");
const rollingBack = ref(false);

const deployed = computed(
  () =>
    revisions.value.find((r) => r.status === "deployed") ?? revisions.value[0] ?? null
);

const load = async () => {
  try {
    revisions.value = sortRevisionsDesc(
      await releaseHistory(target.value, props.release.namespace, props.release.name)
    );
    loadError.value = "";
  } catch (e) {
    loadError.value = errorText(e);
    return;
  } finally {
    loading.value = false;
  }
  if (selected.value === null || !revisions.value.some((r) => r.revision === selected.value)) {
    selected.value =
      revisions.value.find((r) => r.revision !== deployed.value?.revision)?.revision ??
      revisions.value[0]?.revision ??
      null;
  }
};

/* values and manifest per revision, read on demand */
const cache = reactive(new Map<string, string | { error: string }>());
const pending = new Set<number>();
const fetchRevision = async (revision: number, what: "values" | "manifest") => {
  if (cache.has(`${what}:${revision}`) || pending.has(revision)) return;
  pending.add(revision);
  try {
    const detail = await releaseDetail(target.value, props.release.namespace, props.release.name, revision);
    cache.set(`values:${revision}`, valuesYaml(detail.values));
    cache.set(`manifest:${revision}`, detail.manifest);
  } catch (e) {
    const failure = { error: errorText(e) };
    cache.set(`values:${revision}`, failure);
    cache.set(`manifest:${revision}`, failure);
  } finally {
    pending.delete(revision);
  }
};

const selectedRevision = computed(
  () => revisions.value.find((r) => r.revision === selected.value) ?? null
);
const baseRevision = computed(() => {
  const sel = selectedRevision.value;
  if (!sel) return null;
  if (compareWith.value === "picked") {
    return revisions.value.find((r) => r.revision === pickedBase.value && r.revision !== sel.revision) ?? null;
  }
  if (compareWith.value === "deployed" && deployed.value && sel.revision !== deployed.value.revision) {
    return deployed.value;
  }
  return revisions.value.find((r) => r.revision < sel.revision) ?? null;
});

watch(
  [selectedRevision, baseRevision, show],
  () => {
    for (const r of [selectedRevision.value, baseRevision.value]) {
      if (r) fetchRevision(r.revision, show.value);
    }
  },
  { immediate: true }
);

const text = (revision: HelmRevision | null) => {
  if (!revision) return "";
  const value = cache.get(`${show.value}:${revision.revision}`);
  return typeof value === "string" ? value : "";
};
const fetchError = computed(() => {
  for (const r of [selectedRevision.value, baseRevision.value]) {
    const value = r ? cache.get(`${show.value}:${r.revision}`) : undefined;
    if (value && typeof value !== "string") return value.error;
  }
  return "";
});
const ready = computed(() =>
  [selectedRevision.value, baseRevision.value].every(
    (r) => !r || cache.has(`${show.value}:${r.revision}`)
  )
);

const compareOptions = computed(() =>
  pickedBase.value !== null
    ? (["deployed", "previous", "picked"] as const)
    : (["deployed", "previous"] as const)
);

const label = (r: HelmRevision | null) =>
  r ? `#${r.revision}${r.revision === deployed.value?.revision ? " (deployed)" : ""}` : "(nothing)";

const confirmRollback = async () => {
  const revision = selectedRevision.value;
  if (!revision || revision.revision === deployed.value?.revision) return;
  rollingBack.value = true;
  const row = {
    ...props.release,
    metadata: { context: props.context, kubeConfig: props.kubeConfig, name: props.release.name, namespace: props.release.namespace },
  };
  if (await rollbackRelease(spawnDialog, row, revision)) await load();
  rollingBack.value = false;
};

const onListKeydown = (event: KeyboardEvent) => {
  if (!["ArrowUp", "ArrowDown"].includes(event.key)) return;
  event.preventDefault();
  const index = revisions.value.findIndex((r) => r.revision === selected.value);
  const next =
    event.key === "ArrowDown"
      ? Math.min(revisions.value.length - 1, index + 1)
      : Math.max(0, index - 1);
  selected.value = revisions.value[next]?.revision ?? selected.value;
};

onMounted(load);
</script>

<template>
  <div class="flex h-full flex-col bg-background">
    <div class="flex h-11 shrink-0 items-center gap-3 border-b bg-surface-1 px-3">
      <KindIcon name="helm" class="text-muted-foreground" />
      <span class="truncate text-sm font-medium">History of {{ release.name }}</span>
      <span class="hidden truncate text-xs text-muted-foreground md:inline"
        >{{ context }} › {{ release.namespace }}</span
      >
      <Button
        variant="ghost"
        size="icon-sm"
        class="ml-auto text-muted-foreground"
        aria-label="Refresh"
        title="Refresh"
        @click="load"
      >
        <RefreshCw class="h-3.5 w-3.5" />
      </Button>
    </div>

    <div v-if="loading" class="flex flex-1 items-center justify-center">
      <Loader2 class="h-5 w-5 animate-spin text-muted-foreground" />
    </div>
    <div v-else-if="loadError" class="flex flex-1 items-center justify-center p-4">
      <EmptyState :icon="TriangleAlert" :title="`Unable to load the history of ${release.name}`" class="max-w-xl">
        <pre class="whitespace-pre-wrap break-words font-mono text-xs select-text">{{ loadError }}</pre>
        <template #action>
          <Button variant="outline" size="sm" @click="load">Retry</Button>
        </template>
      </EmptyState>
    </div>
    <div v-else class="flex min-h-0 flex-1">
      <div
        class="flex w-80 min-w-[18rem] flex-col border-r bg-surface-1"
        role="listbox"
        aria-label="Revisions"
        tabindex="0"
        @keydown="onListKeydown"
      >
        <div class="flex h-9 shrink-0 items-center px-3 text-xs font-medium text-muted-foreground">
          Revisions
          <span class="ml-auto font-normal normal-case tracking-normal tabular-nums">{{ revisions.length }}</span>
        </div>
        <div class="min-h-0 flex-1 space-y-1 overflow-y-auto px-1.5 pb-2">
          <button
            v-for="revision in revisions"
            :key="revision.revision"
            type="button"
            role="option"
            :aria-selected="revision.revision === selected"
            class="block w-full rounded-md border px-2.5 py-2 text-left transition-colors duration-fast focus-ring"
            :class="
              revision.revision === selected
                ? 'border-primary/40 bg-primary/10'
                : 'border-transparent hover:bg-accent'
            "
            @click="selected = revision.revision"
          >
            <div class="flex items-center gap-2">
              <span class="font-mono text-sm font-semibold tabular-nums">#{{ revision.revision }}</span>
              <Badge :variant="helmStatusTone(revision.status)" size="sm">{{ releaseStatus(revision.status).label }}</Badge>
              <span
                class="ml-auto text-xs tabular-nums text-muted-foreground"
                :title="revision.updated ? formatDateTime(new Date(revision.updated)) : undefined"
                >{{ formatAge(revision.updated) }}</span
              >
            </div>
            <p class="mt-1 truncate text-2xs text-muted-foreground">
              {{ revision.chart }} {{ revision.chartVersion }} · app {{ revision.appVersion || "–" }}
            </p>
            <p class="mt-0.5 line-clamp-2 text-xs">{{ revision.description }}</p>
          </button>
        </div>
      </div>

      <div class="flex min-w-0 flex-1 flex-col">
        <div class="flex h-11 shrink-0 items-center gap-2 border-b px-3" role="toolbar">
          <div class="inline-flex h-7 items-center rounded-md bg-muted p-0.5" role="group" aria-label="Show">
            <button
              v-for="option in (['values', 'manifest'] as const)"
              :key="option"
              type="button"
              class="h-6 rounded-[5px] px-2 text-xs font-medium capitalize transition-colors duration-fast focus-ring"
              :class="show === option ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'"
              :aria-pressed="show === option"
              @click="show = option"
            >
              {{ option }}
            </button>
          </div>
          <span class="text-xs text-muted-foreground">compared with</span>
          <div class="inline-flex h-7 items-center rounded-md bg-muted p-0.5" role="group" aria-label="Compare with">
            <button
              v-for="option in compareOptions"
              :key="option"
              type="button"
              class="h-6 rounded-[5px] px-2 text-xs font-medium transition-colors duration-fast focus-ring"
              :class="compareWith === option ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'"
              :aria-pressed="compareWith === option"
              @click="compareWith = option"
            >
              {{ option === "deployed" ? "Deployed revision" : option === "previous" ? "Previous revision" : `#${pickedBase}` }}
            </button>
          </div>
          <Button
            class="ml-auto"
            size="sm"
            :disabled="!selectedRevision || selectedRevision.revision === deployed?.revision || rollingBack"
            @click="confirmRollback"
          >
            <Loader2 v-if="rollingBack" class="h-3.5 w-3.5 animate-spin" />
            <Undo2 v-else class="h-3.5 w-3.5" />
            {{
              selectedRevision && selectedRevision.revision !== deployed?.revision
                ? `Roll back to #${selectedRevision.revision}`
                : "Roll back"
            }}
          </Button>
        </div>
        <div class="min-h-0 flex-1">
          <div v-if="fetchError" class="flex h-full items-center justify-center p-4">
            <EmptyState :icon="TriangleAlert" :title="`Unable to load the ${show}`" class="max-w-xl">
              <pre class="whitespace-pre-wrap break-words font-mono text-xs select-text">{{ fetchError }}</pre>
            </EmptyState>
          </div>
          <div v-else-if="!ready" class="flex h-full items-center justify-center">
            <Loader2 class="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
          <DiffView
            v-else-if="selectedRevision"
            :old-text="text(baseRevision)"
            :new-text="text(selectedRevision)"
            :old-label="label(baseRevision)"
            :new-label="label(selectedRevision)"
            :empty-text="baseRevision ? `Identical ${show}` : 'This is the oldest revision'"
          />
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import {
  Boxes,
  CircleArrowUp,
  ArrowUpRight,
  FileText,
  FolderTree,
  History,
  ListTree,
  Loader2,
  NotebookText,
  RefreshCw,
  SlidersHorizontal,
  Trash2,
  TriangleAlert,
  Undo2,
  Webhook,
} from "lucide-vue-next";
import { open as openExternal } from "@tauri-apps/plugin-shell";
import { Accordion } from "@/components/ui/accordion";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import { StatusBadge, StatusDot } from "@/components/ui/status";
import PanelSection from "@/components/generic/PanelSection.vue";
import ContextAvatar from "@/components/ContextAvatar.vue";
import ChartAvatar from "./ChartAvatar.vue";
import CopyButton from "./CopyButton.vue";
import ReleaseNotes from "./ReleaseNotes.vue";
import ReleaseResources from "./ReleaseResources.vue";
import RevisionTimeline from "./RevisionTimeline.vue";
import YamlView from "./YamlView.vue";
import { injectStrict, formatDateTime } from "@/lib/utils";
import { errorText } from "@/lib/auth/classify";
import { guardedCluster } from "@/lib/guardrails/backstop";
import { readOnlyReason } from "@/lib/guardrails/policy";
import { DialogProviderSpawnDialogKey } from "@/providers/DialogProvider";
import {
  PanelProviderAddTabKey,
  PanelProviderSetSidePanelComponentKey,
} from "@/providers/PanelProvider";
import {
  openHistory,
  openUpgrade,
  rollbackRelease,
  uninstallReleases,
} from "@/actions/helm-release";
import { releaseDetail, releaseHistory } from "@/lib/helmApi";
import {
  parseManifest,
  releaseStatus,
  timeAgo,
  valuesYaml,
  type HelmReleaseDetail,
  type HelmReleaseRow,
  type HelmRevision,
} from "@/lib/helm";

/*
 * A release explains itself: how it's doing (and what to do when it
 * isn't), its notes, what it installed (live), its values and its
 * history. Read natively; refreshed while open.
 */
const props = defineProps<{ release: HelmReleaseRow }>();

const addTab = injectStrict(PanelProviderAddTabKey);
const spawnDialog = injectStrict(DialogProviderSpawnDialogKey);
const setSidePanelComponent = injectStrict(PanelProviderSetSidePanelComponentKey);

const target = computed(() => ({
  context: props.release.metadata.context,
  kubeConfig: props.release.metadata.kubeConfig,
}));

const detail = shallowRef<HelmReleaseDetail | null>(null);
const history = shallowRef<HelmRevision[]>([]);
const loadError = ref("");
const loading = ref(true);
const busy = ref(false);

/* The latest revision as last read (the row is a snapshot). */
const latest = computed(() => history.value[0] ?? null);
const status = computed(() => releaseStatus(latest.value?.status ?? props.release.status));
const revision = computed(() => latest.value?.revision ?? props.release.revision);
const updated = computed(() => latest.value?.updated ?? props.release.updated ?? null);
const row = computed<HelmReleaseRow>(() => ({
  ...props.release,
  revision: revision.value,
  status: latest.value?.status ?? props.release.status,
  chartVersion: latest.value?.chartVersion ?? props.release.chartVersion,
  appVersion: latest.value?.appVersion ?? props.release.appVersion,
}));

let sequence = 0;
const load = async (initial = false) => {
  const current = ++sequence;
  if (initial) loading.value = true;
  try {
    const revisions = await releaseHistory(target.value, props.release.namespace, props.release.name);
    if (current !== sequence) return;
    const changed =
      !detail.value ||
      revisions[0]?.revision !== detail.value.revision ||
      revisions[0]?.status !== detail.value.status;
    history.value = revisions;
    if (changed) {
      const next = await releaseDetail(target.value, props.release.namespace, props.release.name);
      if (current !== sequence) return;
      detail.value = next;
    }
    loadError.value = "";
  } catch (e) {
    if (current === sequence) loadError.value = errorText(e);
  } finally {
    if (current === sequence) loading.value = false;
  }
};

watch(
  () => `${props.release.metadata.context}/${props.release.namespace}/${props.release.name}`,
  () => {
    detail.value = null;
    history.value = [];
    load(true);
  },
  { immediate: true }
);

/* Live-ish: helm may still be working on it, or someone else may. */
const timer = setInterval(() => {
  if (!document.hidden && !busy.value) load();
}, 10_000);
onUnmounted(() => clearInterval(timer));

/* ------------------------------------------------------------ facts -- */

const blocked = computed(() => {
  const cluster = guardedCluster(target.value.context, target.value.kubeConfig);
  return cluster.readOnly ? readOnlyReason(cluster) : "";
});

const objects = computed(() =>
  detail.value ? parseManifest(detail.value.manifest, props.release.namespace) : []
);

const links = computed(() => {
  const chart = detail.value?.chart;
  if (!chart) return [];
  const source = (chart.sources ?? []).find((s) => s && s !== chart.home);
  return [
    { label: "Home", url: chart.home ?? "" },
    { label: "Source", url: source ?? "" },
  ].filter((l) => /^https?:\/\//.test(l.url));
});

/* The revision to go back to when the latest one failed or got stuck. */
const lastGood = computed(() =>
  history.value.find(
    (r) => r.revision < revision.value && (r.status === "deployed" || r.status === "superseded")
  ) ?? null
);

const problemTitle = computed(() => {
  const s = latest.value?.status ?? props.release.status;
  if (s === "failed") return "The last change failed";
  if (s === "pending-install") return "Helm is still installing this release";
  if (s === "pending-upgrade") return "Helm is still upgrading this release";
  if (s === "pending-rollback") return "Helm is still rolling this release back";
  if (s === "uninstalling") return "Helm is uninstalling this release";
  return "";
});

/* ----------------------------------------------------------- values -- */

const valuesMode = ref<"user" | "computed">("user");
const valuesText = computed(() =>
  detail.value
    ? valuesYaml(valuesMode.value === "user" ? detail.value.values : detail.value.computedValues)
    : ""
);

/* ---------------------------------------------------------- actions -- */

const upgrade = () => openUpgrade(addTab, row.value);

const rollback = async (to: HelmRevision) => {
  busy.value = true;
  try {
    if (await rollbackRelease(spawnDialog, row.value, to)) await load();
  } finally {
    busy.value = false;
  }
};

const compare = (newer: number, older: number, show: "values" | "manifest") =>
  openHistory(addTab, row.value, { revision: newer, base: older, show });

const uninstall = async () => {
  busy.value = true;
  try {
    const done = await uninstallReleases(spawnDialog, [row.value]);
    if (done.length) setSidePanelComponent(null);
  } finally {
    busy.value = false;
  }
};

const sections = ["notes", "resources", "values", "history"];
</script>

<template>
  <div class="bg-card">
    <!-- How it's doing -->
    <div class="space-y-3 border-b px-4 pb-4 pt-3">
      <div class="flex flex-wrap items-center gap-x-2 gap-y-1.5 text-xs text-muted-foreground">
        <StatusBadge :tone="status.tone" :pulse="status.busy">{{ status.label }}</StatusBadge>
        <span class="tabular-nums">Revision {{ revision }}</span>
        <span
          v-if="updated"
          class="tabular-nums"
          :title="formatDateTime(new Date(updated))"
        >· {{ timeAgo(updated) }}</span>
      </div>

      <!-- Quiet facts: namespace, cluster -->
      <dl class="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <div class="flex min-w-0 items-center gap-1.5">
          <dt class="sr-only">Namespace</dt>
          <FolderTree class="h-3 w-3 shrink-0" />
          <dd class="truncate">{{ release.namespace }}</dd>
        </div>
        <div class="flex min-w-0 items-center gap-1.5">
          <dt class="sr-only">Cluster</dt>
          <ContextAvatar :name="target.context" :kube-config="target.kubeConfig" size="sm" class="h-4 w-4 text-[9px]" />
          <dd class="truncate" :title="target.kubeConfig">{{ target.context }}</dd>
        </div>
      </dl>

      <!-- The chart -->
      <div class="flex gap-3 rounded-lg border border-border-subtle bg-surface-1 p-3">
        <ChartAvatar :name="row.chart || release.name" />
        <div class="min-w-0 flex-1 space-y-1">
          <p class="flex min-w-0 items-baseline gap-1.5 text-sm">
            <span class="truncate font-medium">{{ row.chart || "Unknown chart" }}</span>
            <span class="shrink-0 text-xs tabular-nums text-muted-foreground">{{ row.chartVersion }}</span>
          </p>
          <p class="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
            <span v-if="row.appVersion">App <span class="select-text font-mono">{{ row.appVersion }}</span></span>
            <button
              v-for="link in links"
              :key="link.url"
              type="button"
              class="inline-flex items-center gap-0.5 rounded-sm text-link hover:underline focus-ring"
              :title="link.url"
              @click="openExternal(link.url)"
            >
              {{ link.label }} <ArrowUpRight class="h-3 w-3" />
            </button>
          </p>
          <p v-if="detail?.chart.description" class="line-clamp-2 pt-0.5 text-xs leading-relaxed text-muted-foreground">
            {{ detail.chart.description }}
          </p>
        </div>
      </div>

      <!-- A failed or stuck release says what happened and offers the way back -->
      <div
        v-if="status.problem && problemTitle"
        role="status"
        class="rounded-lg border px-3 py-2.5"
        :class="
          status.tone === 'destructive'
            ? 'border-destructive/20 bg-destructive/5'
            : 'border-warning/20 bg-warning/5'
        "
      >
        <p
          class="flex items-center gap-1.5 text-xs font-medium"
          :class="status.tone === 'destructive' ? 'text-destructive' : 'text-warning'"
        >
          <TriangleAlert v-if="status.tone === 'destructive'" class="h-3.5 w-3.5" />
          <Loader2 v-else class="h-3.5 w-3.5 animate-spin" />
          {{ problemTitle }}
        </p>
        <p v-if="latest?.description" class="mt-1 break-words text-xs text-foreground/90 select-text">
          {{ latest.description }}
        </p>
        <div v-if="lastGood && !blocked" class="mt-2 flex items-center gap-2">
          <Button size="xs" variant="outline" :disabled="busy" @click="rollback(lastGood)">
            <Undo2 class="h-3 w-3" /> Roll back to #{{ lastGood.revision }}
          </Button>
          <span class="truncate text-xs text-muted-foreground">
            {{ lastGood.chartVersion }}, {{ timeAgo(lastGood.updated) }}
          </span>
        </div>
      </div>

      <div class="flex flex-wrap items-center gap-1.5">
        <span class="inline-flex" :title="blocked || undefined">
          <Button variant="outline" size="xs" :disabled="!!blocked || busy" @click="upgrade">
            <CircleArrowUp class="h-3 w-3" /> Upgrade
          </Button>
        </span>
        <Button variant="outline" size="xs" @click="openHistory(addTab, row)">
          <History class="h-3 w-3" /> Compare revisions
        </Button>
        <span class="ml-auto inline-flex" :title="blocked || undefined">
          <Button
            variant="ghost"
            size="xs"
            class="text-muted-foreground hover:text-destructive"
            :disabled="!!blocked || busy"
            @click="uninstall"
          >
            <Trash2 class="h-3 w-3" /> Uninstall
          </Button>
        </span>
      </div>
    </div>

    <div v-if="loading && !detail" class="space-y-3 p-4" aria-label="Reading the release">
      <Skeleton class="h-4 w-1/3" />
      <Skeleton class="h-16 w-full" />
      <Skeleton class="h-4 w-1/4" />
      <Skeleton class="h-24 w-full" />
    </div>

    <EmptyState
      v-else-if="loadError && !detail"
      :icon="TriangleAlert"
      title="Can't read this release"
      size="sm"
      class="px-6"
    >
      <span class="block break-words text-xs select-text">{{ loadError }}</span>
      <template #action>
        <Button variant="outline" size="sm" @click="load(true)">
          <RefreshCw class="h-3.5 w-3.5" /> Retry
        </Button>
      </template>
    </EmptyState>

    <Accordion v-else-if="detail" class="w-full" type="multiple" collapsible :default-value="sections">
      <PanelSection v-if="detail.notes.trim()" value="notes" title="Notes" :icon="NotebookText">
        <ReleaseNotes :notes="detail.notes" />
      </PanelSection>

      <PanelSection value="resources" title="Resources" :icon="Boxes" :count="objects.length">
        <ReleaseResources
          v-if="objects.length"
          :objects="objects"
          :context="target.context"
          :kube-config="target.kubeConfig"
          :namespace="release.namespace"
        />
        <p v-else class="text-xs text-muted-foreground">This release doesn't install any objects.</p>
      </PanelSection>

      <PanelSection value="values" title="Values" :icon="SlidersHorizontal">
        <div class="mb-2 flex items-center gap-2">
          <div class="inline-flex h-7 items-center rounded-md bg-muted p-0.5" role="group" aria-label="Values">
            <button
              v-for="option in ([['user', 'Yours'], ['computed', 'All values']] as const)"
              :key="option[0]"
              type="button"
              class="h-6 rounded-[5px] px-2 text-xs font-medium transition-colors duration-fast focus-ring"
              :class="valuesMode === option[0] ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'"
              :aria-pressed="valuesMode === option[0]"
              @click="valuesMode = option[0]"
            >
              {{ option[1] }}
            </button>
          </div>
          <span class="truncate text-xs text-muted-foreground">
            {{ valuesMode === "user" ? "Set at install or upgrade" : "Chart defaults with yours on top" }}
          </span>
          <CopyButton v-if="valuesText" :text="valuesText" label="Copy values" class="ml-auto" />
        </div>
        <div v-if="valuesText" class="rounded-lg border border-border-subtle bg-surface-1 px-3 py-2">
          <YamlView :text="valuesText" max-height="22rem" />
        </div>
        <p v-else class="rounded-lg border border-dashed px-3 py-3 text-xs text-muted-foreground">
          {{
            valuesMode === "user"
              ? "No values of your own: the chart's defaults apply."
              : "The chart has no values."
          }}
          <button
            v-if="valuesMode === 'user'"
            type="button"
            class="ml-1 rounded-sm text-link hover:underline focus-ring"
            @click="valuesMode = 'computed'"
          >
            Show all values
          </button>
        </p>
      </PanelSection>

      <PanelSection value="history" title="History" :icon="ListTree" :count="history.length">
        <RevisionTimeline
          :revisions="history"
          :current="revision"
          :can-roll-back="!blocked && !busy"
          @rollback="rollback"
          @compare="compare"
        />
      </PanelSection>

      <PanelSection v-if="detail.hooks.length" value="hooks" title="Hooks" :icon="Webhook" :count="detail.hooks.length">
        <ul class="space-y-1.5">
          <li v-for="hook in detail.hooks" :key="hook.name" class="flex items-center gap-2 text-xs">
            <StatusDot
              :tone="hook.phase === 'Failed' ? 'destructive' : hook.phase === 'Running' ? 'warning' : hook.phase ? 'success' : 'muted'"
              size="sm"
              :label="hook.phase || 'Not run'"
            />
            <span class="min-w-0 truncate">{{ hook.name }}</span>
            <span class="shrink-0 text-muted-foreground">{{ hook.kind }}</span>
            <span class="ml-auto shrink-0 truncate text-muted-foreground">{{ hook.events.join(", ") }}</span>
          </li>
        </ul>
      </PanelSection>

      <PanelSection value="manifest" title="Manifest" :icon="FileText">
        <div class="mb-2 flex items-center justify-end">
          <CopyButton :text="detail.manifest" label="Copy manifest" show-label />
        </div>
        <div class="rounded-lg border border-border-subtle bg-surface-1 px-3 py-2">
          <YamlView :text="detail.manifest.replace(/^---\n/, '')" max-height="28rem" />
        </div>
      </PanelSection>
    </Accordion>
  </div>
</template>

<script setup lang="ts">
/**
 * Usage of an object over time, at the top of its side panel: CPU and
 * memory (and network for pods) with requests and limits, from the
 * cluster's Prometheus for a chosen range, or metrics-server's last
 * minutes without one. Self-contained: drop it into any panel's Accordion
 * with the object (Pod, workload, Node, Namespace) as `resource`.
 */
import { useElementSize } from "@vueuse/core";
import { AlertCircle, ChartSpline } from "lucide-vue-next";
import PanelSection from "@/components/generic/PanelSection.vue";
import TimeSeriesChart from "@/components/charts/TimeSeriesChart.vue";
import { TONE_COLORS } from "@/components/charts/types";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useUsage } from "@/composables/useUsage";
import { KubeContextStateKey } from "@/providers/KubeContextProvider";
import { injectStrict } from "@/lib/utils";
import { useClusters } from "@/lib/clusters/useClusters";
import { usageTone } from "@/components/tables/metrics";
import { KIND_LABELS, describeSource } from "@/lib/metrics/prometheus";
import { valueAt } from "@/lib/metrics/series";
import { RANGES, type RangeId } from "@/lib/metrics/time";
import { formatValue, percentOf } from "@/lib/metrics/units";
import type { Subject, UsageChart } from "@/lib/metrics/usage";

const props = defineProps<{ resource: Subject }>();

const { context: primaryContext, kubeConfig: primaryKubeConfig, contexts, contextKubeConfigMapping } =
  injectStrict(KubeContextStateKey);
const clusters = useClusters();

const target = computed(() => {
  const context = props.resource.metadata?.context || primaryContext.value;
  const kubeConfig = props.resource.metadata?.kubeConfig || contextKubeConfigMapping.value.get(context) || primaryKubeConfig.value;
  return { context, kubeConfig };
});

/* The range sticks for the session: comparing objects at the same zoom. */
const range = sessionRange;
const body = ref<HTMLElement | null>(null);
const { width } = useElementSize(body);

const { status, source, data, error, refreshing, fallbackState, reload } = useUsage({
  subject: () => props.resource,
  target: () => target.value,
  setting: () => clusters.resolve(target.value.context, target.value.kubeConfig).metrics,
  namespaces: () => {
    const active = contexts.value.get(target.value.context);
    return active ? [...active] : [];
  },
  range,
  width: computed(() => width.value - 46),
});

const isPrometheus = computed(() => source.value?.type === "prometheus");
const rangeLabel = computed(() => {
  const r = RANGES.find((r) => r.id === range.value)!;
  return r.id === "7d" ? "the last 7 days" : r.id === "1h" ? "the last hour" : `the last ${r.seconds / 3600} hours`;
});

/* Per-pod lines for objects with several pods. */
const byPod = ref(false);
const hasPods = computed(() => isPrometheus.value && (data.value?.charts.some((c) => (c.pods?.length ?? 0) > 1) ?? false));

/* The hovered slot, shared by the charts. */
const hover = ref<number | null>(null);
watch(data, (next) => {
  // A refresh keeps the crosshair; a new timeline drops it.
  if (hover.value !== null && hover.value >= (next?.times.length ?? 0)) hover.value = null;
});

const charts = computed(() => data.value?.charts ?? []);
const skeletons = computed(() => (props.resource.kind === "Pod" ? 3 : 2));

/** A chart's header: the value at the hovered slot (or the newest), and how close it is to its limit. */
const headline = (chart: UsageChart) => {
  const main = chart.series[0];
  if (!main) return null;
  const index = hover.value ?? main.values.length - 1;
  const value = valueAt(main.values, index);
  if (value === null) return null;
  const refAt = (id: string) => {
    const ref = chart.references.find((r) => r.id === id);
    if (!ref) return undefined;
    return typeof ref.values === "number" ? ref.values : valueAt(ref.values, index) ?? undefined;
  };
  const limit = refAt("limit") ?? refAt("allocatable");
  const request = refAt("request");
  const percent = percentOf(value, limit ?? request);
  const of = limit !== undefined ? (chart.references.some((r) => r.id === "allocatable") ? "of allocatable" : "of limit") : "of request";
  const tone = limit ? usageTone(value, { request: request ?? 0, limit }) : "normal";
  return { text: formatValue(chart.unit, value), percent: percent ? `${percent} ${of}` : null, tone };
};

const TONE_CLASS = { normal: "text-muted-foreground", warning: "text-warning", destructive: "text-destructive" };

const sourceLine = computed(() => {
  const s = source.value;
  if (!s) return "";
  if (s.type === "prometheus") {
    const kind = s.kind ? KIND_LABELS[s.kind] : null;
    return kind ? `${kind} · ${describeSource(s.source)}` : describeSource(s.source);
  }
  return s.reason === "off" ? "metrics-server · history is off for this cluster" : "metrics-server";
});

const fallbackEmpty = computed(
  () => source.value?.type === "metrics-server" && status.value === "ready" && !data.value?.times.length
);
const fallbackMessage = computed(() =>
  fallbackState.value === "forbidden"
    ? "You're not allowed to read metrics in this cluster."
    : "Usage shows here when the cluster runs metrics-server or Prometheus."
);

const showDetail = ref(false);
watch(error, () => (showDetail.value = false));

const dialogOpen = ref(false);
/* Mounted from the first open on, so closing animates. */
const dialogUsed = ref(false);
watch(dialogOpen, (isOpen) => isOpen && (dialogUsed.value = true));
const MetricsSourceDialog = defineAsyncComponent(() => import("./MetricsSourceDialog.vue"));
</script>

<script lang="ts">
import { ref } from "vue";

const sessionRange = ref<RangeId>("6h");
</script>

<template>
  <PanelSection value="usage" title="Usage" :icon="ChartSpline">
    <div ref="body" class="space-y-4">
      <!-- Range -->
      <div class="flex h-7 items-center justify-between gap-3">
        <Tabs v-if="isPrometheus" v-model="range">
          <TabsList class="h-7 rounded-md" aria-label="Time range">
            <TabsTrigger
              v-for="r in RANGES"
              :key="r.id"
              :value="r.id"
              class="h-6 rounded-[5px] px-2.5 text-xs tabular-nums"
            >
              {{ r.label }}
            </TabsTrigger>
          </TabsList>
        </Tabs>
        <span v-else-if="source" class="text-xs text-muted-foreground">Last 15 minutes</span>
        <span v-else />
        <label
          v-if="hasPods"
          class="flex cursor-pointer items-center gap-2 text-xs transition-colors duration-fast hover:text-foreground"
          :class="byPod ? 'text-foreground' : 'text-muted-foreground'"
        >
          <Switch v-model:checked="byPod" aria-label="Per pod" />
          Per pod
        </label>
      </div>

      <!-- Loading -->
      <div v-if="status === 'loading' && !data" class="space-y-4" aria-label="Loading usage" aria-busy="true">
        <div v-for="i in skeletons" :key="i" class="space-y-2">
          <div class="flex justify-between">
            <Skeleton class="h-3 w-12" />
            <Skeleton class="h-3 w-20" />
          </div>
          <Skeleton class="h-[112px] w-full rounded-md" />
        </div>
      </div>

      <!-- Prometheus doesn't answer -->
      <div v-else-if="status === 'error' && error" class="rounded-lg bg-muted/50 px-3.5 py-3" role="alert">
        <p class="flex items-center gap-2 text-sm font-medium">
          <AlertCircle class="h-4 w-4 shrink-0 text-destructive" />
          Can't reach Prometheus
        </p>
        <p class="mt-1 pl-6 text-xs text-muted-foreground" :title="error.detail">{{ error.summary }}</p>
        <pre
          v-if="showDetail"
          class="mt-2 ml-6 max-h-32 overflow-auto whitespace-pre-wrap break-words rounded-md bg-background/60 px-2.5 py-2 font-mono text-2xs leading-4 text-muted-foreground select-text"
          >{{ error.detail }}</pre
        >
        <div class="mt-3 flex items-center gap-1.5 pl-6">
          <Button variant="outline" size="xs" @click="reload">Try again</Button>
          <Button v-if="error.detail !== error.summary" variant="ghost" size="xs" class="text-muted-foreground" @click="showDetail = !showDetail">
            {{ showDetail ? "Hide details" : "Details" }}
          </Button>
        </div>
      </div>

      <!-- Nothing to show at all -->
      <p v-else-if="fallbackEmpty" class="rounded-lg bg-muted/50 px-3.5 py-3 text-xs text-muted-foreground">
        {{ fallbackMessage }}
      </p>

      <!-- Charts -->
      <template v-else-if="data">
        <div v-for="chart in charts" :key="chart.id" class="space-y-1.5">
          <div class="flex min-w-0 items-baseline justify-between gap-3">
            <h4 class="text-xs font-medium text-muted-foreground">{{ chart.title }}</h4>
            <div v-if="chart.series.length > 1" class="flex items-baseline gap-3 text-xs tabular-nums">
              <span v-for="series in chart.series" :key="series.id" class="flex items-center gap-1.5">
                <span
                  class="h-0.5 w-2.5 self-center rounded-full"
                  :style="{ background: TONE_COLORS[series.tone] }"
                />
                <span class="text-muted-foreground">{{ series.label }}</span>
                <span class="font-medium text-foreground">{{
                  valueAt(series.values, hover ?? series.values.length - 1) === null
                    ? "–"
                    : formatValue(chart.unit, valueAt(series.values, hover ?? series.values.length - 1)!)
                }}</span>
              </span>
            </div>
            <div v-else-if="headline(chart)" class="flex min-w-0 items-baseline gap-1.5 text-xs tabular-nums">
              <span class="font-medium text-foreground">{{ headline(chart)!.text }}</span>
              <span v-if="headline(chart)!.percent" class="truncate" :class="TONE_CLASS[headline(chart)!.tone]">
                {{ headline(chart)!.percent }}
              </span>
            </div>
          </div>
          <TimeSeriesChart
            v-model:hover="hover"
            :times="data.times"
            :series="chart.series"
            :pods="byPod && hasPods ? chart.pods : null"
            :references="chart.references"
            :markers="chart.markers"
            :unit="chart.unit"
            :label="`${chart.title} over ${isPrometheus ? rangeLabel : 'the last 15 minutes'}`"
            :busy="refreshing"
            :empty-text="isPrometheus ? 'No data in this range' : 'Waiting for samples…'"
          />
        </div>
      </template>

      <!-- Where the data comes from -->
      <div v-if="source" class="flex items-center justify-between gap-3 text-2xs text-muted-foreground">
        <span class="min-w-0 truncate" :title="sourceLine">{{ sourceLine }}</span>
        <button
          type="button"
          class="shrink-0 rounded transition-colors duration-fast hover:text-foreground focus-ring"
          @click="dialogOpen = true"
        >
          Change
        </button>
      </div>
    </div>
    <MetricsSourceDialog
      v-if="dialogUsed"
      v-model:open="dialogOpen"
      :context="target.context"
      :kube-config="target.kubeConfig"
    />
  </PanelSection>
</template>

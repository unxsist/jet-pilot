<script setup lang="ts">
/*
 * CPU / memory cell of the pods table: a tiny sparkline of the usage history
 * (row.metricsHistory, see ./metrics.ts) with request / limit markers, or a
 * single-sample meter when only the latest metric is known. The tooltip has
 * the exact values.
 */
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  formatCpu,
  formatMemory,
  podResources,
  podUsageSamples,
  sparklinePath,
  summarize,
  usageRatio,
  usageTone,
} from "./metrics";

const props = defineProps<{
  pod: object;
  resource: "cpu" | "memory";
}>();

const WIDTH = 44;
const HEIGHT = 18;

const samples = computed(() => podUsageSamples(props.pod as any));
const values = computed(() => samples.value.map((s) => s[props.resource]));
const bounds = computed(() => podResources(props.pod as any)[props.resource]);
const summary = computed(() => summarize(values.value));
const format = (value: number) =>
  props.resource === "cpu" ? formatCpu(value) : formatMemory(value);

const isHistory = computed(() => values.value.length >= 2);

/*
 * Scale: the samples with some headroom, at least up to the request. The
 * limit is drawn when it falls inside the scale (i.e. usage gets close).
 */
const scaleMax = computed(() => {
  const s = summary.value;
  if (!s) return 0;
  return Math.max(s.max * 1.15, bounds.value.request * 1.1, 1e-9);
});

const yOf = (value: number) =>
  1 +
  (HEIGHT - 2) -
  (Math.min(value, scaleMax.value) / scaleMax.value) * (HEIGHT - 2);

const linePath = computed(() =>
  sparklinePath(values.value, WIDTH, HEIGHT, scaleMax.value)
);
const areaPath = computed(() =>
  linePath.value ? `${linePath.value} L${WIDTH} ${HEIGHT} L0 ${HEIGHT} Z` : ""
);

const requestY = computed(() =>
  bounds.value.request > 0 && bounds.value.request <= scaleMax.value
    ? yOf(bounds.value.request)
    : null
);
const limitY = computed(() =>
  bounds.value.limit > 0 && bounds.value.limit <= scaleMax.value
    ? yOf(bounds.value.limit)
    : null
);

const tone = computed(() =>
  summary.value ? usageTone(summary.value.latest, bounds.value) : "normal"
);

const toneClass = computed(
  () =>
    ({
      normal: "text-foreground/55",
      warning: "text-warning",
      destructive: "text-destructive",
    })[tone.value]
);

/* Single-sample meter: share of the limit (or the request). */
const meter = computed(() => {
  const s = summary.value;
  if (!s) return null;
  const ratio = usageRatio(s.latest, bounds.value);
  const requestRatio =
    bounds.value.limit > 0 && bounds.value.request > 0
      ? bounds.value.request / bounds.value.limit
      : null;
  return {
    width: ratio === null ? 0 : Math.min(ratio, 1) * 100,
    request: requestRatio === null ? null : Math.min(requestRatio, 1) * 100,
  };
});

const percentOfLimit = computed(() => {
  const s = summary.value;
  return s && bounds.value.limit > 0
    ? `${Math.round((s.latest / bounds.value.limit) * 100)}%`
    : null;
});

const span = computed(() => {
  const first = samples.value[0]?.ts;
  const last = samples.value[samples.value.length - 1]?.ts;
  if (!first || !last || last <= first) return null;
  const minutes = Math.round((last - first) / 60000);
  return minutes >= 60
    ? `${Math.floor(minutes / 60)}h${minutes % 60 ? `${minutes % 60}m` : ""}`
    : `${minutes || "<1"}m`;
});

const label = computed(() => (props.resource === "cpu" ? "CPU" : "Memory"));
</script>

<template>
  <span
    v-if="!summary"
    class="text-muted-foreground"
    :aria-label="`${label}: no metrics`"
    >-</span
  >
  <TooltipProvider v-else :disable-hoverable-content="true">
    <Tooltip :delay-duration="250">
      <TooltipTrigger as-child>
        <span
          class="inline-flex items-center justify-end gap-2"
          :aria-label="`${label} ${format(summary.latest)}`"
        >
          <svg
            v-if="isHistory"
            :width="WIDTH"
            :height="HEIGHT"
            :viewBox="`0 0 ${WIDTH} ${HEIGHT}`"
            class="shrink-0 overflow-visible"
            :class="toneClass"
            aria-hidden="true"
          >
            <path :d="areaPath" fill="currentColor" opacity="0.1" />
            <line
              v-if="requestY !== null"
              x1="0"
              :x2="WIDTH"
              :y1="requestY"
              :y2="requestY"
              class="text-muted-foreground"
              stroke="currentColor"
              stroke-width="1"
              stroke-dasharray="1.5 2"
              opacity="0.7"
            />
            <line
              v-if="limitY !== null"
              x1="0"
              :x2="WIDTH"
              :y1="limitY"
              :y2="limitY"
              class="text-destructive"
              stroke="currentColor"
              stroke-width="1"
              stroke-dasharray="3 2"
              opacity="0.8"
            />
            <path
              :d="linePath"
              fill="none"
              stroke="currentColor"
              stroke-width="1.5"
              stroke-linejoin="round"
              stroke-linecap="round"
            />
            <circle
              :cx="WIDTH"
              :cy="yOf(summary.latest)"
              r="1.75"
              fill="currentColor"
            />
          </svg>
          <span
            v-else-if="meter"
            class="relative h-[5px] w-[44px] shrink-0 overflow-hidden rounded-full bg-muted"
            aria-hidden="true"
          >
            <span
              class="absolute inset-y-0 left-0 rounded-full"
              :class="
                tone === 'destructive'
                  ? 'bg-destructive'
                  : tone === 'warning'
                    ? 'bg-warning'
                    : 'bg-foreground/40'
              "
              :style="{ width: `${meter.width}%` }"
            />
            <span
              v-if="meter.request !== null"
              class="absolute inset-y-0 w-px bg-foreground/60"
              :style="{ left: `${meter.request}%` }"
            />
          </span>
          <span class="w-11 text-right tabular-nums text-foreground">{{
            format(summary.latest)
          }}</span>
        </span>
      </TooltipTrigger>
      <TooltipContent side="left" class="px-2.5 py-2">
        <div class="mb-1 flex items-baseline justify-between gap-4">
          <span class="font-semibold">{{ label }}</span>
          <span v-if="span" class="opacity-70">last {{ span }}</span>
        </div>
        <dl
          class="grid grid-cols-[auto_auto] gap-x-4 gap-y-0.5 tabular-nums [&_dd]:text-right [&_dt]:opacity-70"
        >
          <dt>Current</dt>
          <dd>
            {{ format(summary.latest)
            }}<template v-if="percentOfLimit">
              · {{ percentOfLimit }} of limit</template
            >
          </dd>
          <template v-if="isHistory">
            <dt>Average</dt>
            <dd>{{ format(summary.avg) }}</dd>
            <dt>Min / max</dt>
            <dd>{{ format(summary.min) }} / {{ format(summary.max) }}</dd>
          </template>
          <dt>Request</dt>
          <dd>{{ bounds.request > 0 ? format(bounds.request) : "none" }}</dd>
          <dt>Limit</dt>
          <dd>{{ bounds.limit > 0 ? format(bounds.limit) : "none" }}</dd>
        </dl>
        <div v-if="isHistory" class="mt-1.5 opacity-60">
          {{ values.length }} samples · dotted: request · dashed: limit
        </div>
      </TooltipContent>
    </Tooltip>
  </TooltipProvider>
</template>

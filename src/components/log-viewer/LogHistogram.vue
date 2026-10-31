<script setup lang="ts">
/*
 * Log volume over time: a slim bar chart of lines per time bucket above the
 * log lines, tinted by level when the lines have one (errors and warnings
 * in their status tones, everything else muted). Dragging across it, or
 * clicking a bar, selects a time range (v-model `range`), which the viewer
 * applies on top of its facets and search. Buckets adapt to the width and
 * the span, and follow the stream.
 */
import { useElementSize } from "@vueuse/core";
import {
  formatTimeRange,
  snapRange,
  type LogTimeline,
  type TimeBucket,
} from "@/lib/logTimeline";

const props = defineProps<{
  timeline: LogTimeline;
  /** Bumped whenever the timeline changed (it isn't reactive itself). */
  version: number;
}>();

/** The selected time range [start, end) in ms, or null for all lines. */
const range = defineModel<[number, number] | null>("range", { default: null });

const HEIGHT = 28;
/* About one bar per 6 px. */
const PX_PER_BUCKET = 6;

const chart = ref<HTMLElement | null>(null);
const { width } = useElementSize(chart);

/* Something to draw: lines over a time span (measured once shown). */
const drawable = computed(() => {
  void props.version;
  return props.timeline.span() !== null;
});

const data = computed(() => {
  void props.version;
  if (width.value <= 0) return null;
  const max = Math.max(12, Math.min(160, Math.floor(width.value / PX_PER_BUCKET)));
  return props.timeline.buckets(max);
});

const levels = computed(() => {
  void props.version;
  return props.timeline.hasLevels;
});

const slot = computed(() => (data.value ? width.value / data.value.buckets.length : 0));
const gap = computed(() => (slot.value >= 4 ? 1 : 0));

const domain = computed(() => {
  const buckets = data.value?.buckets;
  if (!buckets?.length) return null;
  return { start: buckets[0].start, end: buckets[buckets.length - 1].end };
});

const xOf = (time: number) => {
  const d = domain.value;
  if (!d) return 0;
  return ((time - d.start) / (d.end - d.start)) * width.value;
};

/* Errors at the base, then warnings, then the rest: errors compare across bars. */
const bars = computed(() => {
  const d = data.value;
  if (!d || d.max === 0) return [];
  const scale = HEIGHT / d.max;
  return d.buckets.map((bucket, index) => {
    const x = index * slot.value;
    // Quiet buckets stay visible next to a spike.
    const total = bucket.total > 0 ? Math.max(2, bucket.total * scale) : 0;
    const error = levels.value ? (bucket.error / Math.max(1, bucket.total)) * total : 0;
    const warn = levels.value ? (bucket.warn / Math.max(1, bucket.total)) * total : 0;
    return {
      index,
      bucket,
      x,
      width: Math.max(1, slot.value - gap.value),
      error,
      warn,
      other: total - error - warn,
    };
  });
});

const inRange = (bucket: TimeBucket, r: [number, number] | null) =>
  !r || (bucket.end > r[0] && bucket.start < r[1]);

/* -------------------------------------------------------- brushing -- */

const localX = (event: PointerEvent) => {
  const rect = chart.value?.getBoundingClientRect();
  return rect ? Math.min(rect.width, Math.max(0, event.clientX - rect.left)) : 0;
};

const hoverX = ref<number | null>(null);
const drag = ref<{ from: number; to: number } | null>(null);

/* While dragging: the snapped range under the pointer. */
const shown = computed<[number, number] | null>(() => {
  if (drag.value && data.value) {
    return snapRange(data.value.buckets, width.value, drag.value.from, drag.value.to);
  }
  return range.value;
});

const onPointerDown = (event: PointerEvent) => {
  if (event.button !== 0 || !data.value) return;
  chart.value?.setPointerCapture(event.pointerId);
  const x = localX(event);
  drag.value = { from: x, to: x };
};

const onPointerMove = (event: PointerEvent) => {
  const x = localX(event);
  hoverX.value = x;
  if (drag.value) drag.value = { ...drag.value, to: x };
};

const onPointerUp = () => {
  const current = drag.value;
  drag.value = null;
  if (!current || !data.value) return;
  const next = snapRange(data.value.buckets, width.value, current.from, current.to);
  // Clicking the one selected bar again lets go of it.
  const same = next && range.value && next[0] === range.value[0] && next[1] === range.value[1];
  range.value = same && Math.abs(current.to - current.from) < 3 ? null : next;
};

const onPointerLeave = () => {
  if (!drag.value) hoverX.value = null;
};

/* ----------------------------------------------------------- hover -- */

const hovered = computed(() => {
  const d = data.value;
  if (hoverX.value === null || drag.value || !d || slot.value <= 0) return null;
  const index = Math.min(d.buckets.length - 1, Math.floor(hoverX.value / slot.value));
  return { index, bucket: d.buckets[index] };
});

const plural = (count: number, word: string) =>
  `${count.toLocaleString()} ${word}${count === 1 ? "" : "s"}`;

const tooltip = computed(() => {
  const hover = hovered.value;
  if (!hover || !data.value) return null;
  const { bucket } = hover;
  const left = Math.min(
    Math.max(0, hover.index * slot.value + slot.value / 2 - 80),
    Math.max(0, width.value - 160)
  );
  return {
    left,
    time: formatTimeRange(bucket.start, bucket.end, data.value.step),
    lines: plural(bucket.total, "line"),
    error: levels.value && bucket.error ? plural(bucket.error, "error") : "",
    warn: levels.value && bucket.warn ? plural(bucket.warn, "warning") : "",
  };
});

const rangeLabel = computed(() =>
  data.value && range.value ? formatTimeRange(range.value[0], range.value[1], data.value.step) : ""
);
</script>

<template>
  <div
    v-if="drawable"
    class="relative flex h-11 shrink-0 items-center gap-3 border-b border-border-subtle bg-background px-3"
  >
    <div
      ref="chart"
      class="relative min-w-0 flex-1 select-none"
      :style="{ height: `${HEIGHT}px`, cursor: 'crosshair', touchAction: 'none' }"
      role="img"
      :aria-label="
        data && domain
          ? `Log volume from ${formatTimeRange(domain.start, domain.end, data.step)}. Drag to show a time range.`
          : 'Log volume'
      "
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="onPointerUp"
      @pointercancel="drag = null"
      @pointerleave="onPointerLeave"
    >
      <svg
        v-if="data"
        :width="width"
        :height="HEIGHT"
        class="block overflow-visible"
        aria-hidden="true"
      >
        <!-- The selected (or brushed) range -->
        <rect
          v-if="shown"
          :x="xOf(shown[0])"
          :y="0"
          :width="Math.max(1, xOf(shown[1]) - xOf(shown[0]))"
          :height="HEIGHT"
          rx="3"
          fill="hsl(var(--primary))"
          fill-opacity="0.1"
        />
        <rect
          v-if="hovered"
          :x="hovered.index * slot"
          :y="0"
          :width="slot"
          :height="HEIGHT"
          rx="2"
          fill="hsl(var(--foreground))"
          fill-opacity="0.06"
        />
        <g
          v-for="bar in bars"
          :key="bar.bucket.start"
          :opacity="inRange(bar.bucket, shown) ? 1 : 0.35"
        >
          <rect
            v-if="bar.other > 0"
            :x="bar.x"
            :y="HEIGHT - bar.error - bar.warn - bar.other"
            :width="bar.width"
            :height="bar.other"
            rx="1"
            fill="hsl(var(--muted-foreground))"
            fill-opacity="0.45"
          />
          <rect
            v-if="bar.warn > 0"
            :x="bar.x"
            :y="HEIGHT - bar.error - bar.warn"
            :width="bar.width"
            :height="bar.warn"
            fill="hsl(var(--warning))"
          />
          <rect
            v-if="bar.error > 0"
            :x="bar.x"
            :y="HEIGHT - bar.error"
            :width="bar.width"
            :height="bar.error"
            fill="hsl(var(--destructive))"
          />
        </g>
      </svg>

      <div
        v-if="tooltip"
        class="pointer-events-none absolute top-full z-10 mt-2 min-w-28 max-w-xs rounded-md border border-border-strong/60 bg-popover/95 px-2.5 py-1.5 text-xs shadow-md backdrop-blur-sm"
        :style="{ left: `${tooltip.left}px` }"
        aria-live="polite"
      >
        <div class="mb-0.5 whitespace-nowrap text-2xs tabular-nums text-muted-foreground">
          {{ tooltip.time }}
        </div>
        <div class="whitespace-nowrap font-medium tabular-nums text-foreground">{{ tooltip.lines }}</div>
        <div
          v-if="tooltip.error || tooltip.warn"
          class="flex items-center gap-3 whitespace-nowrap text-2xs tabular-nums"
        >
          <span v-if="tooltip.error" class="text-destructive">{{ tooltip.error }}</span>
          <span v-if="tooltip.warn" class="text-warning">{{ tooltip.warn }}</span>
        </div>
      </div>
    </div>

    <div
      v-if="data && domain"
      class="flex shrink-0 items-center gap-2 text-2xs tabular-nums text-muted-foreground"
    >
      <template v-if="range">
        <span class="text-foreground">{{ rangeLabel }}</span>
        <button
          type="button"
          class="rounded-sm font-medium text-link hover:underline focus-ring"
          title="Show all lines (Esc)"
          @click="range = null"
        >
          Clear
        </button>
      </template>
      <span v-else>{{ formatTimeRange(domain.start, domain.end, data.step) }}</span>
    </div>
  </div>
</template>

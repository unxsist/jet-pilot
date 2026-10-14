<script setup lang="ts">
/*
 * A small, dependency-free SVG time-series chart: smooth monotone lines with
 * a soft gradient from the theme's tokens, hairline gridlines, three or four
 * labels per axis, faint reference lines (requests, limits) and event
 * markers (restarts). Hover or the arrow keys move a crosshair; the hovered
 * slot is a v-model, so charts stacked together can share it.
 *
 * Per-pod mode (`pods`) draws one thin line per pod instead of the total and
 * highlights the one nearest to the pointer.
 */
import { useElementSize } from "@vueuse/core";
import { areaPath, linePath, segments, stepPath, type Point } from "./path";
import { TONE_COLORS, type ChartMarker, type ChartReference, type ChartSeries, type Values } from "./types";
import { formatTick, formatValue, niceScale, type Unit } from "@/lib/metrics/units";
import { pointLabel, tickLabel, timeTicks } from "@/lib/metrics/time";
import { summarizeValues, valueAt } from "@/lib/metrics/series";

const props = withDefaults(
  defineProps<{
    /** Slot times (ms), evenly spaced. */
    times: number[];
    series: ChartSeries[];
    /** One line per pod, drawn instead of `series`. */
    pods?: ChartSeries[] | null;
    references?: ChartReference[];
    markers?: ChartMarker[];
    unit: Unit;
    /** What the chart shows, for screen readers ("CPU over the last hour"). */
    label: string;
    height?: number;
    /** Reloading: the last frame stays, dimmed. */
    busy?: boolean;
    emptyText?: string;
  }>(),
  {
    pods: null,
    references: () => [],
    markers: () => [],
    height: 144,
    busy: false,
    emptyText: "No data in this range",
  }
);

/** The hovered slot (shared between charts). */
const hover = defineModel<number | null>("hover", { default: null });

const uid = useId();
const root = ref<HTMLElement | null>(null);
const { width } = useElementSize(root);

/* Plot area: y labels and reference tags in a right gutter, time labels underneath. */
const TOP = 8;
const BOTTOM = 20;
/* Tag text is 10px Inter: about 5.6px per character, plus padding. */
const tagWidth = (label: string) => Math.ceil(label.length * 5.6) + 8;
const TAG_HEIGHT = 13;

const count = computed(() => props.times.length);
const plotHeight = computed(() => props.height - TOP - BOTTOM);
const baseline = computed(() => TOP + plotHeight.value);

const podMode = computed(() => !!props.pods?.length);
const visible = computed(() => (podMode.value ? props.pods! : props.series));

const maxOf = (values: Values) => values.reduce<number>((max, v) => (v !== null && v > max ? v : max), 0);
const dataMax = computed(() => visible.value.reduce((max, s) => Math.max(max, maxOf(s.values)), 0));
const hasData = computed(() => visible.value.some((s) => s.values.some((v) => v !== null)));

const referenceMax = (ref: ChartReference) => (typeof ref.values === "number" ? ref.values : maxOf(ref.values));

/* The axis fits the data with some headroom. */
const dataScale = computed(() => niceScale(dataMax.value * 1.1, props.unit, plotHeight.value < 64 ? 2 : 3));

/*
 * References inside the data's axis, or just above it, are drawn (the axis
 * grows a little for them). One well above (a limit 5× the usage) would
 * squash the line into the floor: it is left out, the header says the
 * percentage. Per-pod lines are per pod, the references totals: none then.
 */
const drawnReferences = computed(() =>
  podMode.value || !hasData.value
    ? []
    : props.references.filter((ref) => {
        const max = referenceMax(ref);
        return max > 0 && (max <= dataScale.value.max || max <= dataMax.value * 1.3);
      })
);

const scale = computed(() => {
  const top = Math.max(...drawnReferences.value.map(referenceMax));
  return top > dataScale.value.max ? niceScale(top, props.unit, plotHeight.value < 64 ? 2 : 3) : dataScale.value;
});

const gutter = computed(() => Math.max(46, ...drawnReferences.value.map((ref) => tagWidth(ref.label) + 6)));
const plotWidth = computed(() => Math.max(0, Math.floor(width.value) - gutter.value));

const x = (index: number) => (count.value > 1 ? (index / (count.value - 1)) * plotWidth.value : plotWidth.value / 2);

const y = (value: number) => TOP + plotHeight.value - (Math.min(Math.max(value, 0), scale.value.max) / scale.value.max) * plotHeight.value;

const runsOf = (values: Values) => segments(values, x, y);

interface DrawnSeries {
  series: ChartSeries;
  color: string;
  line: string;
  area: string;
  runs: Point[][];
}

const drawn = computed<DrawnSeries[]>(() =>
  visible.value.map((series) => {
    const runs = runsOf(series.values);
    return {
      series,
      color: TONE_COLORS[series.tone],
      runs,
      line: linePath(runs),
      area: series.fill && !podMode.value ? areaPath(runs, baseline.value) : "",
    };
  })
);

const referenceAt = (ref: ChartReference, index: number) =>
  typeof ref.values === "number" ? ref.values : valueAt(ref.values, index);

const referenceLines = computed(() => {
  const list = drawnReferences.value.map((ref) => {
    const path =
      typeof ref.values === "number"
        ? `M0,${y(ref.values)}H${plotWidth.value}`
        : stepPath(runsOf(ref.values));
    // The tag sits at the line's right end, in the gutter.
    const last = typeof ref.values === "number" ? ref.values : [...ref.values].reverse().find((v) => v !== null) ?? 0;
    return { ref, path, tagY: Math.min(baseline.value - 6, Math.max(TOP + 6, y(last))) };
  });
  // Tags too close to each other are nudged apart (the lower one moves down).
  const sorted = [...list].sort((a, b) => a.tagY - b.tagY);
  for (let i = 1; i < sorted.length; i++) {
    sorted[i]!.tagY = Math.max(sorted[i]!.tagY, sorted[i - 1]!.tagY + TAG_HEIGHT + 1);
  }
  // Pushed past the floor: move the stack up instead.
  const overflow = (sorted[sorted.length - 1]?.tagY ?? 0) - (baseline.value - 6);
  if (overflow > 0) for (const item of sorted) item.tagY -= overflow;
  return list;
});

/* Axis labels make way for the reference tags next to them. */
const gridlines = computed(() =>
  scale.value.ticks.map((tick) => {
    const lineY = Math.round(y(tick)) + 0.5;
    return { value: tick, y: lineY, label: !referenceLines.value.some((r) => Math.abs(r.tagY - lineY) < TAG_HEIGHT + 3) };
  })
);

const span = computed(() => (count.value > 1 ? props.times[count.value - 1]! - props.times[0]! : 0));

const xTicks = computed(() => {
  if (count.value < 2 || plotWidth.value <= 0) return [];
  const from = props.times[0]!;
  const to = props.times[count.value - 1]!;
  return timeTicks(from, to, plotWidth.value < 280 ? 3 : 4).map((t) => {
    const px = ((t - from) / (to - from)) * plotWidth.value;
    const anchor = px < 18 ? "start" : px > plotWidth.value - 18 ? "end" : "middle";
    return { t, x: px, anchor, label: tickLabel(t, span.value) };
  });
});

const markers = computed(() =>
  props.markers.filter((m) => m.index >= 0 && m.index < count.value).map((m) => ({ ...m, x: x(m.index) }))
);

/* ------------------------------------------------------------- hover -- */

const pointerY = ref<number | null>(null);
/* This chart has the pointer or the focus: it shows the tooltip (the others only the crosshair). */
const owner = ref(false);

const indexAt = (px: number) =>
  count.value > 1 ? Math.min(count.value - 1, Math.max(0, Math.round((px / plotWidth.value) * (count.value - 1)))) : 0;

const onPointerMove = (event: PointerEvent) => {
  const rect = (event.currentTarget as SVGElement).getBoundingClientRect();
  const px = event.clientX - rect.left;
  if (px > plotWidth.value + 4 || !hasData.value) {
    hover.value = null;
    return;
  }
  owner.value = true;
  pointerY.value = event.clientY - rect.top;
  hover.value = indexAt(px);
};

const onPointerLeave = () => {
  owner.value = false;
  hover.value = null;
  pointerY.value = null;
};

const onBlur = () => {
  owner.value = false;
  hover.value = null;
};

const onKeydown = (event: KeyboardEvent) => {
  if (!hasData.value || !count.value) return;
  const current = hover.value ?? count.value - 1;
  const moves: Record<string, number> = {
    ArrowLeft: Math.max(0, current - 1),
    ArrowRight: Math.min(count.value - 1, current + 1),
    Home: 0,
    End: count.value - 1,
  };
  if (event.key in moves) {
    event.preventDefault();
    pointerY.value = null;
    hover.value = moves[event.key]!;
  } else if (event.key === "Escape") {
    hover.value = null;
  }
};

const onFocus = () => {
  owner.value = true;
  if (hasData.value && hover.value === null) hover.value = count.value - 1;
};

const activeIndex = computed(() => (hover.value !== null && hover.value < count.value && hasData.value ? hover.value : null));

/* Per-pod mode: the line nearest to the pointer stands out. */
const highlighted = computed(() => {
  const index = activeIndex.value;
  if (!podMode.value || index === null) return null;
  let best: string | null = null;
  let distance = Infinity;
  for (const pod of props.pods!) {
    const value = pod.values[index];
    if (value === null || value === undefined) continue;
    const d = pointerY.value === null ? -value : Math.abs(y(value) - pointerY.value);
    if (d < distance) {
      distance = d;
      best = pod.id;
    }
  }
  return best;
});

const dots = computed(() => {
  const index = activeIndex.value;
  if (index === null) return [];
  return drawn.value
    .filter((d) => !podMode.value || d.series.id === highlighted.value)
    .map((d) => {
      const value = d.series.values[index];
      return value === null || value === undefined ? null : { id: d.series.id, x: x(index), y: y(value), color: d.color };
    })
    .filter(<T,>(d: T | null): d is T => d !== null);
});

/** Pod names without the part they all share (the workload's name). */
const shortPodNames = computed(() => {
  const names = (props.pods ?? []).map((p) => p.label);
  if (names.length < 2) return new Map(names.map((n) => [n, n]));
  let prefix = names[0]!;
  for (const name of names) while (!name.startsWith(prefix)) prefix = prefix.slice(0, -1);
  const cut = prefix.lastIndexOf("-") + 1;
  return new Map(names.map((n) => [n, cut > 0 ? n.slice(cut) : n]));
});

const TOOLTIP_PODS = 5;

const tooltip = computed(() => {
  const index = activeIndex.value;
  if (index === null || !owner.value) return null;
  const time = pointLabel(props.times[index]!, span.value);
  const nearbyMarkers = markers.value.filter((m) => Math.abs(m.index - index) <= 1);
  if (podMode.value) {
    const rows = props
      .pods!.map((pod) => ({ id: pod.id, label: shortPodNames.value.get(pod.label) ?? pod.label, value: pod.values[index], color: TONE_COLORS[pod.tone] }))
      .filter((r): r is typeof r & { value: number } => r.value !== null && r.value !== undefined)
      .sort((a, b) => b.value - a.value);
    return {
      time,
      rows: rows.slice(0, TOOLTIP_PODS).map((r) => ({ ...r, text: formatValue(props.unit, r.value) })),
      more: Math.max(0, rows.length - TOOLTIP_PODS),
      notes: [] as string[],
      markers: nearbyMarkers,
    };
  }
  const rows = props.series
    .map((s) => ({ id: s.id, label: props.series.length > 1 ? s.label : "", value: s.values[index], color: TONE_COLORS[s.tone] }))
    .filter((r): r is typeof r & { value: number } => r.value !== null && r.value !== undefined)
    .map((r) => ({ ...r, text: formatValue(props.unit, r.value) }));
  const main = rows[0]?.value;
  const notes = props.references
    .map((ref) => {
      const value = referenceAt(ref, index);
      if (!value) return null;
      const percent = main !== undefined && props.series.length === 1 ? ` · ${Math.round((main / value) * 100)}%` : "";
      return `${ref.label} ${formatValue(props.unit, value)}${percent}`;
    })
    .filter((n): n is string => !!n);
  return { time, rows, more: 0, notes, markers: nearbyMarkers };
});

/* The tooltip sits beside the crosshair, on the side with room. */
const tooltipStyle = computed(() => {
  const index = activeIndex.value;
  if (index === null) return {};
  const px = x(index);
  const right = px < plotWidth.value * 0.55;
  return right ? { left: `${px + 12}px` } : { left: `${px - 12}px`, transform: "translateX(-100%)" };
});

/* ------------------------------------------------------ accessibility -- */

const summary = computed(() => {
  const main = props.series[0];
  const stats = main ? summarizeValues(main.values) : null;
  if (!stats || stats.latest === null) return `${props.label}: no data`;
  const f = (v: number) => formatValue(props.unit, v);
  return `${props.label}: now ${f(stats.latest)}, average ${f(stats.avg)}, peak ${f(stats.max)}`;
});
</script>

<template>
  <div ref="root" class="relative select-none" :style="{ height: `${height}px` }">
    <svg
      v-if="plotWidth > 0"
      :width="plotWidth + gutter"
      :height="height"
      :viewBox="`0 0 ${plotWidth + gutter} ${height}`"
      class="block overflow-visible outline-none transition-opacity duration-fast ease-out focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-offset-4 focus-visible:ring-offset-card motion-reduce:transition-none rounded-sm"
      :class="busy ? 'opacity-50' : 'opacity-100'"
      role="img"
      tabindex="0"
      :aria-label="summary"
      @pointermove="onPointerMove"
      @pointerleave="onPointerLeave"
      @keydown="onKeydown"
      @focus="onFocus"
      @blur="onBlur"
    >
      <defs>
        <linearGradient
          v-for="d in drawn.filter((d) => d.area)"
          :id="`${uid}-${d.series.id}`"
          :key="d.series.id"
          x1="0"
          y1="0"
          x2="0"
          y2="1"
        >
          <stop offset="0%" :style="{ stopColor: d.color, stopOpacity: 0.24 }" />
          <stop offset="70%" :style="{ stopColor: d.color, stopOpacity: 0.06 }" />
          <stop offset="100%" :style="{ stopColor: d.color, stopOpacity: 0 }" />
        </linearGradient>
      </defs>

      <!-- Gridlines and y labels (right gutter) -->
      <g>
        <line
          v-for="line in gridlines"
          :key="line.value"
          x1="0"
          :x2="plotWidth"
          :y1="line.y"
          :y2="line.y"
          :stroke="line.value === 0 ? 'hsl(var(--border))' : 'hsl(var(--border-subtle))'"
          stroke-width="1"
          shape-rendering="crispEdges"
        />
        <text
          v-for="line in gridlines.filter((l) => l.label)"
          :key="`label-${line.value}`"
          :x="plotWidth + 8"
          :y="line.y"
          dominant-baseline="middle"
          class="fill-muted-foreground text-2xs tabular-nums"
        >
          {{ formatTick(unit, line.value) }}
        </text>
      </g>

      <!-- Time labels -->
      <text
        v-for="tick in xTicks"
        :key="tick.t"
        :x="tick.x"
        :y="height - 4"
        :text-anchor="tick.anchor"
        class="fill-muted-foreground text-2xs tabular-nums"
      >
        {{ tick.label }}
      </text>

      <template v-if="hasData">
        <!-- Reference lines: requests, limits -->
        <path
          v-for="item in referenceLines"
          :key="item.ref.id"
          :d="item.path"
          fill="none"
          stroke="hsl(var(--muted-foreground))"
          :stroke-opacity="item.ref.id === 'request' ? 0.45 : 0.6"
          stroke-width="1"
          :stroke-dasharray="item.ref.id === 'request' ? '1 3' : '4 3'"
          stroke-linecap="round"
        />

        <!-- Areas, then lines -->
        <path
          v-for="d in drawn.filter((d) => d.area)"
          :key="`area-${d.series.id}`"
          :d="d.area"
          :fill="`url(#${uid}-${d.series.id})`"
        />
        <path
          v-for="d in drawn"
          :key="`line-${d.series.id}`"
          :d="d.line"
          fill="none"
          :stroke="d.color"
          :stroke-width="podMode ? (d.series.id === highlighted ? 2 : 1.25) : 1.75"
          :stroke-opacity="podMode ? (highlighted === null ? 0.7 : d.series.id === highlighted ? 1 : 0.25) : 1"
          :stroke-dasharray="d.series.tone === 'neutral' ? '3 2.5' : undefined"
          stroke-linejoin="round"
          stroke-linecap="round"
          class="transition-all duration-fast motion-reduce:transition-none"
        />

        <!-- Reference tags, in the gutter at their line -->
        <g v-for="item in referenceLines" :key="`tag-${item.ref.id}`">
          <rect
            :x="plotWidth + 4"
            :y="item.tagY - TAG_HEIGHT / 2"
            :width="tagWidth(item.ref.label)"
            :height="TAG_HEIGHT"
            rx="3"
            fill="hsl(var(--muted))"
          />
          <text
            :x="plotWidth + 8"
            :y="item.tagY"
            dominant-baseline="central"
            class="fill-muted-foreground text-2xs"
          >
            {{ item.ref.label }}
          </text>
        </g>

        <!-- Restarts: a dot on the axis; its line only while hovered -->
        <g v-for="marker in markers" :key="`marker-${marker.index}`">
          <line
            v-if="activeIndex !== null && Math.abs(marker.index - activeIndex) <= 1"
            :x1="marker.x"
            :x2="marker.x"
            :y1="TOP"
            :y2="baseline"
            stroke="hsl(var(--destructive))"
            stroke-opacity="0.35"
            stroke-width="1"
            stroke-dasharray="2 3"
          />
          <circle :cx="marker.x" :cy="baseline" r="3" fill="hsl(var(--destructive))" stroke="hsl(var(--card))" stroke-width="2" />
        </g>

        <!-- Crosshair -->
        <g v-if="activeIndex !== null">
          <line
            :x1="Math.round(x(activeIndex)) + 0.5"
            :x2="Math.round(x(activeIndex)) + 0.5"
            :y1="TOP"
            :y2="baseline"
            stroke="hsl(var(--foreground))"
            stroke-opacity="0.22"
            stroke-width="1"
            shape-rendering="crispEdges"
          />
          <circle
            v-for="dot in dots"
            :key="dot.id"
            :cx="dot.x"
            :cy="dot.y"
            r="4"
            :fill="dot.color"
            stroke="hsl(var(--card))"
            stroke-width="2"
          />
        </g>
      </template>

      <text
        v-else
        :x="plotWidth / 2"
        :y="TOP + plotHeight / 2"
        text-anchor="middle"
        dominant-baseline="middle"
        class="fill-muted-foreground text-xs"
      >
        {{ emptyText }}
      </text>
    </svg>

    <div
      v-if="tooltip"
      class="pointer-events-none absolute top-0 z-10 min-w-28 max-w-xs rounded-md border border-border-strong/60 bg-popover/95 px-2.5 py-1.5 text-xs shadow-md backdrop-blur-sm"
      :style="tooltipStyle"
      aria-live="polite"
    >
      <div class="mb-0.5 whitespace-nowrap text-2xs tabular-nums text-muted-foreground">{{ tooltip.time }}</div>
      <div v-for="row in tooltip.rows" :key="row.id" class="flex items-center gap-2 whitespace-nowrap">
        <span class="h-0.5 w-2 shrink-0 rounded-full" :style="{ background: row.color }" />
        <span class="font-medium tabular-nums text-foreground">{{ row.text }}</span>
        <span v-if="row.label" class="min-w-0 truncate text-muted-foreground">{{ row.label }}</span>
      </div>
      <div v-if="tooltip.more" class="pl-4 text-2xs text-muted-foreground">{{ tooltip.more }} more</div>
      <div v-for="note in tooltip.notes" :key="note" class="whitespace-nowrap pl-4 text-2xs tabular-nums text-muted-foreground">
        {{ note }}
      </div>
      <div v-for="marker in tooltip.markers" :key="marker.index" class="mt-1 flex items-start gap-2 border-t border-border-subtle pt-1">
        <span class="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-destructive" />
        <span class="min-w-0">
          <span class="block font-medium text-destructive">{{ marker.label }}</span>
          <span v-if="marker.detail" class="block truncate text-2xs text-muted-foreground">{{ marker.detail }}</span>
        </span>
      </div>
    </div>
  </div>
</template>

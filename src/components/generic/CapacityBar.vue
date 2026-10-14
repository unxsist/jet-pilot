<script setup lang="ts">
/**
 * How much of something is used: a label, "3.2 of 7.9 cores" and a calm
 * bar. Turns amber from 85 %, red over 100 % (or from 100 % with
 * `strict`, e.g. a quota that is full). A faint tick marks `marker` (e.g.
 * limits next to requests).
 */
const props = defineProps<{
  label: string;
  used: number;
  total: number;
  /** "3.2 cores", "12 GiB": the formatted values. */
  usedText: string;
  totalText: string;
  /** Words after the numbers, e.g. "requested". */
  suffix?: string;
  strict?: boolean;
  /** A second value on the same scale, drawn as a tick. */
  marker?: number;
  markerLabel?: string;
}>();

const ratio = computed(() => (props.total > 0 ? props.used / props.total : 0));
const percent = computed(() => Math.round(ratio.value * 100));
const tone = computed(() =>
  ratio.value > 1 || (props.strict && ratio.value >= 1)
    ? "destructive"
    : ratio.value >= 0.85
      ? "warning"
      : "normal"
);
const fill = computed(() => ({
  normal: "bg-primary/70",
  warning: "bg-warning",
  destructive: "bg-destructive",
}[tone.value]));
const markerAt = computed(() =>
  props.marker !== undefined && props.total > 0 ? Math.min(100, (props.marker / props.total) * 100) : null
);
</script>

<template>
  <div>
    <div class="mb-1.5 flex items-baseline justify-between gap-3 text-xs">
      <span class="text-foreground">{{ label }}</span>
      <span class="truncate tabular-nums text-muted-foreground">
        <span :class="tone === 'normal' ? 'text-foreground' : tone === 'warning' ? 'text-warning' : 'text-destructive'">{{
          usedText
        }}</span>
        of {{ totalText }}<template v-if="suffix"> {{ suffix }}</template>
        <span class="ml-1.5 inline-block min-w-[2.5rem] text-right">{{ total > 0 ? `${percent}%` : "" }}</span>
      </span>
    </div>
    <div
      class="relative h-1.5 overflow-hidden rounded-full bg-muted"
      role="meter"
      :aria-label="label"
      :aria-valuenow="used"
      :aria-valuemin="0"
      :aria-valuemax="total"
      :aria-valuetext="`${usedText} of ${totalText}`"
    >
      <div
        class="h-full rounded-full transition-[width] duration-base ease-out"
        :class="fill"
        :style="{ width: `${Math.min(100, ratio * 100)}%` }"
      />
      <div
        v-if="markerAt !== null"
        class="absolute inset-y-0 w-px bg-foreground/50"
        :style="{ left: `${markerAt}%` }"
        :title="markerLabel"
      />
    </div>
  </div>
</template>

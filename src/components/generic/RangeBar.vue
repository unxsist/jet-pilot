<script setup lang="ts">
/**
 * Where a value sits in its allowed range, e.g. an autoscaler's replicas
 * between its minimum and maximum: the range as a track, the current value
 * as a marker, the ends labelled. At the top of the range it turns amber.
 */
const props = defineProps<{
  min: number;
  max: number;
  current: number;
  /** Where it is heading, when that differs (drawn as a ring). */
  desired?: number;
  unit?: string;
}>();

const at = (value: number) =>
  props.max > props.min ? Math.min(100, Math.max(0, ((value - props.min) / (props.max - props.min)) * 100)) : 100;
const atMax = computed(() => props.current >= props.max);
const moving = computed(() => props.desired !== undefined && props.desired !== props.current);
</script>

<template>
  <div class="px-1.5 pt-5">
    <div
      class="relative h-1.5 rounded-full bg-muted"
      role="meter"
      :aria-valuemin="min"
      :aria-valuemax="max"
      :aria-valuenow="current"
      :aria-valuetext="`${current} ${unit ?? ''}, between ${min} and ${max}`"
    >
      <div
        class="absolute inset-y-0 left-0 rounded-full transition-[width] duration-base ease-out"
        :class="atMax ? 'bg-warning' : 'bg-primary/70'"
        :style="{ width: `${at(current)}%` }"
      />
      <div
        v-if="moving"
        class="absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-dashed border-muted-foreground bg-card"
        :style="{ left: `${at(desired!)}%` }"
        :title="`Heading to ${desired}`"
      />
      <div
        class="absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 bg-card"
        :class="atMax ? 'border-warning' : 'border-primary'"
        :style="{ left: `${at(current)}%` }"
      />
      <span
        class="absolute -top-5 -translate-x-1/2 text-xs font-medium tabular-nums"
        :class="atMax ? 'text-warning' : 'text-foreground'"
        :style="{ left: `${Math.min(96, Math.max(4, at(current)))}%` }"
        >{{ current }}</span
      >
    </div>
    <div class="-mx-1.5 mt-1.5 flex justify-between text-xs tabular-nums text-muted-foreground">
      <span>{{ min }} min</span>
      <span>{{ max }} max</span>
    </div>
  </div>
</template>

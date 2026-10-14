<script setup lang="ts">
/**
 * Where a scaled workload is within its range: a track from 0 to the
 * maximum, the band between minimum and maximum, a marker at the current
 * replica count.
 */
const props = defineProps<{ min: number; max: number; current?: number }>();

const at = (value: number) => `${props.max > 0 ? Math.min(100, (value / props.max) * 100) : 0}%`;
</script>

<template>
  <div class="space-y-1.5" role="img" :aria-label="`${current ?? 'unknown'} replicas, between ${min} and ${max}`">
    <div class="relative h-1.5 rounded-full bg-muted">
      <div
        class="absolute inset-y-0 rounded-full bg-primary/25"
        :style="{ left: at(min), right: `calc(100% - ${at(max)})` }"
      />
      <div
        v-if="current !== undefined"
        class="absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-card bg-primary shadow-xs"
        :style="{ left: at(current) }"
      />
    </div>
    <div class="flex justify-between text-[11px] tabular-nums text-muted-foreground">
      <span>min {{ min }}</span>
      <span>max {{ max }}</span>
    </div>
  </div>
</template>

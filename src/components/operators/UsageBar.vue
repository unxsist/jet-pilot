<script setup lang="ts">
/** Usage against a limit: label, "48 of 1000 cores" and a slim bar. */
import { limitFillClass } from "@/lib/operators/karpenter";

defineProps<{ label: string; text: string; percent?: number }>();
</script>

<template>
  <div class="space-y-1.5 text-xs">
    <div class="flex items-baseline justify-between gap-3">
      <span class="text-muted-foreground">{{ label }}</span>
      <span class="tabular-nums">
        {{ text }}
        <span v-if="percent !== undefined" class="text-muted-foreground"> · {{ percent }}%</span>
      </span>
    </div>
    <div v-if="percent !== undefined" class="relative h-1.5 overflow-hidden rounded-full bg-muted">
      <div
        class="absolute inset-y-0 left-0 rounded-full transition-[width] duration-base ease-out"
        :class="limitFillClass(percent)"
        :style="{ width: `${Math.max(percent, 1)}%` }"
      />
    </div>
  </div>
</template>

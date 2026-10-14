<script setup lang="ts">
/**
 * A workload's replicas at a glance: a row of counts (amber when short)
 * and how many are ready.
 */
import { Progress } from "@/components/ui/progress";

const props = defineProps<{
  stats: { label: string; value: number; warn?: boolean }[];
  ready: number;
  desired: number;
}>();

const readyPercent = computed(() => (props.desired > 0 ? Math.round((props.ready / props.desired) * 100) : 0));
</script>

<template>
  <div class="space-y-3">
    <div class="grid overflow-hidden rounded-lg border" :style="{ gridTemplateColumns: `repeat(${stats.length}, minmax(0, 1fr))` }">
      <div
        v-for="(stat, index) in stats"
        :key="stat.label"
        class="bg-surface-1/60 px-3 py-2"
        :class="{ 'border-l': index > 0 }"
      >
        <div class="text-lg font-semibold tabular-nums" :class="stat.warn ? 'text-warning' : 'text-foreground'">
          {{ stat.value }}
        </div>
        <div class="truncate text-xs font-medium text-muted-foreground">{{ stat.label }}</div>
      </div>
    </div>
    <div class="flex items-center gap-3">
      <Progress :model-value="readyPercent" class="h-1.5 flex-1" />
      <span class="text-xs tabular-nums text-muted-foreground">{{ readyPercent }}% ready</span>
    </div>
  </div>
</template>

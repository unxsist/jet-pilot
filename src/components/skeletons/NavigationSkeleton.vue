<script setup lang="ts">
import { Skeleton } from "@/components/ui/skeleton";

/*
 * Placeholder for navigation groups while API discovery has nothing to show
 * yet (first start of a context without a discovery cache). Widths vary so
 * it reads as a list, not a grid.
 */
withDefaults(defineProps<{ groups?: number }>(), { groups: 3 });

const ITEM_WIDTHS = [
  ["62%", "48%", "70%", "54%"],
  ["58%", "66%", "44%"],
  ["50%", "72%", "60%", "46%", "64%"],
];
</script>
<template>
  <div aria-hidden="true" class="space-y-4 px-2 pt-1">
    <div v-for="g in groups" :key="g" class="space-y-2">
      <Skeleton class="ml-2 h-2.5 w-16 rounded-sm" />
      <div
        v-for="(width, i) in ITEM_WIDTHS[(g - 1) % ITEM_WIDTHS.length]"
        :key="i"
        class="flex h-5 items-center gap-2.5 px-2"
      >
        <Skeleton class="h-4 w-4 shrink-0 rounded" />
        <Skeleton class="h-3 rounded-sm" :style="{ width }" />
      </div>
    </div>
  </div>
</template>

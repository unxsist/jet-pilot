<script setup lang="ts">
import { BadgeCheck, ChevronRight, ShieldCheck } from "lucide-vue-next";
import ChartAvatar from "./ChartAvatar.vue";
import type { ChartEntry } from "@/lib/helm";

/*
 * One chart in the search results: its mark, name and latest version,
 * where it comes from (with Artifact Hub's official / verified mark) and
 * one line of description. The whole row opens the install flow.
 */
defineProps<{ chart: ChartEntry }>();
defineEmits<{ open: [] }>();
</script>

<template>
  <button
    type="button"
    :data-chart="chart.reference"
    class="group/row flex w-full items-center gap-3.5 rounded-xl px-3 py-2.5 text-left transition-colors duration-fast ease-out hover:bg-accent focus-ring"
    @click="$emit('open')"
  >
    <ChartAvatar :name="chart.name" :logo-image-id="chart.logoImageId" />
    <span class="min-w-0 flex-1">
      <span class="flex min-w-0 items-baseline gap-2">
        <span class="truncate text-sm font-medium">{{ chart.name }}</span>
        <span class="shrink-0 text-xs tabular-nums text-muted-foreground">{{ chart.version }}</span>
        <span v-if="chart.deprecated" class="shrink-0 text-xs text-warning">Deprecated</span>
      </span>
      <span class="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
        <span class="shrink-0">{{ chart.repoLabel }}</span>
        <span v-if="chart.official" class="inline-flex shrink-0" title="Official chart">
          <ShieldCheck class="h-3.5 w-3.5 text-link" aria-label="Official chart" />
        </span>
        <span v-else-if="chart.verified" class="inline-flex shrink-0" title="Verified publisher">
          <BadgeCheck class="h-3.5 w-3.5 text-link" aria-label="Verified publisher" />
        </span>
        <template v-if="chart.description">
          <span aria-hidden="true">·</span>
          <span class="truncate">{{ chart.description }}</span>
        </template>
      </span>
    </span>
    <span
      class="flex shrink-0 items-center gap-1 text-xs font-medium text-link opacity-0 transition-opacity duration-fast group-hover/row:opacity-100 group-focus-within/row:opacity-100"
    >
      Install <ChevronRight class="h-3.5 w-3.5" />
    </span>
  </button>
</template>

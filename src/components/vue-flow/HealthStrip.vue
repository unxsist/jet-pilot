<script setup lang="ts">
import { cn } from "@/lib/utils";
import { statusDotClass, type StatusTone } from "@/components/ui/status";
import { stripCounts, type StripSegment } from "./nodeStatus";

/*
 * Pods of a workload at a glance: one bar per pod (up to MAX_BARS), a
 * proportional stacked bar beyond that.
 */
const props = defineProps<{
  segments: StripSegment[];
  class?: string;
}>();

const MAX_BARS = 24;
const ORDER: StatusTone[] = ["destructive", "warning", "info", "success", "muted"];

const stacked = computed(() => {
  if (props.segments.length <= MAX_BARS) return [];
  const counts = stripCounts(props.segments);
  return ORDER.filter((tone) => counts[tone]).map((tone) => ({
    tone,
    count: counts[tone]!,
  }));
});
</script>

<template>
  <div
    v-if="segments.length === 0"
    :class="cn('h-2 rounded-full bg-muted', props.class)"
    aria-hidden="true"
  />
  <div
    v-else-if="stacked.length === 0"
    :class="cn('flex h-2.5 items-center gap-[3px]', props.class)"
    role="img"
    :aria-label="segments.map((s) => `${s.name}: ${s.status}`).join(', ')"
  >
    <span
      v-for="segment in segments"
      :key="segment.name"
      :class="
        cn(
          'h-full w-1.5 shrink-0 rounded-[2px] transition-colors duration-base',
          statusDotClass[segment.tone]
        )
      "
      :title="`${segment.name}: ${segment.status}`"
    />
  </div>
  <div
    v-else
    :class="cn('flex h-2 overflow-hidden rounded-full', props.class)"
    role="img"
    :aria-label="stacked.map((s) => `${s.count} ${s.tone}`).join(', ')"
  >
    <span
      v-for="part in stacked"
      :key="part.tone"
      :class="cn('h-full', statusDotClass[part.tone])"
      :style="{ flexGrow: part.count }"
      :title="`${part.count} pods`"
    />
  </div>
</template>

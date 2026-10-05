<script setup lang="ts">
/**
 * Environment badge (PROD / STG / DEV / TEST). An inferred environment (a
 * guess from the name) is drawn dashed with a question mark. Plain classes
 * (not ui/badge): it renders in the sidebar at startup.
 */
import { envInfo, type Environment } from "@/lib/clusters/meta";

const props = withDefaults(
  defineProps<{ env?: Environment; inferred?: boolean; size?: "sm" | "default" }>(),
  { size: "sm" }
);

const TONES = {
  prod: "border-destructive/20 bg-destructive/10 text-destructive",
  staging: "border-warning/20 bg-warning/10 text-warning",
  dev: "border-info/20 bg-info/10 text-info",
  test: "border-border bg-muted text-muted-foreground",
} as const;
const info = computed(() => envInfo(props.env));
</script>

<template>
  <span
    v-if="info"
    class="inline-flex shrink-0 items-center whitespace-nowrap rounded-[4px] border font-semibold leading-none tracking-wide"
    :class="[
      size === 'sm' ? 'h-4 px-1 text-2xs' : 'h-5 px-1.5 text-xs',
      inferred ? 'border-dashed border-border text-muted-foreground' : TONES[env!],
    ]"
    :title="inferred ? `Looks like ${info.label.toLowerCase()} (from the name)` : info.label"
  >
    {{ info.short }}<template v-if="inferred">?</template>
  </span>
</template>

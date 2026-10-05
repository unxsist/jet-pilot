<script setup lang="ts">
/**
 * Environment badge (PROD / STG / DEV / TEST): a soft tint, no frame.
 * `quiet` drops the tint (lists where every row has one). An inferred
 * environment (a guess from the name) is drawn dashed with a question
 * mark. Plain classes (not ui/badge): it renders in the sidebar at startup.
 */
import { envInfo, type Environment } from "@/lib/clusters/meta";

const props = withDefaults(
  defineProps<{ env?: Environment; inferred?: boolean; size?: "sm" | "default"; quiet?: boolean }>(),
  { size: "sm", env: undefined }
);

const TONES = {
  prod: ["text-destructive", "bg-destructive/10"],
  staging: ["text-warning", "bg-warning/10"],
  dev: ["text-info", "bg-info/10"],
  test: ["text-muted-foreground", "bg-muted"],
} as const;
const info = computed(() => envInfo(props.env));
const tone = computed(() => {
  if (props.inferred) return "border border-dashed text-muted-foreground";
  const [text, tint] = TONES[props.env!];
  return props.quiet ? text : `${text} ${tint}`;
});
</script>

<template>
  <span
    v-if="info"
    class="inline-flex shrink-0 items-center whitespace-nowrap rounded-[4px] font-semibold leading-none tracking-wide"
    :class="[quiet ? 'text-2xs' : size === 'sm' ? 'h-4 px-1 text-2xs' : 'h-5 px-1.5 text-xs', tone]"
    :title="inferred ? `Looks like ${info.label.toLowerCase()} (from the name)` : info.label"
  >
    {{ info.short }}<template v-if="inferred">?</template>
  </span>
</template>

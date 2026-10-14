<script setup lang="ts">
/**
 * Which tool delivers something: the Flux or Argo CD mark. Monochrome by
 * default (rows stay calm: the status dot carries the colour), in the
 * brand colour with `brand`.
 */
import { TOOL_GLYPHS } from "@/lib/gitops/glyphs";
import { TOOL_LABELS, type Tool } from "@/lib/gitops/kinds";

const props = withDefaults(defineProps<{ tool: Tool; size?: number; brand?: boolean }>(), {
  size: 16,
  brand: false,
});
</script>

<template>
  <svg
    :width="props.size"
    :height="props.size"
    viewBox="0 0 24 24"
    class="shrink-0"
    role="img"
    :aria-label="TOOL_LABELS[props.tool]"
  >
    <title>{{ TOOL_LABELS[props.tool] }}</title>
    <path :d="TOOL_GLYPHS[props.tool].path" :fill="props.brand ? `#${TOOL_GLYPHS[props.tool].hex}` : 'currentColor'" />
  </svg>
</template>

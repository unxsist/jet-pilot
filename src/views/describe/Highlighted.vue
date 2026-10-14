<script setup lang="ts">
/**
 * Text with the describe search's matches marked; `start` is the number of
 * its first match in the whole document (for Enter / Shift+Enter).
 */
import { matchStarts } from "@/lib/resources/describe";

const props = defineProps<{ text: string; query: string; start: number; active: number }>();

const segments = computed(() => {
  const starts = matchStarts(props.text, props.query);
  if (!starts.length) return [{ text: props.text, match: -1 }];
  const length = props.query.length;
  const parts: { text: string; match: number }[] = [];
  let at = 0;
  starts.forEach((from, index) => {
    if (from > at) parts.push({ text: props.text.slice(at, from), match: -1 });
    parts.push({ text: props.text.slice(from, from + length), match: props.start + index });
    at = from + length;
  });
  if (at < props.text.length) parts.push({ text: props.text.slice(at), match: -1 });
  return parts;
});
</script>

<template>
  <template v-for="(segment, index) in segments" :key="index"
    ><span
      v-if="segment.match >= 0"
      :data-describe-match="segment.match"
      :class="
        segment.match === active
          ? 'rounded-[2px] bg-warning/50 text-foreground ring-1 ring-warning'
          : 'rounded-[2px] bg-warning/20'
      "
      >{{ segment.text }}</span
    ><template v-else>{{ segment.text }}</template></template
  >
</template>

<script setup lang="ts">
/**
 * A value people read and copy (ConfigMap data, a JSON annotation): JSON
 * pretty-printed, JSON and YAML lightly coloured, plain text as is. Tall
 * values scroll inside the block.
 */
import { highlight, type Token, type ValueFormat } from "@/lib/resources/highlight";

const props = defineProps<{ value: string; format: ValueFormat }>();

const lines = computed(() => highlight(props.value, props.format));

const CLASSES: Record<Token["kind"], string> = {
  key: "text-link",
  string: "text-foreground",
  literal: "text-info",
  comment: "italic text-muted-foreground",
  punctuation: "text-muted-foreground",
  text: "text-foreground",
};
</script>

<template>
  <pre
    class="max-h-72 overflow-auto rounded-md border border-border-subtle bg-surface-1 px-3 py-2 font-mono text-xs leading-5 select-text"
  ><div v-for="(line, index) in lines" :key="index" class="min-h-5 whitespace-pre-wrap break-all"><span
      v-for="(token, t) in line"
      :key="t"
      :class="CLASSES[token.kind]"
    >{{ token.text }}</span></div></pre>
</template>

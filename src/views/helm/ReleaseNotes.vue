<script setup lang="ts">
import CopyButton from "./CopyButton.vue";
import { splitNotes, type NotesBlock } from "@/lib/helm";

/*
 * A chart's NOTES.txt, readable: prose as text, shell commands as
 * monospace blocks you can copy with one click.
 */
const props = defineProps<{ notes: string }>();

/* Prose split into paragraphs: blank lines become spacing, not empty lines. */
const blocks = computed(() =>
  splitNotes(props.notes).flatMap<NotesBlock>((block) =>
    block.type === "text"
      ? block.text
          .split(/\n\s*\n/)
          .map((text) => text.replace(/^\n+|\s+$/g, ""))
          .filter(Boolean)
          .map((text) => ({ type: "text" as const, text }))
      : [block]
  )
);
</script>

<template>
  <div class="space-y-2 text-sm leading-relaxed">
    <template v-for="(block, index) in blocks" :key="index">
      <p
        v-if="block.type === 'text'"
        class="whitespace-pre-wrap break-words text-foreground/90 select-text"
      >{{ block.text }}</p>
      <div
        v-else
        class="group/copy relative rounded-lg border border-border-subtle bg-surface-1"
      >
        <pre
          class="whitespace-pre-wrap py-2 pl-3 pr-9 font-mono text-xs leading-5 text-foreground break-all select-text"
        >{{ block.text }}</pre>
        <CopyButton
          :text="block.text"
          label="Copy command"
          class="absolute right-1.5 top-1.5 opacity-60 group-hover/copy:opacity-100 focus-visible:opacity-100"
        />
      </div>
    </template>
  </div>
</template>

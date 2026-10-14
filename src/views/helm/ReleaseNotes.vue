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
        class="flex items-start rounded-lg border border-border-subtle bg-surface-1"
      >
        <pre
          class="notes-command min-w-0 flex-1 overflow-x-auto whitespace-pre py-2 pl-3 pr-2 font-mono text-xs leading-5 text-foreground select-text"
        >{{ block.text }}</pre>
        <CopyButton :text="block.text" label="Copy command" class="m-1" />
      </div>
    </template>
  </div>
</template>

<style scoped>
/* Commands stay on their lines (never broken inside a word): they scroll
   sideways, with a thin scrollbar that only shows on hover. */
.notes-command::-webkit-scrollbar {
  height: 6px;
}
.notes-command::-webkit-scrollbar-thumb {
  background-color: transparent;
}
.notes-command:hover::-webkit-scrollbar-thumb {
  background-color: hsl(var(--scrollbar));
}
</style>

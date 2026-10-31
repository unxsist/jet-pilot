<script setup lang="ts">
/**
 * What a fix changes in a spec: the changed lines with a little context,
 * from two YAML texts (the live spec and the server's dry run, or two
 * revisions). Light on purpose: no editor in a dialog.
 */
import { diffHunks, diffLines } from "@/lib/diff";

const props = defineProps<{ before: string; after: string }>();

const hunks = computed(() => diffHunks(diffLines(props.before, props.after), 2));
</script>

<template>
  <div class="max-h-56 overflow-auto rounded-lg border bg-surface-1 py-1.5 font-mono text-2xs leading-relaxed">
    <p v-if="!hunks.length" class="px-3 text-muted-foreground">Nothing changes.</p>
    <template v-for="(hunk, index) in hunks" :key="index">
      <div v-if="index > 0" class="my-1 border-t border-dashed" aria-hidden="true" />
      <p
        v-for="(line, lineIndex) in hunk.lines"
        :key="lineIndex"
        class="select-text whitespace-pre px-3"
        :class="
          line.op === 'add'
            ? 'bg-success/10 text-success'
            : line.op === 'remove'
              ? 'bg-destructive/10 text-destructive'
              : 'text-muted-foreground'
        "
      ><span aria-hidden="true" class="select-none">{{ line.op === "add" ? "+ " : line.op === "remove" ? "- " : "  " }}</span>{{ line.text }}</p>
    </template>
  </div>
</template>

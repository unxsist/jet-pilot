<script setup lang="ts">
/*
 * What a custom action will do, as the user reads it: "Will run" over the
 * command (values quoted), URL, text or patch in a quiet monospace block.
 */
import { PREVIEW_LABELS } from "@/lib/customActions/words";
import type { RunType } from "@/lib/customActions/types";

withDefaults(
  defineProps<{
    type: RunType;
    text: string;
    /** Further objects it runs on. */
    more?: number;
    /** Shown instead of the text when it can't be previewed. */
    problem?: string | null;
  }>(),
  { more: 0, problem: null }
);
</script>

<template>
  <div class="space-y-1.5" aria-live="polite">
    <div class="flex items-baseline justify-between gap-3 text-xs">
      <span class="font-medium text-muted-foreground">{{ PREVIEW_LABELS[type] }}</span>
      <span v-if="more > 0" class="tabular-nums text-muted-foreground">and {{ more }} more</span>
    </div>
    <p
      v-if="problem"
      class="rounded-md border border-destructive/20 bg-destructive/[0.06] px-3 py-2 text-xs text-destructive"
    >
      {{ problem }}
    </p>
    <pre
      v-else
      class="max-h-40 overflow-auto whitespace-pre-wrap rounded-md [overflow-wrap:anywhere] border border-border-subtle bg-surface-1 px-3 py-2 font-mono text-xs leading-relaxed text-foreground select-text"
    >{{ text || " " }}</pre>
  </div>
</template>

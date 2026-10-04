<script setup lang="ts">
import { diffHunks, diffLines, diffSummary } from "@/lib/diff";
import { EmptyState } from "@/components/ui/empty-state";
import { Equal } from "lucide-vue-next";

/*
 * Unified line diff of two texts (YAML manifests / values) with hunks,
 * line numbers and a +/- summary. Pure rendering, no editor.
 */
const props = withDefaults(
  defineProps<{
    oldText: string;
    newText: string;
    oldLabel?: string;
    newLabel?: string;
    context?: number;
    /* Show the whole file instead of hunks. */
    full?: boolean;
    emptyText?: string;
  }>(),
  { context: 4, full: false, emptyText: "No differences" }
);

const lines = computed(() => diffLines(props.oldText, props.newText));
const summary = computed(() => diffSummary(lines.value));
const hunks = computed(() =>
  props.full
    ? lines.value.length
      ? [
          {
            oldStart: 1,
            oldLines: 0,
            newStart: 1,
            newLines: 0,
            lines: lines.value,
          },
        ]
      : []
    : diffHunks(lines.value, props.context)
);

const lineClass = (op: string) =>
  op === "add"
    ? "bg-success/10"
    : op === "remove"
      ? "bg-destructive/10"
      : "";

const markerClass = (op: string) =>
  op === "add"
    ? "text-success"
    : op === "remove"
      ? "text-destructive"
      : "text-muted-foreground";
</script>

<template>
  <div class="flex h-full min-h-0 flex-col">
    <div
      class="flex h-9 shrink-0 items-center gap-3 border-b border-border-subtle px-3 text-xs"
    >
      <span v-if="oldLabel || newLabel" class="min-w-0 truncate text-muted-foreground">
        <span class="font-mono text-foreground">{{ oldLabel }}</span>
        →
        <span class="font-mono text-foreground">{{ newLabel }}</span>
      </span>
      <span class="ml-auto shrink-0 font-mono tabular-nums">
        <span class="text-success">+{{ summary.added }}</span>
        <span class="ml-2 text-destructive">−{{ summary.removed }}</span>
      </span>
    </div>
    <div
      v-if="summary.added === 0 && summary.removed === 0"
      class="flex flex-1 items-center justify-center"
    >
      <EmptyState :icon="Equal" :title="emptyText" size="sm" />
    </div>
    <div
      v-else
      class="min-h-0 flex-1 overflow-auto bg-background font-mono text-xs leading-5 select-text"
      role="region"
      aria-label="Diff"
    >
      <template v-for="(hunk, h) in hunks" :key="h">
        <div
          v-if="!full"
          class="sticky top-0 z-[1] border-y border-border-subtle bg-muted px-3 text-2xs leading-6 text-muted-foreground"
        >
          @@ -{{ hunk.oldStart }},{{ hunk.oldLines }} +{{ hunk.newStart }},{{
            hunk.newLines
          }}
          @@
        </div>
        <div class="w-max min-w-full">
          <div
            v-for="(line, i) in hunk.lines"
            :key="i"
            class="flex"
            :class="lineClass(line.op)"
          >
            <span
              class="w-10 shrink-0 select-none pr-2 text-right tabular-nums text-muted-foreground"
              >{{ line.oldLine ?? "" }}</span
            >
            <span
              class="w-10 shrink-0 select-none pr-2 text-right tabular-nums text-muted-foreground"
              >{{ line.newLine ?? "" }}</span
            >
            <span class="w-5 shrink-0 select-none text-center" :class="markerClass(line.op)">{{
              line.op === "add" ? "+" : line.op === "remove" ? "−" : ""
            }}</span>
            <span class="whitespace-pre pr-4 text-foreground">{{ line.text }}</span>
          </div>
        </div>
      </template>
    </div>
  </div>
</template>

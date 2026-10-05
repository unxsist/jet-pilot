<script setup lang="ts">
import { diffHunks, diffLines, diffSummary } from "@/lib/diff";
import { EmptyState } from "@/components/ui/empty-state";
import { Button } from "@/components/ui/button";
import MonacoView from "@/components/monaco/MonacoView.vue";
import { useSessionStorage } from "@vueuse/core";
import { Columns2, Equal, Rows2 } from "lucide-vue-next";
import { injectStrict } from "@/lib/utils";
import { SettingsContextStateKey } from "@/providers/SettingsContextProvider";

/*
 * Diff of two texts (YAML manifests / values) with a +/- summary: the Monaco
 * diff editor (lazy-loaded, side by side or inline, unchanged regions
 * collapsed unless `full`). When Monaco can't be loaded, a plain unified
 * line diff with hunks and line numbers is rendered instead.
 */
const props = withDefaults(
  defineProps<{
    oldText: string;
    newText: string;
    oldLabel?: string;
    newLabel?: string;
    context?: number;
    /* Show the whole file instead of hunks / collapsed regions. */
    full?: boolean;
    emptyText?: string;
  }>(),
  { context: 4, full: false, emptyText: "No differences" }
);

/* Shared by every diff of the session; starts with the preferred layout. */
const { settings } = injectStrict(SettingsContextStateKey);
const sideBySide = useSessionStorage(
  "jet:diff-side-by-side",
  settings.value.editor.diffMode === "sideBySide"
);
const monacoFailed = ref(false);

const lines = computed(() => diffLines(props.oldText, props.newText));
const summary = computed(() => diffSummary(lines.value));
const hunks = computed(() =>
  !monacoFailed.value
    ? []
    : props.full
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
      <Button
        v-if="!monacoFailed"
        variant="ghost"
        size="icon-xs"
        class="-mr-1 shrink-0 text-muted-foreground"
        :title="sideBySide ? 'Inline diff' : 'Side-by-side diff'"
        :aria-label="sideBySide ? 'Inline diff' : 'Side-by-side diff'"
        @click="sideBySide = !sideBySide"
      >
        <Rows2 v-if="sideBySide" class="h-3.5 w-3.5" />
        <Columns2 v-else class="h-3.5 w-3.5" />
      </Button>
    </div>
    <div
      v-if="summary.added === 0 && summary.removed === 0"
      class="flex flex-1 items-center justify-center"
    >
      <EmptyState :icon="Equal" :title="emptyText" size="sm" />
    </div>
    <div v-else-if="!monacoFailed" class="min-h-0 flex-1">
      <MonacoView
        :original="oldText"
        :value="newText"
        :side-by-side="sideBySide"
        :hide-unchanged="!full"
        @error="monacoFailed = true"
      />
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

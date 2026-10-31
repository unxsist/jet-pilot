<script setup lang="ts">
/*
 * Split view pane controls, at the end of a view's own toolbar (list
 * toolbar, page header, graph toolbar): open the pane's view in a new
 * window and close the pane. Rendered only inside a pane of a split.
 */
import { SquareArrowOutUpRight, X } from "lucide-vue-next";
import { type as getOsType } from "@tauri-apps/plugin-os";
import { Button } from "@/components/ui/button";
import { PaneKey } from "@/lib/splitView";
import { WindowsKey } from "@/lib/windows";
import { SplitViewKey } from "@/providers/SplitViewProvider";

const pane = inject(PaneKey, null);
const split = inject(SplitViewKey, null);
/* Pop-out windows (main window only). */
const windows = inject(WindowsKey, null);
const shortcut = getOsType() === "macos" ? "⌘\\" : "Ctrl+\\";

const index = computed(() => (pane && split?.isSplit.value ? pane.index.value : null));
const path = computed(() =>
  index.value === null ? "" : (split?.layout.value.panes[index.value]?.path ?? "")
);
</script>

<template>
  <div v-if="index !== null" class="ml-1 flex items-center gap-0.5 border-l pl-1.5">
    <Button
      v-if="windows"
      variant="ghost"
      size="icon-sm"
      class="text-muted-foreground"
      aria-label="Open this view in a new window"
      title="Open in new window"
      @click="windows.openView(path, { closePane: index })"
    >
      <SquareArrowOutUpRight class="h-3.5 w-3.5" />
    </Button>
    <Button
      variant="ghost"
      size="icon-sm"
      class="text-muted-foreground"
      aria-label="Close this pane"
      :title="`Close pane (${shortcut} closes the other one)`"
      @click="split?.close(index)"
    >
      <X class="h-4 w-4" />
    </Button>
  </div>
</template>

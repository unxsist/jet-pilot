<script setup lang="ts">
/*
 * Bottom-panel tab strip buttons for pop-out windows (@/lib/windows): in
 * the main window, open the active tab in a new window; in a pop-out
 * window, move it back to the main window.
 */
import { SquareArrowDownLeft, SquareArrowOutUpRight } from "lucide-vue-next";
import { Button } from "@/components/ui/button";
import { injectStrict } from "@/lib/utils";
import { PopOutKey, WindowsKey } from "@/lib/windows";
import { PanelProviderStateKey } from "@/providers/PanelProvider";

const { activeTabId } = injectStrict(PanelProviderStateKey);
const windows = inject(WindowsKey, null);
const popOut = inject(PopOutKey, null);

const canPopOut = computed(
  () => !!windows && !!activeTabId.value && windows.canMoveTab(activeTabId.value)
);
</script>

<template>
  <Button
    v-if="canPopOut"
    variant="ghost"
    size="icon-xs"
    class="text-muted-foreground"
    aria-label="Open the tab in a new window"
    title="Open in new window (Shift+click a tab)"
    @click="windows?.moveTab(activeTabId!)"
  >
    <SquareArrowOutUpRight class="h-3.5 w-3.5" />
  </Button>
  <Button
    v-if="popOut && activeTabId"
    variant="ghost"
    size="icon-xs"
    class="text-muted-foreground"
    aria-label="Move the tab to the main window"
    title="Move to main window"
    @click="popOut.moveTabToMain(activeTabId)"
  >
    <SquareArrowDownLeft class="h-3.5 w-3.5" />
  </Button>
</template>

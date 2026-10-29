<script setup lang="ts">
/*
 * Bottom-panel tab strip button of the main window: open the active tab in
 * a new window (@/lib/windows). Pop-out windows move things back from their
 * title bar.
 */
import { SquareArrowOutUpRight } from "lucide-vue-next";
import { Button } from "@/components/ui/button";
import { injectStrict } from "@/lib/utils";
import { WindowsKey } from "@/lib/windows";
import { PanelProviderStateKey } from "@/providers/PanelProvider";

const { activeTabId } = injectStrict(PanelProviderStateKey);
const windows = inject(WindowsKey, null);

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
</template>

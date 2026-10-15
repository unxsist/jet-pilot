<script setup lang="ts">
/**
 * "← Pod postgres-0" at the top of the side panel after following a link
 * in it (see @/lib/resources/panelTrail). Loaded with the first panel, so
 * the startup bundle doesn't carry it.
 */
import { ArrowLeft } from "lucide-vue-next";
import { injectStrict } from "@/lib/utils";
import { PanelProviderSetSidePanelComponentKey, PanelProviderStateKey } from "@/providers/PanelProvider";
import { notePanelChange, panelBack, panelTrail } from "@/lib/resources/panelTrail";

const { sidePanel } = injectStrict(PanelProviderStateKey);
const setSidePanel = injectStrict(PanelProviderSetSidePanelComponentKey);

watch(sidePanel, (panel) => notePanelChange(panel), { immediate: true });

const previous = computed(() => {
  const panel = panelTrail.value[panelTrail.value.length - 1];
  const object = panel?.props?.resource;
  return panel ? (object?.metadata?.name ? `${object.kind} ${object.metadata.name}` : panel.title) : null;
});
</script>

<template>
  <button
    v-if="previous"
    type="button"
    class="-mb-1 -ml-1 flex max-w-full items-center gap-1 rounded px-1 text-xs text-muted-foreground transition-colors duration-fast hover:text-foreground focus-ring focus-visible:ring-offset-card"
    :title="`Back to ${previous}`"
    :aria-label="`Back to ${previous}`"
    @click="panelBack(setSidePanel)"
  >
    <ArrowLeft class="h-3 w-3 shrink-0" />
    <span class="truncate">{{ previous }}</span>
  </button>
</template>

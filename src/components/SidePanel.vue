<script setup lang="ts">
import { PanelProviderStateKey } from "@/providers/PanelProvider";
import { injectStrict } from "@/lib/utils";
import { ResizablePanel } from "@/components/ui/resizable";

const { sidePanelComponent, sidePanelComponentProps } = injectStrict(
  PanelProviderStateKey
);
</script>

<template>
  <ResizablePanel v-if="sidePanelComponent !== null">
    <component :is="sidePanelComponent" v-bind="sidePanelComponentProps" />
  </ResizablePanel>
</template>

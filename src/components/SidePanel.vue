<script setup lang="ts">
import {
  PanelProviderStateKey,
  PanelProviderSetSidePanelComponentKey,
} from "@/providers/PanelProvider";
import { injectStrict } from "@/lib/utils";
import { ResizablePanel } from "@/components/ui/resizable";
import CloseIcon from "@/assets/icons/close.svg";
import { min } from "date-fns";

const { sidePanel } = injectStrict(PanelProviderStateKey);
const setSidePanelComponent = injectStrict(
  PanelProviderSetSidePanelComponentKey
);

const icon = defineAsyncComponent(() =>
  import(`@/assets/icons/${sidePanel.value?.icon}.svg`).catch(
    () => import("@/assets/icons/k8s.svg")
  )
);
</script>

<template>
  <ResizablePanel v-if="sidePanel !== null" :default-size="30">
    <div class="bg-background p-4 flex justify-between items-center border-b">
      <div class="flex items-center space-x-2">
        <component v-if="sidePanel.icon" :is="icon" class="h-4" />
        <span class="">{{ sidePanel.title }}</span>
      </div>
      <button @click="setSidePanelComponent(null)">
        <CloseIcon class="w-4 h-4" />
      </button>
    </div>
    <component :is="sidePanel.component" v-bind="sidePanel.props" />
  </ResizablePanel>
</template>

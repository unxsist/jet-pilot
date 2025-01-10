<script setup lang="ts">
import { KubeContextStateKey } from "@/providers/KubeContextProvider";
import { injectStrict } from "@/lib/utils";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import TabOrchestrator from "@/components/TabOrchestrator.vue";
import { useRoute } from "vue-router";
import NoContext from "@/views/NoContext.vue";

const { context } = injectStrict(KubeContextStateKey);
const route = useRoute();
</script>
<template>
  <div
    class="flex flex-col h-full relative w-full border-l border-border bg-background"
  >
    <ResizablePanelGroup direction="vertical">
      <ResizablePanel>
        <NoContext v-if="route.meta.requiresContext && context == ''" />
        <router-view v-else />
      </ResizablePanel>
      <ResizableHandle />
      <TabOrchestrator />
    </ResizablePanelGroup>
  </div>
</template>

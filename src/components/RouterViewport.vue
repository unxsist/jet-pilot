<script setup lang="ts">
import { KubeContextStateKey } from "@/providers/KubeContextProvider";
import { injectStrict } from "@/lib/utils";
import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area";
import TabOrchestrator from "@/components/TabOrchestrator.vue";
import { useRoute } from "vue-router";
import NoContext from "@/views/NoContext.vue";

const { context } = injectStrict(KubeContextStateKey);
const route = useRoute();
</script>
<template>
  <div class="flex flex-col max-h-screen relative router-viewport">
    <ScrollArea
      class="w-full flex flex-grow border-l border-[#232323] bg-[#0f0f0f]"
    >
      <NoContext v-if="route.meta.requiresContext && context == ''" />
      <router-view v-else />
      <ScrollBar orientation="horizontal" />
    </ScrollArea>
    <TabOrchestrator />
  </div>
</template>
<style>
.router-viewport {
  width: calc(100vw - 200px);
}
</style>

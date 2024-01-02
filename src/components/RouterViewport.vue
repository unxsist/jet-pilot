<script setup lang="ts">
import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area";
import TabOrchestrator from "@/components/TabOrchestrator.vue";
</script>
<template>
  <div class="flex flex-col max-h-screen relative router-viewport">
    <ScrollArea
      class="w-full flex flex-grow border-l border-[#232323] bg-[#0f0f0f]"
    >
      <router-view />
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

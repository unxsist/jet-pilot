<script setup lang="ts">
import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area";
</script>
<template>
  <ScrollArea
    class="w-full h-full flex flex-grow border-l border-[#232323] bg-[#0f0f0f]"
  >
    <router-view />
    <ScrollBar orientation="horizontal" />
  </ScrollArea>
</template>

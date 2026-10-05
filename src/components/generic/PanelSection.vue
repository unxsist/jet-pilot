<script setup lang="ts">
import type { Component } from "vue";
import {
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";

/**
 * Collapsible section of the resource side panel: a quiet heading with an
 * icon and an optional count, content below.
 */
defineProps<{
  value: string;
  title: string;
  icon?: Component;
  count?: number;
}>();
</script>

<template>
  <AccordionItem :value="value" class="px-4">
    <AccordionTrigger
      class="py-2.5 text-xs text-muted-foreground hover:text-foreground focus-visible:ring-offset-card data-[state=open]:text-foreground"
    >
      <span class="flex items-center gap-2">
        <component :is="icon" v-if="icon" class="h-3.5 w-3.5" />
        {{ title }}
        <span
          v-if="count !== undefined"
          class="font-normal tabular-nums text-muted-foreground"
          >{{ count }}</span
        >
      </span>
    </AccordionTrigger>
    <AccordionContent class="pb-4 text-foreground">
      <slot />
    </AccordionContent>
  </AccordionItem>
</template>

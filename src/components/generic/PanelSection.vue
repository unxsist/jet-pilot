<script setup lang="ts">
import type { Component } from "vue";
import {
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";

/**
 * Collapsible section of the resource side panel: a quiet heading with an
 * icon, an optional count and hint (what is inside, readable while it is
 * folded), content below. `#actions` sit at the right of the heading
 * (e.g. Edit), outside the toggle.
 */
defineProps<{
  value: string;
  title: string;
  icon?: Component;
  count?: number;
  hint?: string;
}>();
</script>

<template>
  <AccordionItem :value="value" class="group/section relative px-4">
    <AccordionTrigger
      class="py-2.5 text-xs text-muted-foreground hover:text-foreground focus-visible:ring-offset-card data-[state=open]:text-foreground"
    >
      <span class="flex min-w-0 flex-1 items-center gap-2">
        <component :is="icon" v-if="icon" class="h-3.5 w-3.5 shrink-0" />
        <span class="shrink-0">{{ title }}</span>
        <span
          v-if="count !== undefined"
          class="font-normal tabular-nums text-muted-foreground"
          >{{ count }}</span
        >
        <span
          v-if="hint && !$slots.actions"
          class="ml-auto min-w-0 truncate pl-2 font-normal text-muted-foreground"
          >{{ hint }}</span
        >
      </span>
    </AccordionTrigger>
    <div
      v-if="$slots.actions"
      class="absolute right-9 top-1.5 flex items-center gap-1"
    >
      <slot name="actions" />
    </div>
    <AccordionContent class="pb-4 text-foreground">
      <slot />
    </AccordionContent>
  </AccordionItem>
</template>

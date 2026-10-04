<script setup lang="ts">
import { TooltipProvider, type TooltipProviderProps } from 'radix-vue'

// Fast by default: tooltips are hints, not interruptions.
const props = withDefaults(defineProps<TooltipProviderProps>(), {
  delayDuration: 300,
  skipDelayDuration: 150,
})
</script>

<template>
  <TooltipProvider v-bind="props">
    <slot />
  </TooltipProvider>
</template>

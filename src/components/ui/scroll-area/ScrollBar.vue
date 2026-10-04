<script setup lang="ts">
import {
  ScrollAreaScrollbar,
  type ScrollAreaScrollbarProps,
  ScrollAreaThumb,
} from "radix-vue";
import { cn } from "@/lib/utils";

const props = withDefaults(defineProps<ScrollAreaScrollbarProps>(), {
  orientation: "vertical",
});
</script>

<template>
  <ScrollAreaScrollbar
    v-bind="props"
    :class="
      cn(
        'flex touch-none select-none p-0.5 transition-colors duration-fast',
        orientation === 'vertical' &&
          'h-full w-2.5',
        orientation === 'horizontal' &&
          'h-2.5 flex-col',
        $attrs.class ?? ''
      )
    "
  >
    <ScrollAreaThumb class="relative flex-1 rounded-full bg-[hsl(var(--scrollbar))] transition-colors hover:bg-[hsl(var(--scrollbar-hover))]" />
  </ScrollAreaScrollbar>
</template>

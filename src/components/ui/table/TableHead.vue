<script setup lang="ts">
import { withDefaults } from "vue";
import { cn } from "@/lib/utils";

const props = withDefaults(
  defineProps<{
    class?: string;
    enableHeaderDragRegion: boolean;
    sticky: boolean;
    /** right-align to match `numeric` cells */
    numeric?: boolean;
  }>(),
  {
    enableHeaderDragRegion: false,
    sticky: false,
  }
);
</script>

<template>
  <th
    :data-tauri-drag-region="
      enableHeaderDragRegion ? enableHeaderDragRegion : null
    "
    :class="
      cn(
        'h-8 whitespace-nowrap px-2.5 text-left align-middle text-xs font-medium text-muted-foreground [&:has([role=checkbox])]:pr-0 [&>[role=checkbox]]:translate-y-[2px]',
        props.numeric && 'text-right',
        props.class,
        {
          'sticky top-0 z-20 bg-background': props.sticky === true,
        }
      )
    "
  >
    <slot />
    <div class="absolute top-full left-0 bottom-0 h-[1px] w-full bg-border" />
  </th>
</template>

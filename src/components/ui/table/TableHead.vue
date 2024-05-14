<script setup lang="ts">
import { withDefaults } from "vue";
import { cn } from "@/lib/utils";

const props = withDefaults(
  defineProps<{
    class?: string;
    enableHeaderDragRegion: boolean;
    sticky: boolean;
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
        'h-10 px-2 text-left align-middle font-medium text-muted-foreground [&:has([role=checkbox])]:pr-0 [&>[role=checkbox]]:translate-y-[2px]',
        props.class,
        {
          'top-0 z-20 sticky bg-background': props.sticky === true,
        }
      )
    "
  >
    <slot />
    <div class="absolute top-full left-0 bottom-0 h-[1px] w-full bg-border" />
  </th>
</template>

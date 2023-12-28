<script setup lang="ts">
import { withDefaults } from "vue";
import { cn } from "@/lib/utils";

const props = withDefaults(
  defineProps<{ class?: string; enableHeaderDragRegion: boolean }>(),
  {
    enableHeaderDragRegion: false,
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
        props.class
      )
    "
  >
    <slot />
  </th>
</template>

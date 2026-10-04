<script setup lang="ts">
import {
  ContextMenuSubTrigger,
  type ContextMenuSubTriggerProps,
} from 'radix-vue'
import { ChevronRightIcon } from '@radix-icons/vue'
import { cn } from '@/lib/utils'
import { menuItem } from '@/components/ui/overlay-styles'

const props = defineProps<ContextMenuSubTriggerProps & { class?: string; inset?: boolean }>()
</script>

<template>
  <ContextMenuSubTrigger
    v-bind="props"
    :class="[
      cn(
        menuItem,
        'data-[state=open]:bg-accent data-[state=open]:text-accent-foreground',
        inset && 'pl-7',
        props.class,
      ),
    ]"
  >
    <slot />
    <ChevronRightIcon class="ml-auto h-3.5 w-3.5 text-muted-foreground" />
  </ContextMenuSubTrigger>
</template>

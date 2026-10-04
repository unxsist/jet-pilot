<script setup lang="ts">
import {
  ContextMenuItem,
  type ContextMenuItemEmits,
  type ContextMenuItemProps,
  useEmitAsProps,
} from 'radix-vue'
import { cn } from '@/lib/utils'
import { menuItem, menuItemDestructive } from '@/components/ui/overlay-styles'

const props = defineProps<ContextMenuItemProps & {
  class?: string
  inset?: boolean
  variant?: 'default' | 'destructive'
}>()
const emits = defineEmits<ContextMenuItemEmits>()
</script>

<template>
  <ContextMenuItem
    v-bind="{ ...props, variant: undefined, ...useEmitAsProps(emits) }"
    :class="[
      cn(
        menuItem,
        variant === 'destructive' && menuItemDestructive,
        inset && 'pl-7',
        props.class,
      ),
    ]"
  >
    <slot />
  </ContextMenuItem>
</template>

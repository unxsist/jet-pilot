<script setup lang="ts">
import { DropdownMenuItem, type DropdownMenuItemProps } from 'radix-vue'
import { cn } from '@/lib/utils'
import { menuItem, menuItemDestructive } from '@/components/ui/overlay-styles'

const props = defineProps<DropdownMenuItemProps & {
  inset?: boolean
  class?: string
  variant?: 'default' | 'destructive'
}>()
</script>

<template>
  <DropdownMenuItem
    v-bind="{ ...props, variant: undefined }"
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
  </DropdownMenuItem>
</template>

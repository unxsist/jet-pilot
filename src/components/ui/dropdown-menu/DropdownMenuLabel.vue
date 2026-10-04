<script setup lang="ts">
import { DropdownMenuLabel, type DropdownMenuLabelProps } from 'radix-vue'
import { cn } from '@/lib/utils'
import { menuLabel } from '@/components/ui/overlay-styles'

const props = defineProps<DropdownMenuLabelProps & {
  inset?: boolean
  class?: string
}>()
</script>

<template>
  <DropdownMenuLabel
    v-bind="props"
    :class="
      cn(menuLabel,
         inset && 'pl-7', props.class)"
  >
    <slot />
  </DropdownMenuLabel>
</template>

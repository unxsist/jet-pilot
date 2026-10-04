<script setup lang="ts">
import { ContextMenuLabel, type ContextMenuLabelProps } from 'radix-vue'
import { cn } from '@/lib/utils'
import { menuLabel } from '@/components/ui/overlay-styles'

const props = defineProps<ContextMenuLabelProps & { class?: string; inset?: boolean }>()
</script>

<template>
  <ContextMenuLabel
    v-bind="props"
    :class="
      cn(menuLabel,
         inset && 'pl-7', props.class ?? '',
      )"
  >
    <slot />
  </ContextMenuLabel>
</template>

<script setup lang="ts">
import {
  ContextMenuSeparator,
  type ContextMenuSeparatorProps,
} from 'radix-vue'
import { cn } from '@/lib/utils'
import { menuSeparator } from '@/components/ui/overlay-styles'

const props = defineProps<ContextMenuSeparatorProps>()
</script>

<template>
  <ContextMenuSeparator v-bind="props" :class="cn(menuSeparator, $attrs.class ?? '')" />
</template>

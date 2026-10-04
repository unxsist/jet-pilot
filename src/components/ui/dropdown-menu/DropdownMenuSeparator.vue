<script setup lang="ts">
import { cn } from '@/lib/utils'
import { menuSeparator } from '@/components/ui/overlay-styles'
import {
  DropdownMenuSeparator,
  type DropdownMenuSeparatorProps,
} from 'radix-vue'

const props = defineProps<DropdownMenuSeparatorProps & { class?: string }>()
</script>

<template>
  <DropdownMenuSeparator v-bind="{ ...props, class: undefined }" :class="cn(menuSeparator, props.class)" />
</template>

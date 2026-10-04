<script setup lang="ts">
import {
  ContextMenuCheckboxItem,
  type ContextMenuCheckboxItemEmits,
  type ContextMenuCheckboxItemProps,
  ContextMenuItemIndicator,
  useEmitAsProps,
} from 'radix-vue'
import { CheckIcon } from '@radix-icons/vue'
import { cn } from '@/lib/utils'
import { menuIndicator, menuItem } from '@/components/ui/overlay-styles'

const props = defineProps<ContextMenuCheckboxItemProps & { class?: string }>()
const emits = defineEmits<ContextMenuCheckboxItemEmits>()
</script>

<template>
  <ContextMenuCheckboxItem
    v-bind="{ ...props, ...useEmitAsProps(emits) }"
    :class="[
      cn(
        menuItem,
        'pl-7',
        props.class,
      ),
    ]"
  >
    <span :class="menuIndicator">
      <ContextMenuItemIndicator class="inline-flex items-center justify-center">
        <CheckIcon class="h-3.5 w-3.5" />
      </ContextMenuItemIndicator>
    </span>
    <slot />
  </ContextMenuCheckboxItem>
</template>

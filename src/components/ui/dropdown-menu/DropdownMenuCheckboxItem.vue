<script setup lang="ts">
import {
  DropdownMenuCheckboxItem,
  type DropdownMenuCheckboxItemEmits,
  type DropdownMenuCheckboxItemProps,
  DropdownMenuItemIndicator,
  useEmitAsProps,
} from 'radix-vue'
import { CheckIcon } from '@radix-icons/vue'
import { cn } from '@/lib/utils'
import { menuIndicator, menuItem } from '@/components/ui/overlay-styles'

const props = defineProps<DropdownMenuCheckboxItemProps & { class?: string }>()
const emits = defineEmits<DropdownMenuCheckboxItemEmits>()
</script>

<template>
  <DropdownMenuCheckboxItem
    v-bind="{ ...props, ...useEmitAsProps(emits) }"
    :class=" cn(
      menuItem,
      'pl-7',
      props.class,
    )"
  >
    <span :class="menuIndicator">
      <DropdownMenuItemIndicator>
        <CheckIcon class="h-3.5 w-3.5" />
      </DropdownMenuItemIndicator>
    </span>
    <slot />
  </DropdownMenuCheckboxItem>
</template>

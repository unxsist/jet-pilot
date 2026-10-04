<script setup lang="ts">
import {
  DropdownMenuItemIndicator,
  DropdownMenuRadioItem,
  type DropdownMenuRadioItemEmits,
  type DropdownMenuRadioItemProps,
  useEmitAsProps,
} from 'radix-vue'
import { DotFilledIcon } from '@radix-icons/vue'
import { cn } from '@/lib/utils'
import { menuIndicator, menuItem } from '@/components/ui/overlay-styles'

const props = defineProps<DropdownMenuRadioItemProps & { class?: string }>()

const emits = defineEmits<DropdownMenuRadioItemEmits>()
</script>

<template>
  <DropdownMenuRadioItem
    v-bind="{ ...props, ...useEmitAsProps(emits) }"
    :class="cn(
      menuItem,
      'pl-7',
      props.class,
    )"
  >
    <span :class="menuIndicator">

      <DropdownMenuItemIndicator>
        <DotFilledIcon class="h-3.5 w-3.5 fill-current" />
      </DropdownMenuItemIndicator>
    </span>
    <slot />
  </DropdownMenuRadioItem>
</template>

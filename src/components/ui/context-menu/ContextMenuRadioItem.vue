<script setup lang="ts">
import {
  ContextMenuItemIndicator,
  ContextMenuRadioItem,
  type ContextMenuRadioItemEmits,
  type ContextMenuRadioItemProps,
  useForwardPropsEmits,
} from 'radix-vue'
import { DotFilledIcon } from '@radix-icons/vue'
import { cn } from '@/lib/utils'
import { menuIndicator, menuItem } from '@/components/ui/overlay-styles'

const props = defineProps<ContextMenuRadioItemProps & { class?: string }>()
const emits = defineEmits<ContextMenuRadioItemEmits>()

const forwarded = useForwardPropsEmits(props, emits)
</script>

<template>
  <ContextMenuRadioItem
    v-bind="forwarded"
    :class="[
      cn(
        menuItem,
        'pl-7',
        props.class,
      ),
    ]"
  >
    <span :class="menuIndicator">
      <ContextMenuItemIndicator>
        <DotFilledIcon class="h-3.5 w-3.5 fill-current" />
      </ContextMenuItemIndicator>
    </span>
    <slot />
  </ContextMenuRadioItem>
</template>

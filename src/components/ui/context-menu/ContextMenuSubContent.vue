<script setup lang="ts">
import {
  ContextMenuSubContent,
  type DropdownMenuSubContentEmits,
  type DropdownMenuSubContentProps,
  useForwardPropsEmits,
} from 'radix-vue'
import { cn } from '@/lib/utils'
import { menuContent } from '@/components/ui/overlay-styles'

const props = defineProps<DropdownMenuSubContentProps & { class?: string }>()
const emits = defineEmits<DropdownMenuSubContentEmits>()

const forwarded = useForwardPropsEmits(props, emits)
</script>

<template>
  <ContextMenuSubContent
    v-bind="forwarded"
    :class="
      cn(
        menuContent,
        'shadow-lg',
        props.class,
      )
    "
  >
    <slot />
  </ContextMenuSubContent>
</template>

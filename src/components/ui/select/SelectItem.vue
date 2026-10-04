<script setup lang="ts">
import {
  SelectItem,
  SelectItemIndicator,
  type SelectItemProps,
  SelectItemText,
} from 'radix-vue'
import { CheckIcon } from '@radix-icons/vue'
import { cn } from '@/lib/utils'

const props = defineProps<SelectItemProps & { class?: string }>()
</script>

<template>
  <SelectItem
    v-bind="props"
    :class="
      cn(
        'relative flex min-h-[1.75rem] w-full cursor-default select-none items-center gap-2 rounded-[5px] py-1 pl-2 pr-7 text-sm outline-none transition-colors duration-75 focus:bg-accent focus:text-accent-foreground data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground data-[state=checked]:font-medium data-[disabled]:pointer-events-none data-[disabled]:opacity-50',
        props.class,
      )
    "
  >
    <span class="absolute right-2 flex h-3.5 w-3.5 items-center justify-center text-primary dark:text-link">
      <SelectItemIndicator>
        <CheckIcon class="h-3.5 w-3.5" />
      </SelectItemIndicator>
    </span>

    <SelectItemText>
      <slot />
    </SelectItemText>
  </SelectItem>
</template>

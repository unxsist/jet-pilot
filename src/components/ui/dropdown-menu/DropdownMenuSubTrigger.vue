<script setup lang="ts">
import {
  DropdownMenuSubTrigger,
  type DropdownMenuSubTriggerProps,
} from 'radix-vue'
import { ChevronRightIcon } from '@radix-icons/vue'
import { cn } from '@/lib/utils'
import { menuItem } from '@/components/ui/overlay-styles'

const props = defineProps<DropdownMenuSubTriggerProps & { class?: string }>()
</script>

<template>
  <DropdownMenuSubTrigger
    v-bind="props"
    :class="[
      cn(
        menuItem,
        'data-[state=open]:bg-accent data-[state=open]:text-accent-foreground',
        props.class,
      ),
    ]"
  >
    <slot />
    <!-- Shown on the highlighted / open row only: no column of chevrons -->
    <ChevronRightIcon
      class="ml-auto h-3.5 w-3.5 text-muted-foreground opacity-0 [[data-highlighted]_&]:opacity-100 [[data-state=open]>&]:opacity-100"
    />
  </DropdownMenuSubTrigger>
</template>

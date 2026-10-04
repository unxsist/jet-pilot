<script setup lang="ts">
import { SelectIcon, SelectTrigger, type SelectTriggerProps } from 'radix-vue'
import { ChevronDownIcon } from '@radix-icons/vue'
import { cn } from '@/lib/utils'
import { fieldBase } from '@/components/ui/input'

const props = withDefaults(
  defineProps<SelectTriggerProps & { class?: string; invalid?: boolean }>(),
  {
    class: '',
    invalid: false,
  },
)
</script>

<template>
  <SelectTrigger
    v-bind="props"
    :class="[
      cn(
        fieldBase,
        'flex h-8 items-center justify-between gap-2 whitespace-nowrap px-2.5 py-1 text-left focus:border-ring focus:outline-none focus:ring-[3px] focus:ring-ring/20 data-[placeholder]:text-muted-foreground data-[state=open]:border-ring data-[state=open]:ring-[3px] data-[state=open]:ring-ring/20 [&>span]:truncate',
        props.class,
      ),
      props.invalid
        ? '!border-destructive !ring-[3px] !ring-destructive/20'
        : '',
    ]"
  >
    <slot />
    <SelectIcon as-child>
      <ChevronDownIcon class="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
    </SelectIcon>
  </SelectTrigger>
</template>

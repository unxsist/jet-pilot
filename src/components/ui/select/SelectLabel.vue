<script setup lang="ts">
import { SelectLabel, type SelectLabelProps } from 'radix-vue'
import { cn } from '@/lib/utils'

const props = defineProps<SelectLabelProps & { class?: string }>()
</script>

<template>
  <SelectLabel :class="cn('px-2 pb-1 pt-1.5 text-xs font-medium text-muted-foreground', props.class)">
    <slot />
  </SelectLabel>
</template>

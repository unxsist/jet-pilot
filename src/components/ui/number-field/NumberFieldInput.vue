<script setup lang="ts">
import { NumberFieldInput } from 'radix-vue'
import type { HTMLAttributes } from 'vue'
import { cn } from '@/lib/utils'
import { fieldBase } from '@/components/ui/input'

const props = defineProps<{
  class?: HTMLAttributes['class']
}>()
</script>

<template>
  <NumberFieldInput
    data-slot="input"
    :class="cn(fieldBase, 'flex h-8 py-1 text-center tabular-nums', props.class)"
  />
</template>

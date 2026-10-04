<script setup lang="ts">
import type { NumberFieldIncrementProps } from 'radix-vue'
import { NumberFieldIncrement, useForwardProps } from 'radix-vue'
import { type HTMLAttributes, computed } from 'vue'
import { Plus } from 'lucide-vue-next'
import { cn } from '@/lib/utils'

const props = defineProps<NumberFieldIncrementProps & { class?: HTMLAttributes['class'] }>()

const delegatedProps = computed(() => {
  const { class: _, ...delegated } = props

  return delegated
})

const forwarded = useForwardProps(delegatedProps)
</script>

<template>
  <NumberFieldIncrement data-slot="increment" v-bind="forwarded" :class="cn('absolute top-1/2 -translate-y-1/2 right-0 flex h-6 w-6 items-center justify-center rounded-[5px] mx-1 text-muted-foreground transition-colors duration-fast hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-30', props.class)">
    <slot>
      <Plus class="h-3.5 w-3.5" />
    </slot>
  </NumberFieldIncrement>
</template>

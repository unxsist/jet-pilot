<script setup lang="ts">
import type { ComboboxContentEmits, ComboboxContentProps } from 'radix-vue'
import { ComboboxContent, useForwardPropsEmits } from 'radix-vue'
import { cn } from '@/lib/utils'

const props = defineProps<ComboboxContentProps>()
const emits = defineEmits<ComboboxContentEmits>()

const forwarded = useForwardPropsEmits(props, emits)
</script>

<template>
  <ComboboxContent v-bind="forwarded" :class="cn('max-h-[min(400px,60vh)] scroll-py-1.5 overflow-y-auto overflow-x-hidden p-1.5', $attrs.class ?? '')">
    <div role="presentation">
      <slot />
    </div>
  </ComboboxContent>
</template>

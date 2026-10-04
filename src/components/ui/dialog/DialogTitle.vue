<script setup lang="ts">
import { DialogTitle, type DialogTitleProps } from 'radix-vue'
import { cn } from '@/lib/utils'

const props = defineProps<DialogTitleProps & { class?: string }>()
</script>

<template>
  <DialogTitle
    v-bind="props"
    :class="
      cn(
        'text-base font-semibold leading-6 tracking-[-0.006em] text-foreground',
        props.class,
      )
    "
  >
    <slot />
  </DialogTitle>
</template>

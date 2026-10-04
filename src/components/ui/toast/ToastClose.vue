<script setup lang="ts">
import { ToastClose } from 'radix-vue'
import { Cross2Icon } from '@radix-icons/vue'
import { cn } from '@/lib/utils'

const props = defineProps<{
  class?: string
}>()
</script>

<template>
  <ToastClose v-bind="props" :class="cn('absolute right-2 top-2 inline-flex h-5 w-5 items-center justify-center rounded-[5px] text-muted-foreground opacity-0 transition-[opacity,background-color,color] duration-fast hover:bg-accent hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring group-hover:opacity-100', props.class)">
    <Cross2Icon class="h-3.5 w-3.5" />
  </ToastClose>
</template>

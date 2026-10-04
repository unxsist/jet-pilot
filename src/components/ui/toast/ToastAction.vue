<script setup lang="ts">
import { ToastAction, type ToastActionProps } from 'radix-vue'
import { cn } from '@/lib/utils'

const props = defineProps<ToastActionProps & { class?: string }>()
</script>

<template>
  <ToastAction v-bind="props" :class="cn('inline-flex h-7 shrink-0 items-center justify-center self-center rounded-md border border-input bg-background px-2.5 text-xs font-medium shadow-xs transition-colors duration-fast hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-50 group-[.destructive]:border-destructive/30 group-[.destructive]:text-destructive group-[.destructive]:hover:bg-destructive/10', props.class)">
    <slot />
  </ToastAction>
</template>

<script setup lang="ts">
import { ToastDescription, type ToastDescriptionProps } from 'radix-vue'
import { cn } from '@/lib/utils'

const props = defineProps<ToastDescriptionProps & { class?: string }>()
</script>

<template>
  <ToastDescription :class="cn('break-words text-sm leading-5 text-muted-foreground', props.class)" v-bind="props">
    <slot />
  </ToastDescription>
</template>

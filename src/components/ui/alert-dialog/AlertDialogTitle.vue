<script setup lang="ts">
import { AlertDialogTitle, type AlertDialogTitleProps } from 'radix-vue'
import { cn } from '@/lib/utils'

const props = defineProps<AlertDialogTitleProps & { class?: string }>()
</script>

<template>
  <AlertDialogTitle
    :as-child="props.asChild"
    :class="cn('text-base font-semibold leading-6 tracking-[-0.006em] text-foreground', props.class)"
  >
    <slot />
  </AlertDialogTitle>
</template>

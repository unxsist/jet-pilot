<script setup lang="ts">
import { cn } from '@/lib/utils'

interface DialogFooterProps {
  class?: string
}

const props = defineProps<DialogFooterProps>()
</script>

<template>
  <div
    :class="
      cn(
        'mt-1 flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-end',
        props.class,
      )
    "
  >
    <slot />
  </div>
</template>

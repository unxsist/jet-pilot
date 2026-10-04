<script setup lang="ts">
import { cn } from '@/lib/utils'

const props = defineProps({
  class: {
    type: String,
    default: '',
  },
})
</script>

<template>
  <div
    :class="
      cn(
        'mt-2 flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-end',
        props.class,
      )
    "
  >
    <slot />
  </div>
</template>

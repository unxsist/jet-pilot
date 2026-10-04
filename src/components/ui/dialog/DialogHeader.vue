<script setup lang="ts">
import { cn } from '@/lib/utils'

interface DialogHeaderProps {
  class?: string
}

const props = defineProps<DialogHeaderProps>()
</script>

<template>
  <div
    :class="cn('flex flex-col gap-1 pr-6 text-left', props.class)"
  >
    <slot />
  </div>
</template>

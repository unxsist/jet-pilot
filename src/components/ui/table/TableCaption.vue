<script setup lang="ts">
import { cn } from '@/lib/utils'

const props = defineProps<{ class?: string }>()
</script>

<template>
  <caption :class="cn('mt-3 text-xs text-muted-foreground', props.class)">
    <slot />
  </caption>
</template>

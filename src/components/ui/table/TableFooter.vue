<script setup lang="ts">
import { cn } from '@/lib/utils'

const props = defineProps<{ class?: string }>()
</script>

<template>
  <tfoot :class="cn('border-t bg-muted/40 font-medium [&>tr]:last:border-b-0', props.class)">
    <slot />
  </tfoot>
</template>

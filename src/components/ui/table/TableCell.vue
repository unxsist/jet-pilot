<script setup lang="ts">
import { cn } from '@/lib/utils'

// `numeric`: right-aligned tabular numerals (counts, ages, resources)
const props = defineProps<{ class?: string; numeric?: boolean }>()
</script>

<template>
  <td
    :class="
      cn(
        'px-2.5 py-1.5 align-middle [&:has([role=checkbox])]:pr-0 [&>[role=checkbox]]:translate-y-[2px]',
        props.numeric && 'text-right tabular-nums',
        props.class,
      )
    "
  >
    <slot />
  </td>
</template>

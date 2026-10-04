<script setup lang="ts">
import { cn } from '@/lib/utils'

interface SkeletonProps {
  class?: string
}

const props = defineProps<SkeletonProps>()
</script>

<template>
  <div :class="cn('relative overflow-hidden rounded-md bg-muted before:absolute before:inset-0 before:-translate-x-full before:animate-shimmer before:bg-gradient-to-r before:from-transparent before:via-foreground/[0.05] before:to-transparent', props.class)" />
</template>

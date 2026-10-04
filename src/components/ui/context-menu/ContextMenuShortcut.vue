<script setup lang="ts">
import { cn } from '@/lib/utils'
import { menuShortcut } from '@/components/ui/overlay-styles'
</script>

<template>
  <span :class="cn(menuShortcut, $attrs.class ?? '')">
    <slot />
  </span>
</template>

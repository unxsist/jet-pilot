<script setup lang="ts">
import { cn } from '@/lib/utils'
import { kbdVariants } from '@/components/ui/kbd'
</script>

<template>
  <span :class="cn(kbdVariants({ size: 'default' }), 'ml-auto', $attrs.class ?? '')">
    <slot />
  </span>
</template>

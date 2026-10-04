<script setup lang="ts">
import { cn } from '@/lib/utils'
</script>

<template>
  <h5 :class="cn('mb-0.5 font-medium leading-5', $attrs.class ?? '')">
    <slot />
  </h5>
</template>

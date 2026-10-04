<script setup lang="ts">
import { DropdownMenuTrigger, type DropdownMenuTriggerProps } from 'radix-vue'

const props = defineProps<DropdownMenuTriggerProps>()
</script>

<template>
  <DropdownMenuTrigger class="outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background" v-bind="props">
    <slot />
  </DropdownMenuTrigger>
</template>

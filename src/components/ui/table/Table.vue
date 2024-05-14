<script setup lang="ts">
import { cn } from "@/lib/utils";

const props = defineProps<{ class?: string }>();
</script>

<template>
  <table :class="cn('w-full caption-bottom text-sm', props.class)">
    <slot />
  </table>
</template>

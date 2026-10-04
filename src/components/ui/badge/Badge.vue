<script setup lang="ts">
import type { HTMLAttributes } from "vue";
import { cn } from "@/lib/utils";
import { type BadgeVariants, badgeVariants } from ".";

const props = defineProps<{
  variant?: BadgeVariants["variant"];
  size?: BadgeVariants["size"];
  class?: HTMLAttributes["class"];
}>();
</script>

<template>
  <div :class="cn(badgeVariants({ variant, size }), props.class)">
    <slot />
  </div>
</template>

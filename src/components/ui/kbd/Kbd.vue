<script setup lang="ts">
import type { HTMLAttributes } from "vue";
import { cn } from "@/lib/utils";
import { type KbdVariants, kbdVariants } from ".";

/**
 * Keyboard shortcut hint.
 *
 *   <Kbd>⌘</Kbd><Kbd>K</Kbd>
 *   <Kbd :keys="['⌘', 'K']" />
 */
const props = defineProps<{
  keys?: string[];
  variant?: KbdVariants["variant"];
  size?: KbdVariants["size"];
  class?: HTMLAttributes["class"];
}>();
</script>

<template>
  <span
    v-if="props.keys && props.keys.length > 0"
    :class="cn('inline-flex items-center gap-0.5', props.class)"
  >
    <kbd
      v-for="key in props.keys"
      :key="key"
      :class="kbdVariants({ variant, size })"
      >{{ key }}</kbd
    >
  </span>
  <kbd v-else :class="cn(kbdVariants({ variant, size }), props.class)"
    ><slot
  /></kbd>
</template>

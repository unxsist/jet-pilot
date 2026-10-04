<script setup lang="ts">
import type { HTMLAttributes } from "vue";
import { cn } from "@/lib/utils";
import { type StatusTone, statusDotClass } from "./tones";

/**
 * Small coloured dot for status columns, list rows and tab titles.
 * `pulse` adds a soft ping ring (use sparingly: live / in-progress states).
 */
const props = withDefaults(
  defineProps<{
    tone?: StatusTone;
    pulse?: boolean;
    size?: "sm" | "default";
    label?: string;
    class?: HTMLAttributes["class"];
  }>(),
  {
    tone: "muted",
    pulse: false,
    size: "default",
  }
);
</script>

<template>
  <span
    :class="
      cn(
        'relative inline-flex shrink-0',
        props.size === 'sm' ? 'h-1.5 w-1.5' : 'h-2 w-2',
        props.class
      )
    "
    :role="props.label ? 'img' : undefined"
    :aria-label="props.label"
    :aria-hidden="props.label ? undefined : 'true'"
  >
    <span
      v-if="props.pulse"
      :class="
        cn(
          'absolute inset-0 rounded-full opacity-60 animate-status-ping',
          statusDotClass[props.tone]
        )
      "
    />
    <span
      :class="
        cn(
          'relative inline-flex h-full w-full rounded-full',
          statusDotClass[props.tone]
        )
      "
    />
  </span>
</template>

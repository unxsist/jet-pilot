<script setup lang="ts">
import { computed, type HTMLAttributes } from "vue";
import { cn } from "@/lib/utils";
import StatusDot from "./StatusDot.vue";
import { type StatusTone, statusSoftClass, statusTone } from "./tones";

/**
 * Soft status pill with a leading dot.
 *
 *   <StatusBadge status="CrashLoopBackOff" />        // tone inferred
 *   <StatusBadge tone="warning">Draining</StatusBadge>
 */
const props = withDefaults(
  defineProps<{
    status?: string;
    tone?: StatusTone;
    dot?: boolean;
    pulse?: boolean;
    class?: HTMLAttributes["class"];
  }>(),
  {
    dot: true,
    pulse: false,
  }
);

const resolvedTone = computed<StatusTone>(
  () => props.tone ?? statusTone(props.status)
);
</script>

<template>
  <span
    :class="
      cn(
        'inline-flex h-5 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-2 text-xs font-medium leading-none',
        statusSoftClass[resolvedTone],
        props.class
      )
    "
  >
    <StatusDot
      v-if="props.dot"
      :tone="resolvedTone"
      :pulse="props.pulse"
      size="sm"
    />
    <slot>{{ props.status }}</slot>
  </span>
</template>

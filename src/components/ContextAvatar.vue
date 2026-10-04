<script setup lang="ts">
import type { HTMLAttributes } from "vue";
import { cn } from "@/lib/utils";
import { StatusDot, type StatusTone } from "@/components/ui/status";

/**
 * Square monogram for a kube context ("prod-eu-west-1" -> "PE"), tinted
 * with a hue derived from the name so clusters are recognisable at a glance.
 * An optional status dot sits on the corner.
 */
const props = withDefaults(
  defineProps<{
    name: string;
    size?: "sm" | "default";
    status?: StatusTone | null;
    class?: HTMLAttributes["class"];
  }>(),
  { size: "default", status: null }
);

const initials = computed(() => {
  // EKS / GKE context names are ARNs or paths: the cluster name is last.
  const base = (props.name || "?").split(/[/:]/).filter(Boolean).pop() || "?";
  const parts = base.split(/[-_.@\s]+/).filter(Boolean);
  const first = parts[0] || base;
  const second = parts[1]?.[0] ?? first[1] ?? "";
  return (first[0] + second).toUpperCase();
});

const hue = computed(() => {
  let hash = 0;
  for (const char of props.name || "") {
    hash = (hash * 31 + char.charCodeAt(0)) | 0;
  }
  return Math.abs(hash) % 360;
});
</script>

<template>
  <span
    :class="
      cn(
        'relative inline-flex shrink-0 select-none items-center justify-center rounded-md font-semibold leading-none tracking-tight',
        'bg-[hsl(var(--avatar-h)_70%_50%/0.14)] text-[hsl(var(--avatar-h)_60%_34%)] ring-1 ring-inset ring-[hsl(var(--avatar-h)_60%_50%/0.18)]',
        'dark:bg-[hsl(var(--avatar-h)_70%_60%/0.14)] dark:text-[hsl(var(--avatar-h)_80%_76%)]',
        props.size === 'sm' ? 'h-5 w-5 text-2xs' : 'h-8 w-8 text-xs',
        props.class
      )
    "
    :style="{ '--avatar-h': hue }"
    aria-hidden="true"
  >
    {{ initials }}
    <StatusDot
      v-if="props.status"
      :tone="props.status"
      :size="props.size === 'sm' ? 'sm' : 'default'"
      class="absolute -bottom-0.5 -right-0.5 rounded-full ring-2 ring-[hsl(var(--avatar-ring,var(--sidebar)))]"
    />
  </span>
</template>

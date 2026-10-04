<script setup lang="ts">
import type { Component, HTMLAttributes } from "vue";
import { cn } from "@/lib/utils";

/**
 * Centered placeholder for empty tables, lists and panels.
 *
 *   <EmptyState :icon="Inbox" title="No pods" description="Nothing is running in this namespace.">
 *     <template #action><Button size="sm">Create pod</Button></template>
 *   </EmptyState>
 *
 * Slots: `icon` (overrides the icon prop), `title`, default (description),
 * `action`.
 */
const props = withDefaults(
  defineProps<{
    icon?: Component;
    title?: string;
    description?: string;
    size?: "sm" | "default";
    class?: HTMLAttributes["class"];
  }>(),
  {
    size: "default",
  }
);
</script>

<template>
  <div
    :class="
      cn(
        'flex flex-col items-center justify-center text-center',
        props.size === 'sm' ? 'gap-2 px-4 py-6' : 'gap-3 px-6 py-12',
        props.class
      )
    "
  >
    <div
      v-if="props.icon || $slots.icon"
      :class="
        cn(
          'flex items-center justify-center rounded-lg border bg-surface-2 text-muted-foreground shadow-xs',
          props.size === 'sm' ? 'h-8 w-8 [&_svg]:h-4 [&_svg]:w-4' : 'mb-1 h-10 w-10 [&_svg]:h-5 [&_svg]:w-5'
        )
      "
    >
      <slot name="icon">
        <component :is="props.icon" />
      </slot>
    </div>
    <div class="flex max-w-sm flex-col gap-1">
      <p
        v-if="props.title || $slots.title"
        :class="
          cn(
            'font-medium text-foreground',
            props.size === 'sm' ? 'text-sm' : 'text-base'
          )
        "
      >
        <slot name="title">{{ props.title }}</slot>
      </p>
      <div
        v-if="props.description || $slots.default"
        class="text-balance text-sm text-muted-foreground"
      >
        <slot>{{ props.description }}</slot>
      </div>
    </div>
    <div v-if="$slots.action" class="mt-1 flex items-center gap-2">
      <slot name="action" />
    </div>
  </div>
</template>

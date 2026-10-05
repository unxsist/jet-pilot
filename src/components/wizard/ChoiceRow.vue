<script setup lang="ts">
/**
 * One option of a radio group as a calm row: the indicator, a title and one
 * quiet line, with room on the right (`end`) for a fact. Use inside a
 * radix-vue RadioGroupRoot (arrow keys move between rows).
 */
import { RadioGroupIndicator, RadioGroupItem } from "radix-vue";

defineProps<{ value: string; title: string; description?: string; disabled?: boolean }>();
</script>

<template>
  <RadioGroupItem
    :value="value"
    :disabled="disabled"
    class="group/choice flex w-full items-start gap-3 rounded-lg px-3 py-2.5 text-left outline-none transition-colors duration-fast hover:bg-accent/50 focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 data-[state=checked]:bg-primary/[0.06] data-[state=checked]:hover:bg-primary/[0.09]"
  >
    <span
      class="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border border-input bg-background shadow-xs transition-colors duration-fast group-hover/choice:border-border-strong group-data-[state=checked]/choice:border-primary group-data-[state=checked]/choice:bg-primary"
    >
      <RadioGroupIndicator class="h-1.5 w-1.5 rounded-full bg-primary-foreground" />
    </span>
    <span class="min-w-0 flex-1">
      <span class="block truncate text-sm font-medium text-foreground">{{ title }}</span>
      <span v-if="description || $slots.description" class="block text-xs text-muted-foreground">
        <slot name="description">{{ description }}</slot>
      </span>
    </span>
    <slot name="end" />
  </RadioGroupItem>
</template>

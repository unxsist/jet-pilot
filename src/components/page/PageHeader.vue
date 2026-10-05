<script setup lang="ts">
/**
 * The header of a page view (Clusters hub, Cloud accounts…): a title, one
 * quiet line under it, actions on the right and, optionally, tabs. Pages
 * are calm: one primary action, everything else a step away.
 */
defineProps<{ title: string; description?: string }>();
</script>

<template>
  <header class="space-y-5">
    <div class="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
      <div class="min-w-0 space-y-1">
        <h1 class="text-2xl font-semibold tracking-tight text-foreground">{{ title }}</h1>
        <p v-if="description || $slots.description" class="text-sm text-muted-foreground">
          <slot name="description">{{ description }}</slot>
        </p>
      </div>
      <div v-if="$slots.actions" class="flex shrink-0 items-center gap-2">
        <slot name="actions" />
      </div>
    </div>
    <slot name="tabs" />
  </header>
</template>

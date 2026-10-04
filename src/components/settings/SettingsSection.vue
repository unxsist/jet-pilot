<script setup lang="ts">
/**
 * Settings card: heading + description, rows separated by hairlines.
 * Rows use the `settingsRow` grid (label / description left, control right).
 */
defineProps<{
  title: string;
  description?: string;
}>();
</script>

<template>
  <section class="overflow-hidden rounded-lg border bg-card shadow-xs">
    <header class="flex items-start justify-between gap-4 border-b px-5 py-3.5">
      <div class="space-y-0.5">
        <h2 class="text-sm font-semibold text-foreground">{{ title }}</h2>
        <p v-if="description" class="text-xs text-muted-foreground">
          {{ description }}
        </p>
      </div>
      <slot name="actions" />
    </header>
    <div class="divide-y divide-border-subtle">
      <slot />
    </div>
  </section>
</template>

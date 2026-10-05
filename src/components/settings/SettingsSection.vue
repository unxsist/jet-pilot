<script setup lang="ts">
/**
 * A settings section: a quiet heading (and one line of description) over a
 * hairline, then its rows separated by subtle dividers. No card: sections
 * are set apart by space. Actions sit right of the heading.
 */
defineProps<{
  title: string;
  description?: string;
}>();
</script>

<template>
  <section>
    <header class="flex min-h-9 items-end justify-between gap-4 border-b pb-2.5">
      <div class="min-w-0 space-y-0.5">
        <h2 class="text-sm font-medium text-foreground">{{ title }}</h2>
        <p v-if="description" class="text-xs text-muted-foreground">
          {{ description }}
        </p>
      </div>
      <div v-if="$slots.actions" class="-mb-0.5 flex shrink-0 items-center gap-1">
        <slot name="actions" />
      </div>
    </header>
    <div class="divide-y divide-border-subtle">
      <slot />
    </div>
  </section>
</template>

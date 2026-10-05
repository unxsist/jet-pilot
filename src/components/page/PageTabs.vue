<script setup lang="ts" generic="T extends string">
/**
 * Text tabs under a page title: the active one is underlined. Counts are
 * optional and quiet.
 */
defineProps<{ tabs: readonly { id: T; label: string; count?: number | null }[]; label: string }>();
const active = defineModel<T>({ required: true });
</script>

<template>
  <div class="flex items-center gap-6 border-b" role="tablist" :aria-label="label">
    <button
      v-for="tab in tabs"
      :key="tab.id"
      type="button"
      role="tab"
      :aria-selected="active === tab.id"
      class="-mb-px flex h-9 items-center gap-1.5 border-b-2 text-sm transition-colors duration-fast focus-ring"
      :class="
        active === tab.id
          ? 'border-foreground font-medium text-foreground'
          : 'border-transparent text-muted-foreground hover:text-foreground'
      "
      @click="active = tab.id"
    >
      {{ tab.label }}
      <span v-if="tab.count" class="tabular-nums text-muted-foreground">{{ tab.count }}</span>
    </button>
  </div>
</template>

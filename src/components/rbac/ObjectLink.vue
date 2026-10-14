<script setup lang="ts">
/**
 * A named RBAC object in running text ("ClusterRole admin"): the kind is
 * quiet, the name is the link. Without an object (it doesn't exist) it's
 * plain text with a warning.
 */
defineProps<{ kind: string; name: string; object?: unknown | null; missing?: boolean }>();
const emit = defineEmits<{ open: [] }>();
</script>

<template>
  <span class="inline-flex min-w-0 items-baseline gap-1">
    <span class="shrink-0 text-muted-foreground">{{ kind }}</span>
    <button
      v-if="object"
      type="button"
      class="truncate rounded-sm font-medium text-foreground underline-offset-2 transition-colors duration-fast hover:text-link hover:underline focus-ring"
      :title="`Open ${kind} ${name}`"
      @click.stop="emit('open')"
    >
      {{ name }}
    </button>
    <span v-else class="truncate font-medium" :class="missing ? 'text-warning' : 'text-foreground'" :title="missing ? `${kind} ${name} doesn't exist` : undefined">
      {{ name }}
    </span>
  </span>
</template>

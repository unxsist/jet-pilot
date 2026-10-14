<script setup lang="ts">
/**
 * One row of a `<dl class="operator-fields">` list: a quiet label and its
 * value (text or slot). Rendered only when there is something to show.
 */
defineProps<{
  label: string;
  value?: string | number | null;
  /** Values people copy (ids, addresses). */
  mono?: boolean;
}>();
</script>

<template>
  <div v-if="$slots.default || (value !== undefined && value !== null && value !== '')" class="contents">
    <dt class="pt-px text-muted-foreground">{{ label }}</dt>
    <dd class="min-w-0 select-text break-words" :class="mono ? 'break-all font-mono text-[11px] leading-5' : ''">
      <slot>{{ value }}</slot>
    </dd>
  </div>
</template>

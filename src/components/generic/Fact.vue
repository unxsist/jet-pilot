<script setup lang="ts">
/**
 * One line of a <FactList>: a label and its value (the slot, or `value`).
 * `mono` for things people copy (IPs, images); `muted` for "none" values.
 */
defineProps<{
  label: string;
  value?: string | number | null;
  mono?: boolean;
  muted?: boolean;
  title?: string;
}>();
</script>

<template>
  <div class="contents">
    <dt class="text-xs text-muted-foreground">{{ label }}</dt>
    <dd
      class="min-w-0 break-words text-sm leading-5 select-text"
      :class="[mono ? 'font-mono text-xs' : '', muted ? 'text-muted-foreground' : 'text-foreground']"
      :title="title"
    >
      <slot>{{ value ?? "–" }}</slot>
    </dd>
  </div>
</template>

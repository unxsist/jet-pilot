<script setup lang="ts">
/**
 * The footer of a calm dialog: Back or a quiet hint on the left (`start`),
 * the actions on the right with the one primary last.
 */
</script>

<template>
  <footer class="flex min-h-[3.75rem] shrink-0 items-center gap-2 border-t bg-surface-1/70 px-6 py-3">
    <div class="flex min-w-0 flex-1 items-center gap-2">
      <slot name="start" />
    </div>
    <div v-if="$slots.default" class="flex shrink-0 items-center gap-2">
      <slot />
    </div>
  </footer>
</template>

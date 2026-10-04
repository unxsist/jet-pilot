<script setup lang="ts">
/* Lists the objects a confirmation dialog is about to act on. */
defineProps<{ lines: string[] }>();
</script>
<template>
  <ul
    class="max-h-48 overflow-auto rounded-md border bg-muted/50 px-3 py-2 text-sm font-mono space-y-0.5"
  >
    <li v-for="(line, index) in lines" :key="index" class="truncate" :title="line">
      {{ line }}
    </li>
  </ul>
</template>

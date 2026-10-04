<script setup lang="ts">
import { Loader2 } from "lucide-vue-next";

withDefaults(
  defineProps<{
    label: string;
  }>(),
  {
    label: "Loading…",
  }
);
</script>
<template>
  <div
    class="flex h-full w-full flex-col items-center justify-center gap-2.5 text-sm text-muted-foreground"
    role="status"
  >
    <Loader2 class="h-5 w-5 animate-spin text-primary" aria-hidden="true" />
    <span>{{ label }}</span>
  </div>
</template>

<script setup lang="ts">
import KindIcon from "@/components/KindIcon.vue";

/* Icon of a tab type (edit, describe, logs, shell, ...). */
defineProps<{ name: string }>();
</script>

<template>
  <KindIcon :name="name" class="h-3.5 w-3.5" />
</template>

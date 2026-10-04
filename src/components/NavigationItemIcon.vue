<script setup lang="ts">
import KindIcon from "@/components/KindIcon.vue";

/* Icon for a resource kind / navigation entry (see @/lib/kindIcons). */
defineProps<{ name: string }>();
</script>

<template>
  <KindIcon :name="name" />
</template>

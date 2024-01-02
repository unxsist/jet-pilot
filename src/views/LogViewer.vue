<script setup lang="ts">
const props = defineProps<{
  context: string;
  namespace: string;
  pod: string;
}>();
</script>
<template>
  <div>Logs for {{ props }}</div>
</template>

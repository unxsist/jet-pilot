<script setup lang="ts">
defineProps<{
  pod: any;
}>();
</script>
<template>Pod Details {{ pod.metadata.name }}</template>

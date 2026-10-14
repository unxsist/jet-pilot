<script setup lang="ts">
import MonitorDetails from "@/components/operators/MonitorDetails.vue";

defineProps<{ resource: any }>();
</script>

<template>
  <MonitorDetails :resource="resource" />
</template>

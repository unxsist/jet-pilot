<script setup lang="ts">
import RouteDetails from "@/components/operators/RouteDetails.vue";

defineProps<{ resource: any }>();
</script>

<template>
  <RouteDetails :resource="resource" />
</template>

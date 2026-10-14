<script setup lang="ts">
import StoreDetails from "@/components/operators/StoreDetails.vue";

defineProps<{ resource: any }>();
</script>

<template>
  <StoreDetails :resource="resource" />
</template>

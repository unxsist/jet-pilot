<script setup lang="ts">
import ScalingDetails from "@/components/operators/ScalingDetails.vue";

defineProps<{ resource: any }>();
</script>

<template>
  <ScalingDetails :resource="resource" />
</template>

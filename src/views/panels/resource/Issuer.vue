<script setup lang="ts">
import IssuerDetails from "@/components/operators/IssuerDetails.vue";

defineProps<{ resource: any }>();
</script>

<template>
  <IssuerDetails :resource="resource" />
</template>

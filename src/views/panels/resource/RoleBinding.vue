<script setup lang="ts">
import BindingPanel from "@/components/rbac/BindingPanel.vue";
import type { BindingObject } from "@/lib/rbac";

defineProps<{ resource: BindingObject }>();
</script>

<template>
  <BindingPanel :resource="resource" />
</template>

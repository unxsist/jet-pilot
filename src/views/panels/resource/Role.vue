<script setup lang="ts">
import RolePanel from "@/components/rbac/RolePanel.vue";
import type { RoleObject } from "@/lib/rbac";

defineProps<{ resource: RoleObject }>();
</script>

<template>
  <RolePanel :resource="resource" />
</template>

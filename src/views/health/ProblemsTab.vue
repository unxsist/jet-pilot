<script setup lang="ts">
import { EmptyState } from "@/components/ui/empty-state";
import type { HealthTarget } from "@/lib/health/tabs";

defineProps<{ targets: HealthTarget[] }>();
</script>

<template>
  <EmptyState title="Nothing is broken" description="Problems on the active clusters show up here, with what caused them and how to fix them." />
</template>

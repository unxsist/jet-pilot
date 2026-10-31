<script setup lang="ts">
import { EmptyState } from "@/components/ui/empty-state";
import type { HealthTarget } from "@/lib/health/tabs";

defineProps<{ targets: HealthTarget[] }>();
</script>

<template>
  <EmptyState title="No risks found" description="Things that aren't broken yet but will hurt, like a workload without limits or a certificate about to expire." />
</template>

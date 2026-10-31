<script setup lang="ts">
import { EmptyState } from "@/components/ui/empty-state";
import type { HealthTarget } from "@/lib/health/tabs";

defineProps<{ targets: HealthTarget[] }>();
</script>

<template>
  <EmptyState title="Ready for the next version" description="Deprecated APIs, versions out of support and add-ons to update before a cluster upgrade show up here." />
</template>

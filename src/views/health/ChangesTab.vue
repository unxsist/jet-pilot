<script setup lang="ts">
import { EmptyState } from "@/components/ui/empty-state";
import type { HealthTarget } from "@/lib/health/tabs";

defineProps<{ targets: HealthTarget[] }>();
</script>

<template>
  <EmptyState title="No recent changes" description="What changed on the active clusters, newest first." />
</template>

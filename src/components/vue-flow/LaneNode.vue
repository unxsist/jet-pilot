<script setup lang="ts">
defineOptions({ inheritAttrs: false });
import { FolderTree, Globe } from "lucide-vue-next";
import { CLUSTER_NAMESPACE } from "@/lib/clusterGraph";

/* Namespace label above a lane of application groups. */
defineProps<{
  data: { namespace: string; apps: number };
}>();
</script>

<template>
  <div
    class="graph-lane flex h-full items-center gap-2 whitespace-nowrap text-muted-foreground"
  >
    <Globe
      v-if="data.namespace === CLUSTER_NAMESPACE"
      class="h-3.5 w-3.5 shrink-0"
    />
    <FolderTree v-else class="h-3.5 w-3.5 shrink-0" />
    <span class="graph-lane__title text-xs font-semibold uppercase tracking-wider">
      {{ data.namespace === CLUSTER_NAMESPACE ? "Cluster" : data.namespace }}
    </span>
    <span v-if="data.apps > 0" class="text-xs tabular-nums"
      >· {{ data.apps }} app{{ data.apps === 1 ? "" : "s" }}</span
    >
  </div>
</template>

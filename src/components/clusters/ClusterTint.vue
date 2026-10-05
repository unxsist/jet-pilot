<script setup lang="ts">
/**
 * A thin bar in the colour of the primary cluster across the top of the
 * content, so it's always clear where commands go. Shown when the cluster
 * has a colour, or is protected (then in the destructive tone).
 */
import { KubeContextStateKey } from "@/providers/KubeContextProvider";
import { injectStrict } from "@/lib/utils";
import { useClusters } from "@/lib/clusters/useClusters";

const { context, kubeConfig } = injectStrict(KubeContextStateKey);
const clusters = useClusters();

const cluster = computed(() => (context.value ? clusters.resolve(context.value, kubeConfig.value) : null));
const background = computed(() => {
  const c = cluster.value;
  if (!c) return null;
  if (c.color === "gray") return "hsl(220 8% 55%)";
  if (c.color) return `hsl(${c.hue} 75% 55%)`;
  if (c.protected) return "hsl(var(--destructive))";
  return null;
});
</script>

<template>
  <div
    v-if="background"
    class="pointer-events-none absolute inset-x-0 top-0 z-10 h-0.5"
    :style="{ background }"
    :title="cluster?.displayName"
    aria-hidden="true"
  />
</template>

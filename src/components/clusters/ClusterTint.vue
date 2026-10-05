<script setup lang="ts">
/**
 * The primary cluster's colour on the content canvas, so it's always clear
 * where commands go: a thin bar across the top when the cluster has a
 * colour, and for protected clusters (in the destructive tone unless it has
 * a colour) also a faint frame and a soft glow from the top edge.
 */
import { KubeContextStateKey } from "@/providers/KubeContextProvider";
import { injectStrict } from "@/lib/utils";
import { useClusters } from "@/lib/clusters/useClusters";

const { context, kubeConfig } = injectStrict(KubeContextStateKey);
const clusters = useClusters();

const cluster = computed(() => (context.value ? clusters.resolve(context.value, kubeConfig.value) : null));
/* The colour as an HSL triplet, so the frame and glow can add alpha. */
const tint = computed(() => {
  const c = cluster.value;
  if (!c) return null;
  if (c.color === "gray") return "220 8% 55%";
  if (c.color) return `${c.hue} 75% 55%`;
  if (c.protected) return "var(--destructive)";
  return null;
});
</script>

<template>
  <div
    v-if="tint"
    class="pointer-events-none absolute inset-0 z-10 rounded-[inherit]"
    :style="
      cluster?.protected
        ? {
            boxShadow: `inset 0 0 0 1px hsl(${tint} / 0.28)`,
            background: `linear-gradient(hsl(${tint} / 0.035), transparent 4.5rem)`,
          }
        : undefined
    "
    aria-hidden="true"
  >
    <div class="h-0.5" :style="{ background: `hsl(${tint})` }" />
  </div>
</template>

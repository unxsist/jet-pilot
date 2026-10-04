<script setup lang="ts">
import { KubernetesObject } from "@kubernetes/client-node";
import NavigationItemIcon from "../NavigationItemIcon.vue";
import { StatusDot } from "@/components/ui/status";
import { formatResourceKind } from "@/lib/utils";
import { podTone } from "./nodeStatus";

const props = defineProps<{
  data: {
    label: string;
    kubeObject: KubernetesObject;
    pods: any[];
  };
}>();

const unhealthy = computed(
  () =>
    props.data.pods.filter((pod) =>
      ["warning", "destructive"].includes(podTone(pod))
    ).length
);
</script>

<template>
  <div
    class="flex items-center gap-1.5 border-b border-border-subtle bg-surface-1 px-2 py-1.5 text-xs"
  >
    <NavigationItemIcon
      :name="formatResourceKind(data.kubeObject.kind || '').toLowerCase()"
      class="h-3.5 w-3.5 text-muted-foreground"
    />
    <span class="flex-1 truncate font-medium text-foreground"
      >{{ data.pods.length }} {{ data.label }}</span
    >
    <span
      v-if="unhealthy > 0"
      class="text-2xs tabular-nums text-warning"
      :title="`${unhealthy} not running`"
      >{{ unhealthy }} !</span
    >
  </div>
  <div class="flex flex-wrap gap-1.5 p-2">
    <StatusDot
      v-for="pod in data.pods"
      :key="pod.metadata?.uid || pod.metadata?.name"
      :tone="podTone(pod)"
      :label="pod.metadata?.name"
      :title="pod.metadata?.name"
    />
  </div>
</template>

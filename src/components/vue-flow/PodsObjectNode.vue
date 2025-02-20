<script setup lang="ts">
import { KubernetesObject } from "@kubernetes/client-node";
import NavigationItemIcon from "../NavigationItemIcon.vue";
import { formatResourceKind } from "@/lib/utils";

const props = defineProps<{
  data: {
    label: string;
    kubeObject: KubernetesObject;
    pods: any[];
  };
}>();
</script>

<template>
  <div class="bg-muted border-b p-1 px-2 text-foreground/75 text-xs">
    <div class="flex items-center space-x-2 truncate">
      <NavigationItemIcon
        :name="formatResourceKind(data.kubeObject.kind).toLowerCase()"
      />
      <div class="space-x-0.5">
        <span class="font-bold">{{ data.pods.length }} {{ data.label }}</span>
      </div>
    </div>
  </div>
</template>

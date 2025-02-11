<script setup lang="ts">
import { KubernetesObject } from "@kubernetes/client-node";
import NavigationItemIcon from "../NavigationItemIcon.vue";
import { formatResourceKind } from "@/lib/utils";

const props = defineProps<{
  data: {
    label: string;
    kubeObject: KubernetesObject;
  };
}>();
</script>

<template>
  <div class="bg-muted border-b p-1 px-2 text-white/75 text-xs">
    <div class="flex items-center space-x-2 truncate">
      <NavigationItemIcon
        :name="formatResourceKind(data.kubeObject.kind).toLowerCase()"
      />
      <div class="space-x-0.5">
        <span>{{ data.kubeObject.kind }}:</span>
        <span class="font-bold">{{ data.label }}</span>
      </div>
    </div>
  </div>
</template>

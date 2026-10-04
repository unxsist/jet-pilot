<script setup lang="ts">
import { KubernetesObject } from "@kubernetes/client-node";
import NavigationItemIcon from "../NavigationItemIcon.vue";
import { StatusDot } from "@/components/ui/status";
import { formatResourceKind } from "@/lib/utils";
import { graphNodeTone } from "./nodeStatus";

const props = defineProps<{
  data: {
    label: string;
    kubeObject: KubernetesObject;
  };
}>();

const tone = computed(() => graphNodeTone(props.data.kubeObject));
</script>

<template>
  <div
    class="flex items-center gap-1.5 border-b border-border-subtle bg-surface-1 px-2 py-1.5 text-xs"
  >
    <NavigationItemIcon
      :name="formatResourceKind(data.kubeObject.kind || '').toLowerCase()"
      class="h-3.5 w-3.5 text-muted-foreground"
    />
    <div class="flex min-w-0 flex-1 flex-col leading-tight">
      <span class="truncate text-2xs text-muted-foreground">{{
        data.kubeObject.kind
      }}</span>
      <span v-if="data.label" class="truncate font-medium text-foreground">{{
        data.label
      }}</span>
    </div>
    <StatusDot v-if="tone" :tone="tone" />
  </div>
</template>

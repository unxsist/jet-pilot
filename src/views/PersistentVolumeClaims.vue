<script setup lang="ts">
import { injectStrict } from "@/lib/utils";
import { V1PersistentVolumeClaim } from "@kubernetes/client-node";
import { Kubernetes } from "@/services/Kubernetes";
import { ref, h } from "vue";
import { useToast, ToastAction } from "@/components/ui/toast";

import { KubeContextStateKey } from "@/providers/KubeContextProvider";
const { context, namespace } = injectStrict(KubeContextStateKey);

import DataTable from "@/components/ui/DataTable.vue";
import { columns } from "@/components/tables/persistentvolumeclaims";
import { useDataRefresher } from "@/composables/refresher";

const { toast } = useToast();
const pvcs = ref<V1PersistentVolumeClaim[]>([]);

async function getPersistentVolumeClaims(refresh: boolean = false) {
  if (!refresh) {
    pvcs.value = [];
  }

  Kubernetes.getPersistentVolumeClaims(
    context.value,
    namespace.value === "all" ? "" : namespace.value
  )
    .then((results: V1PersistentVolumeClaim[]) => {
      pvcs.value = results;
    })
    .catch((error) => {
      toast({
        title: "An error occured",
        description: error.message,
        variant: "destructive",
        action: h(
          ToastAction,
          { altText: "Retry", onClick: () => startRefreshing() },
          { default: () => "Retry" }
        ),
      });
      stopRefreshing();
    });
}

const { startRefreshing, stopRefreshing } = useDataRefresher(
  getPersistentVolumeClaims,
  1000,
  [context, namespace]
);
</script>
x
<template>
  <DataTable :data="pvcs" :columns="columns" />
</template>
@/components/tables/persistentvolumeclaims/persistentvolumeclaims

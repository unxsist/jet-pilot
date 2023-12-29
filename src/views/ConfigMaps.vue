<script setup lang="ts">
import { injectStrict } from "@/lib/utils";
import { V1ConfigMap } from "@kubernetes/client-node";
import { Kubernetes } from "@/services/Kubernetes";
import { ref, h } from "vue";
import { useToast, ToastAction } from "@/components/ui/toast";

import { KubeContextStateKey } from "@/providers/KubeContextProvider";
const { context, namespace } = injectStrict(KubeContextStateKey);

import DataTable from "@/components/ui/DataTable.vue";
import { columns } from "@/components/tables/configmaps";
import { useDataRefresher } from "@/composables/refresher";

const { toast } = useToast();
const configmaps = ref<V1ConfigMap[]>([]);

async function getConfigMaps(refresh: boolean = false) {
  if (!refresh) {
    configmaps.value = [];
  }

  Kubernetes.getConfigMaps(
    context.value,
    namespace.value === "all" ? "" : namespace.value
  )
    .then((results: V1ConfigMap[]) => {
      configmaps.value = results;
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
  getConfigMaps,
  1000,
  [context, namespace]
);
</script>
x
<template>
  <DataTable :data="configmaps" :columns="columns" />
</template>
@/components/tables/configmaps/configmaps

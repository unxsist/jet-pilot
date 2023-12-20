<script setup lang="ts">
import { injectStrict } from "@/lib/utils";
import { V1Deployment } from "@kubernetes/client-node";
import { Kubernetes } from "@/services/Kubernetes";
import { ref, h } from "vue";
import { useToast, ToastAction } from "@/components/ui/toast";

import { KubeContextStateKey } from "@/providers/KubeContextProvider";
const { context, namespace } = injectStrict(KubeContextStateKey);

import DataTable from "@/components/ui/DataTable.vue";
import { columns } from "@/components/tables/deployments/columns";
import { useDataRefresher } from "@/composables/refresher";

const { toast } = useToast();
const deployments = ref<V1Deployment[]>([]);

async function getDeployments(refresh: boolean = false) {
  if (!refresh) {
    deployments.value = [];
  }

  Kubernetes.getDeployments(
    context.value,
    namespace.value === "all" ? "" : namespace.value
  )
    .then((results: V1Deployment[]) => {
      deployments.value = results;
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
  getDeployments,
  1000,
  [context, namespace]
);
</script>
<template>
  <DataTable :data="deployments" :columns="columns" />
</template>

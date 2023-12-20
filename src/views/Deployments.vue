<script setup lang="ts">
import { injectStrict } from "@/lib/utils";
import { V1Deployment, V1Pod } from "@kubernetes/client-node";
import { Kubernetes } from "@/services/Kubernetes";
import { ref } from "vue";
import { useToast } from "@/components/ui/toast";

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
      });
    });
}

useDataRefresher(getDeployments, 1000, [context, namespace]);
</script>
<template>
  <DataTable :data="deployments" :columns="columns" />
</template>

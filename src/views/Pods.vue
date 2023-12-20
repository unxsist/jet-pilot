<script setup lang="ts">
import { injectStrict } from "@/lib/utils";
import { V1Pod } from "@kubernetes/client-node";
import { Kubernetes } from "@/services/Kubernetes";
import { ref } from "vue";
import { useToast } from "@/components/ui/toast";

import { KubeContextStateKey } from "@/providers/KubeContextProvider";
const { context, namespace } = injectStrict(KubeContextStateKey);

import DataTable from "@/components/ui/DataTable.vue";
import { columns } from "@/components/tables/pods/columns";
import { useDataRefresher } from "@/composables/refresher";

const { toast } = useToast();
const pods = ref<V1Pod[]>([]);

async function getPods(refresh: boolean = false) {
  if (!refresh) {
    pods.value = [];
  }

  Kubernetes.getPods(
    context.value,
    namespace.value === "all" ? "" : namespace.value
  )
    .then((results: V1Pod[]) => {
      pods.value = results;
    })
    .catch((error) => {
      toast({
        title: "An error occured",
        description: error.message,
        variant: "destructive",
      });
    });
}

useDataRefresher(getPods, 1000, [context, namespace]);
</script>
<template>
  <DataTable :data="pods" :columns="columns" />
</template>

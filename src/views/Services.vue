<script setup lang="ts">
import { injectStrict } from "@/lib/utils";
import { V1Service } from "@kubernetes/client-node";
import { Kubernetes } from "@/services/Kubernetes";
import { ref, h } from "vue";
import { useToast, ToastAction } from "@/components/ui/toast";

import { KubeContextStateKey } from "@/providers/KubeContextProvider";
const { context, namespace } = injectStrict(KubeContextStateKey);

import DataTable from "@/components/ui/DataTable.vue";
import { columns } from "@/components/tables/services";
import { useDataRefresher } from "@/composables/refresher";

const { toast } = useToast();
const services = ref<V1Service[]>([]);

async function getServices(refresh: boolean = false) {
  if (!refresh) {
    services.value = [];
  }

  Kubernetes.getServices(
    context.value,
    namespace.value === "all" ? "" : namespace.value
  )
    .then((results: V1Service[]) => {
      services.value = results;
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
  getServices,
  1000,
  [context, namespace]
);
</script>
<template>
  <DataTable :data="services" :columns="columns" />
</template>
@/components/tables/services/services

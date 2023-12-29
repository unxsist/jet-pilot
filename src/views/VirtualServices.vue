<script setup lang="ts">
import { injectStrict } from "@/lib/utils";
import { VirtualService } from "@kubernetes-models/istio/networking.istio.io/v1beta1";
import { Kubernetes } from "@/services/Kubernetes";
import { ref, h } from "vue";
import { useToast, ToastAction } from "@/components/ui/toast";

import { KubeContextStateKey } from "@/providers/KubeContextProvider";
const { context, namespace } = injectStrict(KubeContextStateKey);

import DataTable from "@/components/ui/DataTable.vue";
import { columns } from "@/components/tables/virtualservices";
import { useDataRefresher } from "@/composables/refresher";

const { toast } = useToast();
const virtualServices = ref<VirtualService[]>([]);

async function getVirtualServices(refresh: boolean = false) {
  if (!refresh) {
    virtualServices.value = [];
  }

  Kubernetes.getVirtualServices(
    context.value,
    namespace.value === "all" ? "" : namespace.value
  )
    .then((results: VirtualService[]) => {
      virtualServices.value = results;
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
  getVirtualServices,
  1000,
  [context, namespace]
);
</script>
<template>
  <DataTable :data="virtualServices" :columns="columns" />
</template>
@/components/tables/virtualservices/virtualservices

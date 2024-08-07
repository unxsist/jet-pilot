<script setup lang="ts">
import { injectStrict } from "@/lib/utils";
import { V1Ingress } from "@kubernetes/client-node";
import { Kubernetes } from "@/services/Kubernetes";
import { ref, h } from "vue";
import { useToast, ToastAction } from "@/components/ui/toast";

import { KubeContextStateKey } from "@/providers/KubeContextProvider";
const { context, namespace, kubeConfig } = injectStrict(KubeContextStateKey);

import DataTable from "@/components/ui/VirtualDataTable.vue";
import { columns } from "@/components/tables/ingresses";
import { useDataRefresher } from "@/composables/refresher";

const { toast } = useToast();
const ingresses = ref<V1Ingress[]>([]);

import { RowAction, getDefaultActions } from "@/components/tables/types";
import { TabProviderAddTabKey } from "@/providers/TabProvider";
const addTab = injectStrict(TabProviderAddTabKey);

import { DialogProviderSpawnDialogKey } from "@/providers/DialogProvider";
const spawnDialog = injectStrict(DialogProviderSpawnDialogKey);

const rowActions: RowAction<V1Ingress>[] = [
  ...getDefaultActions<V1Ingress>(
    addTab,
    spawnDialog,
    context.value,
    kubeConfig.value
  ),
];

async function getIngresses(refresh: boolean = false) {
  if (!refresh) {
    ingresses.value = [];
  }

  Kubernetes.getIngresses(
    context.value,
    namespace.value === "all" ? "" : namespace.value
  )
    .then((results: V1Ingress[]) => {
      ingresses.value = results;
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
  getIngresses,
  1000,
  [context, namespace]
);
</script>
<template>
  <DataTable :data="ingresses" :columns="columns" :row-actions="rowActions" />
</template>

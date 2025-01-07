<script setup lang="ts">
import { injectStrict } from "@/lib/utils";
import { V1Service } from "@kubernetes/client-node";
import { Kubernetes } from "@/services/Kubernetes";
import { ref, h } from "vue";
import { useToast, ToastAction } from "@/components/ui/toast";

import { KubeContextStateKey } from "@/providers/KubeContextProvider";
const { context, namespace, kubeConfig } = injectStrict(KubeContextStateKey);

import DataTable from "@/components/ui/VirtualDataTable.vue";
import { columns } from "@/components/tables/services";
import { useDataRefresher } from "@/composables/refresher";

const { toast } = useToast();
const services = ref<V1Service[]>([]);

import { RowAction, getDefaultActions } from "@/components/tables/types";
import { TabProviderAddTabKey } from "@/providers/TabProvider";
const addTab = injectStrict(TabProviderAddTabKey);

import { DialogProviderSpawnDialogKey } from "@/providers/DialogProvider";
const spawnDialog = injectStrict(DialogProviderSpawnDialogKey);

const rowActions: RowAction<V1Service>[] = [
  ...getDefaultActions<V1Service>(
    addTab,
    spawnDialog,
    context.value,
    kubeConfig.value
  ),
  {
    label: "Port Forward",
    handler: (row) => {
      spawnDialog({
        title: "Port Forward",
        message: "Forward ports from the pod to your local machine",
        component: defineAsyncComponent(
          () => import("@/views/dialogs/PortForward.vue")
        ),
        props: {
          context: context.value,
          namespace: row.metadata?.namespace ?? namespace.value,
          kubeConfig: kubeConfig.value,
          object: row,
        },
        buttons: [],
      });
    },
  },
];

import { useRoute } from "vue-router";
const route = useRoute();
const rowClasses = (row: any) => {
  if (route.query.uid) {
    return row.metadata.uid === route.query.uid
      ? "animate-pulse-highlight-once"
      : "";
  }

  return "";
};

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

const create = () => {
  addTab(
    `create_` + Math.random().toString(36).substring(7),
    `New Secret`,
    defineAsyncComponent(() => import("@/views/ObjectEditor.vue")),
    {
      context: context,
      namespace: namespace.value === "all" ? "" : namespace,
      kubeConfig: kubeConfig,
      create: true,
      type: "service",
      useKubeCtl: false,
    },
    "edit"
  );
};
</script>
<template>
  <DataTable
    :data="services"
    :columns="columns"
    :allow-filter="true"
    :sticky-headers="true"
    :row-actions="rowActions"
    :row-classes="rowClasses"
  >
    <template #action-buttons>
      <button
        class="transition-all ml-2 hover:opacity-100 opacity-50 z-50 rounded-full w-9 h-9 flex items-center justify-center bg-primary text-white text-lg"
        @click="create"
      >
        +
      </button>
    </template>
  </DataTable>
</template>

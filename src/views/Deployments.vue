<script setup lang="ts">
import { injectStrict } from "@/lib/utils";
import { V1Deployment } from "@kubernetes/client-node";
import { Kubernetes } from "@/services/Kubernetes";
import { ref, h } from "vue";
import { useToast, ToastAction } from "@/components/ui/toast";

import { KubeContextStateKey } from "@/providers/KubeContextProvider";
const { context, namespace } = injectStrict(KubeContextStateKey);

import { SettingsContextStateKey } from "@/providers/SettingsContextProvider";
const { settings } = injectStrict(SettingsContextStateKey);

import { TabProviderAddTabKey } from "@/providers/TabProvider";
const addTab = injectStrict(TabProviderAddTabKey);

import {
  BaseDialogInterface,
  DialogProviderSpawnDialogKey,
} from "@/providers/DialogProvider";
const spawnDialog = injectStrict(DialogProviderSpawnDialogKey);

import DataTable from "@/components/ui/VirtualDataTable.vue";
import { RowAction, getDefaultActions } from "@/components/tables/types";
import { columns } from "@/components/tables/deployments";
import { useDataRefresher } from "@/composables/refresher";

const { toast } = useToast();
const deployments = ref<V1Deployment[]>([]);

const rowActions: RowAction<V1Deployment>[] = [
  ...getDefaultActions<V1Deployment>(addTab, spawnDialog, context.value),
  {
    label: "Logs",
    handler: (row) => {
      addTab(
        `logs_${row.metadata?.name}`,
        `${row.metadata?.name}`,
        defineAsyncComponent(
          () =>
            import(
              settings.value.structuredLogViewer.enabled
                ? "@/views/StructuredLogViewer.vue"
                : "@/views/LogViewer.vue"
            )
        ),
        {
          context: context.value,
          namespace: row.metadata?.namespace ?? namespace.value,
          object: `deployment/${row.metadata?.name}`,
        },
        "logs"
      );
    },
  },
  {
    label: "Restart",
    handler: (row) => {
      const dialog: BaseDialogInterface = {
        title: "Restart deployment",
        message: `Are you sure you want to restart deployment ${row.metadata?.name}?`,
        buttons: [
          {
            label: "Cancel",
            variant: "ghost",
            handler: (dialog) => {
              dialog.close();
            },
          },
          {
            label: "Restart",
            handler: (dialog) => {
              Kubernetes.restartDeployment(
                context.value,
                namespace.value === "all" ? "" : namespace.value,
                row.metadata?.name || ""
              )
                .then(() => {
                  dialog.close();
                })
                .catch((error) => {
                  dialog.close();
                  toast({
                    title: "An error occured",
                    description: error.message,
                    variant: "destructive",
                  });
                });
            },
          },
        ],
      };
      spawnDialog(dialog);
    },
  },
];

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
  <DataTable :data="deployments" :columns="columns" :row-actions="rowActions" />
</template>

<script setup lang="ts">
import { injectStrict } from "@/lib/utils";
import { V1CronJob, V1Job, V1Pod } from "@kubernetes/client-node";
import { Kubernetes } from "@/services/Kubernetes";
import { ref, h } from "vue";
import { useToast, ToastAction } from "@/components/ui/toast";

import { KubeContextStateKey } from "@/providers/KubeContextProvider";
const { context, namespace, kubeConfig } = injectStrict(KubeContextStateKey);

import DataTable from "@/components/ui/VirtualDataTable.vue";
import { columns } from "@/components/tables/cronjobs";
import { useDataRefresher } from "@/composables/refresher";

const { toast } = useToast();
const cronjobs = ref<V1CronJob[]>([]);

import { RowAction, getDefaultActions } from "@/components/tables/types";
import { PanelProviderAddTabKey } from "@/providers/PanelProvider";
const addTab = injectStrict(PanelProviderAddTabKey);

import {
  BaseDialogInterface,
  DialogProviderSpawnDialogKey,
} from "@/providers/DialogProvider";
const spawnDialog = injectStrict(DialogProviderSpawnDialogKey);

const rowActions: RowAction<V1CronJob>[] = [
  ...getDefaultActions<V1CronJob>(
    addTab,
    spawnDialog,
    context.value,
    kubeConfig.value
  ),
  {
    label: "Trigger",
    handler: (row) => {
      const dialog: BaseDialogInterface = {
        title: "Trigger cron job",
        message: `Are you sure you want to manually trigger "${row.metadata?.name}"?`,
        buttons: [
          {
            label: "Cancel",
            variant: "ghost",
            handler: (dialog) => {
              dialog.close();
            },
          },
          {
            label: "Trigger",
            handler: (dialog) => {
              Kubernetes.triggerCronJob(
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

async function getCronJobs(refresh: boolean = false) {
  if (!refresh) {
    cronjobs.value = [];
  }

  Kubernetes.getCronJobs(
    context.value,
    namespace.value === "all" ? "" : namespace.value
  )
    .then((results: V1CronJob[]) => {
      cronjobs.value = results;
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
  getCronJobs,
  1000,
  [context, namespace]
);

const create = () => {
  addTab(
    `create_` + Math.random().toString(36).substring(7),
    `New CronJob`,
    defineAsyncComponent(() => import("@/views/ObjectEditor.vue")),
    {
      context: context,
      namespace: namespace.value === "all" ? "" : namespace,
      kubeConfig: kubeConfig,
      create: true,
      type: "cronjob",
      useKubeCtl: false,
    },
    "edit"
  );
};
</script>

<template>
  <DataTable
    :data="cronjobs"
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

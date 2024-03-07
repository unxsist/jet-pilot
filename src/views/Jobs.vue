<script setup lang="ts">
import { injectStrict } from "@/lib/utils";
import { V1Job, V1Pod } from "@kubernetes/client-node";
import { Kubernetes } from "@/services/Kubernetes";
import { ref, h } from "vue";
import { useToast, ToastAction } from "@/components/ui/toast";

import { KubeContextStateKey } from "@/providers/KubeContextProvider";
const { context, namespace } = injectStrict(KubeContextStateKey);

import DataTable from "@/components/ui/DataTable.vue";
import { columns } from "@/components/tables/jobs";
import { useDataRefresher } from "@/composables/refresher";

const { toast } = useToast();
const jobs = ref<V1Job[]>([]);

import { RowAction, getDefaultActions } from "@/components/tables/types";
import { TabProviderAddTabKey } from "@/providers/TabProvider";
const addTab = injectStrict(TabProviderAddTabKey);

import { DialogProviderSpawnDialogKey } from "@/providers/DialogProvider";
const spawnDialog = injectStrict(DialogProviderSpawnDialogKey);

const rowActions: RowAction<V1Job>[] = [
  ...getDefaultActions<V1Job>(addTab, spawnDialog, context.value),
];

async function getJobs(refresh: boolean = false) {
  if (!refresh) {
    jobs.value = [];
  }

  Kubernetes.getJobs(
    context.value,
    namespace.value === "all" ? "" : namespace.value
  )
    .then((results: V1Job[]) => {
      jobs.value = results;
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

const { startRefreshing, stopRefreshing } = useDataRefresher(getJobs, 1000, [
  context,
  namespace,
]);
</script>
x
<template>
  <DataTable :data="jobs" :columns="columns" :row-actions="rowActions" />
</template>

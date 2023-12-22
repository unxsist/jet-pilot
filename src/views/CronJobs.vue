<script setup lang="ts">
import { injectStrict } from "@/lib/utils";
import { V1CronJob, V1Job, V1Pod } from "@kubernetes/client-node";
import { Kubernetes } from "@/services/Kubernetes";
import { ref, h } from "vue";
import { useToast, ToastAction } from "@/components/ui/toast";

import { KubeContextStateKey } from "@/providers/KubeContextProvider";
const { context, namespace } = injectStrict(KubeContextStateKey);

import DataTable from "@/components/ui/DataTable.vue";
import { columns } from "@/components/tables/cronjobs/columns";
import { useDataRefresher } from "@/composables/refresher";

const { toast } = useToast();
const cronjobs = ref<V1CronJob[]>([]);

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
</script>
x
<template>
  <DataTable :data="cronjobs" :columns="columns" />
</template>

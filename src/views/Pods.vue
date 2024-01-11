<script setup lang="ts">
import { injectStrict } from "@/lib/utils";
import { V1Pod } from "@kubernetes/client-node";
import { Kubernetes } from "@/services/Kubernetes";
import { ref, h } from "vue";
import { useRouter } from "vue-router";
import { useToast, ToastAction } from "@/components/ui/toast";

import { KubeContextStateKey } from "@/providers/KubeContextProvider";

import DataTable from "@/components/ui/DataTable.vue";
import { RowAction } from "@/components/tables/types";
import { columns } from "@/components/tables/pods";
import { useDataRefresher } from "@/composables/refresher";
import { TabProviderAddTabKey } from "@/providers/TabProvider";

const { context, namespace } = injectStrict(KubeContextStateKey);
const addTab = injectStrict(TabProviderAddTabKey);

const { toast } = useToast();
const router = useRouter();

const pods = ref<V1Pod[]>([]);

const rowActions: RowAction<V1Pod>[] = [
  {
    label: "Edit",
    handler: (row) => {
      addTab(
        `edit_${row.metadata?.name}`,
        `${row.metadata?.name}`,
        defineAsyncComponent(() => import("@/views/ObjectEditor.vue")),
        {
          context: context.value,
          namespace: namespace.value,
          object: `pods/${row.metadata?.name}`,
        },
        "edit"
      );
    },
  },
  {
    label: "Describe",
    handler: (row) => {
      addTab(
        `describe_${row.metadata?.name}`,
        `${row.metadata?.name}`,
        defineAsyncComponent(() => import("@/views/Describe.vue")),
        {
          context: context.value,
          namespace: namespace.value,
          object: `pods/${row.metadata?.name}`,
        },
        "describe"
      );
    },
  },
  {
    label: "Shell",
    options: (row) => {
      return (row.status?.containerStatuses || []).map((container) => ({
        label: container.name,
        handler: () => {
          addTab(
            `shell_${row.metadata?.name}_${container.name}`,
            `${row.metadata?.name}/${container.name}`,
            defineAsyncComponent(() => import("@/views/Shell.vue")),
            {
              context: context.value,
              namespace: namespace.value,
              pod: row,
              container: container,
            },
            "shell"
          );
        },
      }));
    },
  },
  {
    label: "Logs",
    handler: (row) => {
      addTab(
        `logs_${row.metadata?.name}`,
        `${row.metadata?.name}`,
        defineAsyncComponent(() => import("@/views/LogViewer.vue")),
        {
          context: context.value,
          namespace: namespace.value,
          pod: row.metadata?.name,
        },
        "logs"
      );
    },
  },
  {
    label: "Kill",
    handler: (row) => {
      Kubernetes.deletePod(
        context.value,
        row.metadata?.namespace ?? namespace.value,
        row.metadata?.name ?? ""
      )
        .then(() => {
          toast({
            title: "Pod deleted",
            autoDismiss: true,
            description: `Pod ${row.metadata?.name} was deleted`,
          });
        })
        .catch((error) => {
          toast({
            title: "An error occured",
            description: error.message,
            variant: "destructive",
          });
        });
    },
  },
];

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
        action: h(
          ToastAction,
          { altText: "Retry", onClick: () => startRefreshing() },
          { default: () => "Retry" }
        ),
      });
      stopRefreshing();
    });
}

const rowClasses = (row: V1Pod) => {
  // terminating
  if (row.metadata?.deletionTimestamp) {
    return "bg-red-500";
  }

  return "";
};

const { startRefreshing, stopRefreshing } = useDataRefresher(getPods, 1000, [
  context,
  namespace,
]);
</script>

<template>
  <DataTable
    :data="pods"
    :columns="columns"
    :row-actions="rowActions"
    :row-classes="rowClasses"
  />
</template>

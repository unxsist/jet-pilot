<script setup lang="ts">
import { injectStrict } from "@/lib/utils";
import { PodMetric, V1Pod } from "@kubernetes/client-node";
import { Kubernetes } from "@/services/Kubernetes";
import { ref, h } from "vue";
import { useToast, ToastAction } from "@/components/ui/toast";

import { KubeContextStateKey } from "@/providers/KubeContextProvider";

import DataTable from "@/components/ui/VirtualDataTable.vue";
import { RowAction, getDefaultActions } from "@/components/tables/types";
import { columns } from "@/components/tables/pods";
import { useDataRefresher } from "@/composables/refresher";
import { PanelProviderAddTabKey } from "@/providers/PanelProvider";

const {
  context,
  namespace,
  kubeConfig,
  authenticated: clusterAuthenticated,
} = injectStrict(KubeContextStateKey);

const addTab = injectStrict(PanelProviderAddTabKey);

import { DialogProviderSpawnDialogKey } from "@/providers/DialogProvider";
import { useRoute } from "vue-router";

const route = useRoute();

const spawnDialog = injectStrict(DialogProviderSpawnDialogKey);

import { PanelProviderSetSidePanelComponentKey } from "@/providers/PanelProvider";
const setSidePanelComponent = injectStrict(
  PanelProviderSetSidePanelComponentKey
);

const { toast } = useToast();

const pods = ref<V1Pod & { metrics: PodMetric[] }[]>([]);
const metrics = ref<Array<PodMetric[]>>([]);

const rowActions: RowAction<V1Pod>[] = [
  ...getDefaultActions<V1Pod>(
    addTab,
    spawnDialog,
    setSidePanelComponent,
    context.value,
    kubeConfig.value
  ),
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
              kubeConfig: kubeConfig.value,
              context: context.value,
              namespace: row.metadata?.namespace ?? namespace.value,
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
  {
    label: "Logs",
    options: (row) => {
      return [
        {
          label: "All containers",
          handler: () => {
            addTab(
              `logs_${row.metadata?.name}`,
              `${row.metadata?.name}`,
              defineAsyncComponent(
                () => import("@/views/StructuredLogViewer.vue")
              ),
              {
                context: context.value,
                namespace: row.metadata?.namespace ?? namespace.value,
                kubeConfig: kubeConfig.value,
                object: row.metadata?.name,
              },
              "logs"
            );
          },
        },
        ...(row.status?.containerStatuses || []).map((container) => ({
          label: container.name,
          handler: () => {
            addTab(
              `logs_${row.metadata?.name}_${container.name}`,
              `${row.metadata?.name}/${container.name}`,
              defineAsyncComponent(
                () => import("@/views/StructuredLogViewer.vue")
              ),
              {
                context: context.value,
                namespace: row.metadata?.namespace ?? namespace.value,
                kubeConfig: kubeConfig.value,
                object: row.metadata?.name,
                container: container.name,
              },
              "logs"
            );
          },
        })),
      ];
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

const showDetails = (row: any) => {
  setSidePanelComponent({
    title: `${row.kind}: ${row.metadata?.name}` || "Resource",
    icon: "pod",
    component: defineAsyncComponent(
      () => import("@/views/panels/Resource.vue")
    ),
    props: {
      resource: row,
    },
  });
};

async function getPods(): Promise<V1Pod[]> {
  const args = [
    "get",
    "pods",
    "--context",
    context.value,
    "-o",
    "json",
    "--kubeconfig",
    kubeConfig.value,
  ];

  if (namespace.value !== "all") {
    args.push("--namespace", namespace.value);
  } else {
    args.push("--all-namespaces");
  }

  return JSON.parse(await Kubernetes.kubectl(args)).items as V1Pod[];
}

async function getPodMetrics(): Promise<PodMetric[]> {
  const args = [
    "get",
    "podmetrics",
    "--context",
    context.value,
    "-o",
    "json",
    "--kubeconfig",
    kubeConfig.value,
  ];

  if (namespace.value !== "all") {
    args.push("--namespace", namespace.value);
  } else {
    args.push("--all-namespaces");
  }

  return JSON.parse(await Kubernetes.kubectl(args)).items as PodMetric[];
}

async function loadData(refresh = false) {
  if (!refresh) {
    pods.value = [];
  }

  Promise.allSettled([getPods(), getPodMetrics()]).then(async (results) => {
    if (results[0].status === "rejected") {
      const authErrorHandler = await Kubernetes.getAuthErrorHandler(
        context.value,
        kubeConfig.value,
        results[0].reason
      );

      if (authErrorHandler.canHandle) {
        clusterAuthenticated.value = false;
        stopRefreshing();
        spawnDialog({
          title: "SSO Session expired",
          message:
            "Failed to authenticate as the SSO session has expired. Please login again.",
          buttons: [
            {
              label: "Close",
              variant: "ghost",
              handler: (dialog) => {
                dialog.close();
              },
            },
            {
              label: "Login with SSO",
              handler: (dialog) => {
                dialog.buttons = [];
                dialog.title = "Awaiting SSO login";
                dialog.message = "Please wait while we redirect you.";
                authErrorHandler.callback(() => {
                  dialog.close();
                  clusterAuthenticated.value = true;
                  startRefreshing();
                });
              },
            },
          ],
        });
      } else {
        toast({
          title: "An error occured",
          description: results[0].reason,
          variant: "destructive",
          action: h(
            ToastAction,
            { altText: "Retry", onClick: () => startRefreshing() },
            { default: () => "Retry" }
          ),
        });
        stopRefreshing();

        return;
      }
    }

    pods.value = results[0].value.map((pod) => ({
      ...pod,
      metrics: [],
    }));

    if (results[1].status === "fulfilled") {
      metrics.value.push(results[1].value);
      if (metrics.value.length > 1) {
        metrics.value.shift();
      }

      metrics.value.forEach((metric) => {
        pods.value.forEach((pod) => {
          const podMetric = metric.find(
            (m) => m.metadata?.name === pod.metadata?.name
          );
          if (podMetric) {
            pod.metrics.push(podMetric);
          }
        });
      });
    }
  });
}

const rowClasses = (row: V1Pod) => {
  if (route.query.uid) {
    return row.metadata?.uid === route.query.uid
      ? "animate-pulse-highlight-once"
      : "";
  }

  if (row.metadata?.deletionTimestamp) {
    return "bg-red-500";
  }

  return "";
};

const { startRefreshing, stopRefreshing } = useDataRefresher(loadData, 1000, [
  context,
  namespace,
]);
</script>

<template>
  <DataTable
    :data="pods"
    :columns="columns"
    :allow-filter="true"
    :sticky-headers="true"
    :row-actions="rowActions"
    :row-classes="rowClasses"
    @row-clicked="showDetails"
    :estimated-row-height="41"
  />
</template>

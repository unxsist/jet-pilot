<script setup lang="ts">
import { injectStrict } from "@/lib/utils";
import { PodMetric, V1Pod } from "@kubernetes/client-node";
import { Kubernetes } from "@/services/Kubernetes";
import { ref, h } from "vue";
import { useToast, ToastAction } from "@/components/ui/toast";

import { KubeContextStateKey } from "@/providers/KubeContextProvider";

import DataTable from "@/components/ui/VirtualDataTable.vue";
import { RowAction, getDefaultActions } from "@/components/tables/types";
import { ColumnDef } from "@tanstack/vue-table";
import { namespaceColumn } from "@/components/tables/namespace";
import { multiContextColumns } from "@/components/tables/multicontext";
import { columns } from "@/components/tables/pods";
import { useDataRefresher } from "@/composables/refresher";
import { PanelProviderAddTabKey } from "@/providers/PanelProvider";

const {
  context,
  namespace,
  kubeConfig,
  contexts,
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

/*
 * Pods are self-describing: each row carries the context + kubeconfig it was
 * fetched with so actions target the right cluster.
 */
type ContextAwarePod = V1Pod & {
  metadata: NonNullable<V1Pod["metadata"]> & {
    context: string;
    kubeConfig: string;
  };
} & { metrics: PodMetric[] };

const pods = ref<ContextAwarePod[]>([]);
const metrics = ref<Array<PodMetric[]>>([]);

const tableColumns = computed<ColumnDef<any>[]>(() => {
  /*
   * Multi-context columns are always present (hidden by default); the
   * VirtualDataTable toggles them based on the active context state. In
   * legacy single-context mode (no active contexts) we additionally prepend
   * the Namespace column when "All namespaces" is selected.
   */
  if (contexts.value.size > 0) {
    return [...multiContextColumns, ...columns];
  }

  // Global namespace selection is empty when "All namespaces" is active.
  if (namespace.value) {
    return [...multiContextColumns, ...columns];
  }

  return [...multiContextColumns, namespaceColumn, ...columns];
});

const rowActions: RowAction<ContextAwarePod>[] = [
  ...getDefaultActions<ContextAwarePod>(
    addTab,
    spawnDialog,
    setSidePanelComponent
  ),
  {
    label: "Shell",
    options: (row) => {
      const containerStatuses = [
        ...(row.status?.containerStatuses || []),
        ...(row.status?.initContainerStatuses || []),
      ];

      return containerStatuses
        .filter((container) => {
          return (
            container.name &&
            (container.state?.running || container.state?.waiting) &&
            !container.state?.terminated
          );
        })
        .map((container) => {
          const specContainer =
            row.spec?.containers?.find((c) => c.name === container.name) ||
            row.spec?.initContainers?.find((c) => c.name === container.name);

          return {
            label: container.name,
            handler: () => {
              addTab(
                `shell_${row.metadata?.name}_${container.name}`,
                `${row.metadata?.name}/${container.name}`,
                defineAsyncComponent(() => import("@/views/Shell.vue")),
                {
                  kubeConfig: row.metadata.kubeConfig,
                  context: row.metadata.context,
                  namespace: row.metadata?.namespace ?? namespace.value,
                  pod: row,
                  container: specContainer,
                },
                "shell"
              );
            },
          };
        });
    },
  },
  {
    label: "Port Forward",
    handler: (row: ContextAwarePod) => {
      spawnDialog({
        title: "Port Forward",
        message: "Forward ports from the pod to your local machine",
        component: defineAsyncComponent(
          () => import("@/views/dialogs/PortForward.vue")
        ),
        props: {
          context: row.metadata.context,
          namespace: row.metadata?.namespace ?? namespace.value,
          kubeConfig: row.metadata.kubeConfig,
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
                context: row.metadata.context,
                namespace: row.metadata?.namespace ?? namespace.value,
                kubeConfig: row.metadata.kubeConfig,
                object: row.metadata?.name,
              },
              "logs"
            );
          },
        },
        ...(row.status?.containerStatuses || [])
          .concat(row.status?.initContainerStatuses || [])
          .map((container) => ({
            label: container.name,
            handler: () => {
              addTab(
                `logs_${row.metadata?.name}_${container.name}`,
                `${row.metadata?.name}/${container.name}`,
                defineAsyncComponent(
                  () => import("@/views/StructuredLogViewer.vue")
                ),
                {
                  context: row.metadata.context,
                  namespace: row.metadata?.namespace ?? namespace.value,
                  kubeConfig: row.metadata.kubeConfig,
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
    handler: (row: ContextAwarePod) => {
      Kubernetes.deletePod(
        row.metadata.context,
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

async function getPods(): Promise<ContextAwarePod[]> {
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

  if (namespace.value) {
    args.push("--namespace", namespace.value);
  } else {
    args.push("--all-namespaces");
  }

  return (JSON.parse(await Kubernetes.kubectl(args)).items as V1Pod[]).map(
    (pod) =>
      ({
        ...pod,
        metadata: {
          ...pod.metadata,
          context: context.value,
          kubeConfig: kubeConfig.value,
        },
      } as ContextAwarePod)
  );
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

  if (namespace.value) {
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
          title: "Authentication required",
          message:
            "Failed to authenticate with this cluster. Please log in to continue.",
          buttons: [
            {
              label: "Close",
              variant: "ghost",
              handler: (dialog) => {
                dialog.close();
              },
            },
            {
              label: "Login",
              handler: async (dialog) => {
                dialog.buttons = [];
                dialog.title = "Awaiting login";
                dialog.message =
                  "Please wait while we complete the login flow.";
                authErrorHandler.callback((instructions?: string) => {
                  if (instructions) {
                    dialog.title = "Complete login in your browser";
                    dialog.message = instructions.slice(0, 2000);
                    dialog.buttons = [
                      {
                        label: "I've completed the login",
                        handler: (dialog) => {
                          dialog.close();
                          clusterAuthenticated.value = true;
                          startRefreshing();
                        },
                      },
                    ];
                  } else {
                    dialog.close();
                    clusterAuthenticated.value = true;
                    startRefreshing();
                  }
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
            (m) =>
              m.metadata?.namespace === pod.metadata?.namespace &&
              m.metadata?.name === pod.metadata?.name
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

const { startRefreshing, stopRefreshing } = useDataRefresher(loadData, 5000, [
  context,
  namespace,
]);
</script>

<template>
  <DataTable
    :data="pods"
    :columns="tableColumns"
    :allow-filter="true"
    :sticky-headers="true"
    :row-actions="rowActions"
    :row-classes="rowClasses"
    @row-clicked="showDetails"
    :estimated-row-height="41"
  />
</template>

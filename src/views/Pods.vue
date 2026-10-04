<script setup lang="ts">
import { injectStrict } from "@/lib/utils";
import { PodMetric, V1Pod } from "@kubernetes/client-node";
import { Kubernetes } from "@/services/Kubernetes";
import { ref, h } from "vue";
import { useToast, ToastAction } from "@/components/ui/toast";
import { error } from "@/lib/logger";

import { KubeContextStateKey } from "@/providers/KubeContextProvider";

import DataTable from "@/components/ui/VirtualDataTable.vue";
import { RowAction, getDefaultActions } from "@/components/tables/types";
import { ColumnDef } from "@tanstack/vue-table";
import { multiContextColumns } from "@/components/tables/multicontext";
import { kubectlGetForContext } from "@/lib/multicontext";
import { columns } from "@/components/tables/pods";
import { useDataRefresher } from "@/composables/refresher";
import { PanelProviderAddTabKey } from "@/providers/PanelProvider";

const {
  namespace,
  contexts,
  contextKubeConfigMapping,
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

type ContextAwarePodMetric = PodMetric & {
  metadata: PodMetric["metadata"] & {
    context: string;
    kubeConfig: string;
  };
};

const pods = ref<ContextAwarePod[]>([]);

// The VirtualDataTable toggles the Context/Namespace columns based on the
// active context state.
const tableColumns = computed<ColumnDef<any>[]>(() => [
  ...multiContextColumns,
  ...columns,
]);

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
        row.metadata?.name ?? "",
        0,
        row.metadata.kubeConfig
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

/*
 * Offers the interactive login flow (kubelogin / OIDC exec plugins) for a
 * context whose credentials expired. Only one dialog is shown at a time.
 */
let authDialogOpen = false;

const handleAuthError = async (
  ctx: string,
  kubeConfig: string,
  reason: unknown
): Promise<boolean> => {
  const authErrorHandler = await Kubernetes.getAuthErrorHandler(
    ctx,
    kubeConfig,
    String(reason)
  );

  if (!authErrorHandler.canHandle) {
    return false;
  }

  if (authDialogOpen) {
    return true;
  }

  authDialogOpen = true;
  clusterAuthenticated.value = false;
  stopRefreshing();

  const loginCompleted = () => {
    authDialogOpen = false;
    clusterAuthenticated.value = true;
    loadData(true);
    startRefreshing();
  };

  spawnDialog({
    title: "Authentication required",
    message: `Failed to authenticate with ${ctx}. Please log in to continue.`,
    buttons: [
      {
        label: "Close",
        variant: "ghost",
        handler: (dialog) => {
          authDialogOpen = false;
          dialog.close();
        },
      },
      {
        label: "Login",
        handler: async (dialog) => {
          dialog.buttons = [];
          dialog.title = "Awaiting login";
          dialog.message = "Please wait while we complete the login flow.";
          authErrorHandler.callback((instructions?: string) => {
            if (instructions) {
              dialog.title = "Complete login in your browser";
              dialog.message = instructions.slice(0, 2000);
              dialog.buttons = [
                {
                  label: "I've completed the login",
                  handler: (dialog) => {
                    dialog.close();
                    loginCompleted();
                  },
                },
              ];
            } else {
              dialog.close();
              loginCompleted();
            }
          });
        },
      },
    ],
  });

  return true;
};

/*
 * Pods and metrics for one context. Metrics are optional: clusters without
 * metrics-server (kind, minikube, ...) fail `get podmetrics`, which must not
 * hide the pods themselves.
 */
const fetchContext = async (
  ctx: string,
  kubeConfig: string,
  namespaces: string[]
): Promise<{ pods: ContextAwarePod[]; metrics: ContextAwarePodMetric[] }> => {
  const [podsResult, metricsResult] = await Promise.allSettled([
    kubectlGetForContext<V1Pod>("pods", ctx, kubeConfig, namespaces),
    kubectlGetForContext<PodMetric>("podmetrics", ctx, kubeConfig, namespaces),
  ]);

  if (podsResult.status === "rejected") {
    throw podsResult.reason;
  }

  return {
    pods: podsResult.value.map((pod) => ({ ...pod, metrics: [] })),
    metrics:
      metricsResult.status === "fulfilled"
        ? (metricsResult.value as ContextAwarePodMetric[])
        : [],
  };
};

/*
 * Interval ticks are skipped while a fetch is still running; explicit reloads
 * (context changes) always run and supersede older fetches.
 */
let fetchGeneration = 0;
let fetchInFlight = false;

async function loadData(refresh = false) {
  if (refresh && fetchInFlight) {
    return;
  }

  if (!refresh) {
    pods.value = [];
  }

  const generation = ++fetchGeneration;
  fetchInFlight = true;

  try {
    // Aggregate pods + metrics across every activated (context, namespaces).
    const activeContexts = [...contexts.value.entries()].map(
      ([ctx, namespaces]) => ({
        ctx,
        namespaces,
        kubeConfig: contextKubeConfigMapping.value.get(ctx) || "",
      })
    );

    const results = await Promise.allSettled(
      activeContexts.map(({ ctx, kubeConfig, namespaces }) =>
        fetchContext(ctx, kubeConfig, namespaces)
      )
    );

    if (generation !== fetchGeneration) {
      return;
    }

    const aggregatedPods: ContextAwarePod[] = [];
    const aggregatedMetrics: ContextAwarePodMetric[] = [];
    const failures: { ctx: string; kubeConfig: string; reason: unknown }[] =
      [];

    results.forEach((result, i) => {
      if (result.status === "fulfilled") {
        aggregatedPods.push(...result.value.pods);
        aggregatedMetrics.push(...result.value.metrics);
      } else {
        const { ctx, kubeConfig } = activeContexts[i];
        failures.push({ ctx, kubeConfig, reason: result.reason });
        error(`Failed to fetch pods for context ${ctx}: ${result.reason}`);
      }
    });

    pods.value = aggregatedPods;
    aggregatedPods.forEach((pod) => {
      const podMetric = aggregatedMetrics.find(
        (m) =>
          m.metadata?.context === pod.metadata?.context &&
          m.metadata?.namespace === pod.metadata?.namespace &&
          m.metadata?.name === pod.metadata?.name
      );
      if (podMetric) {
        pod.metrics.push(podMetric);
      }
    });

    let authHandled = false;
    for (const failure of failures) {
      if (
        await handleAuthError(failure.ctx, failure.kubeConfig, failure.reason)
      ) {
        authHandled = true;
        break;
      }
    }

    if (
      !authHandled &&
      failures.length > 0 &&
      failures.length === results.length
    ) {
      toast({
        title: "An error occured",
        description:
          failures.length === 1
            ? String(failures[0].reason)
            : "Failed to fetch pods from any of the active contexts",
        variant: "destructive",
        action: h(
          ToastAction,
          { altText: "Retry", onClick: () => startRefreshing() },
          { default: () => "Retry" }
        ),
      });
      stopRefreshing();
    }
  } finally {
    if (generation === fetchGeneration) {
      fetchInFlight = false;
    }
  }
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
  contexts.value,
  contextKubeConfigMapping.value,
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

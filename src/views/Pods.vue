<script setup lang="ts">
import { injectStrict } from "@/lib/utils";
import { PodMetric, V1Pod } from "@kubernetes/client-node";
import { Kubernetes } from "@/services/Kubernetes";
import { error } from "@/lib/logger";

import { KubeContextStateKey } from "@/providers/KubeContextProvider";

import DataTable from "@/components/ui/VirtualDataTable.vue";
import { RowAction, getDefaultActions } from "@/components/tables/types";
import { ColumnDef } from "@tanstack/vue-table";
import { multiContextColumns } from "@/components/tables/multicontext";
import { kubectlGetForContext } from "@/lib/multicontext";
import { columns } from "@/components/tables/pods";
import {
  useResourceList,
  ContextFailure,
  ResourceListResult,
} from "@/composables/useResourceList";
import {
  getResourceTabId,
  getResourceTabTitle,
} from "@/components/tables/identity";
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

// The VirtualDataTable toggles the Context/Namespace columns based on the
// active context state.
const tableColumns = computed(
  () =>
    [...multiContextColumns, ...columns] as ColumnDef<ContextAwarePod, any>[]
);

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
                getResourceTabId("shell", row, container.name),
                getResourceTabTitle(row, container.name),
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
              getResourceTabId("logs", row),
              getResourceTabTitle(row),
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
                getResourceTabId("logs", row, container.name),
                getResourceTabTitle(row, container.name),
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
      spawnDialog({
        title: `Delete pod ${row.metadata?.name}?`,
        message: `${row.metadata.context} › ${row.metadata?.namespace}`,
        component: defineAsyncComponent(
          () => import("@/views/dialogs/DeletePod.vue")
        ),
        props: {
          pod: row,
        },
        buttons: [],
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
 * context whose credentials expired. One dialog at a time; contexts whose
 * dialog was closed are not asked again until a login completes. Refreshing
 * keeps running so the other active contexts stay up to date.
 */
let authDialogOpen = false;
const dismissedAuthContexts = new Set<string>();

const handleAuthError = async (
  ctx: string,
  kubeConfig: string,
  reason: unknown
): Promise<boolean> => {
  if (authDialogOpen || dismissedAuthContexts.has(ctx)) {
    return true;
  }

  const authErrorHandler = await Kubernetes.getAuthErrorHandler(
    ctx,
    kubeConfig,
    String(reason)
  );

  if (!authErrorHandler.canHandle || authDialogOpen) {
    return authErrorHandler.canHandle;
  }

  authDialogOpen = true;
  clusterAuthenticated.value = false;

  const closeAuthDialog = () => {
    authDialogOpen = false;
    clusterAuthenticated.value = true;
  };

  const loginCompleted = () => {
    closeAuthDialog();
    dismissedAuthContexts.clear();
    retry();
  };

  spawnDialog({
    title: "Authentication required",
    message: `Failed to authenticate with ${ctx}. Please log in to continue.`,
    buttons: [
      {
        label: "Close",
        variant: "ghost",
        handler: (dialog) => {
          dismissedAuthContexts.add(ctx);
          closeAuthDialog();
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
 * Aggregates pods + metrics across every activated (context, namespaces).
 * Superseded fetches, interval skipping and error state are handled by
 * useResourceList. Authentication failures that open the login dialog are not
 * reported as errors (refreshing keeps running for the other contexts).
 */
const loadPods = async (
  isCurrent: () => boolean
): Promise<ResourceListResult<ContextAwarePod>> => {
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

  const aggregatedPods: ContextAwarePod[] = [];
  const metricsByPod = new Map<string, ContextAwarePodMetric>();
  const failures: (ContextFailure & { kubeConfig: string })[] = [];

  results.forEach((result, i) => {
    if (result.status === "fulfilled") {
      aggregatedPods.push(...result.value.pods);
      for (const metric of result.value.metrics) {
        metricsByPod.set(podKey(metric.metadata), metric);
      }
    } else {
      const { ctx, kubeConfig } = activeContexts[i];
      failures.push({ context: ctx, kubeConfig, reason: result.reason });
      error(`Failed to fetch pods for context ${ctx}: ${result.reason}`);
    }
  });

  for (const pod of aggregatedPods) {
    const podMetric = metricsByPod.get(podKey(pod.metadata));
    if (podMetric) {
      pod.metrics.push(podMetric);
    }
  }

  if (isCurrent()) {
    for (const failure of failures) {
      if (
        await handleAuthError(
          failure.context,
          failure.kubeConfig,
          failure.reason
        )
      ) {
        return { items: aggregatedPods, attempted: results.length };
      }
    }
  }

  return { items: aggregatedPods, failures, attempted: results.length };
};

const podKey = (metadata?: {
  context?: string;
  namespace?: string;
  name?: string;
}) => `${metadata?.context}/${metadata?.namespace}/${metadata?.name}`;

const {
  items: pods,
  loading,
  error: loadError,
  lastUpdated,
  retry,
} = useResourceList(loadPods, {
  interval: 5000,
  // contexts and contextKubeConfigMapping always change together; watching
  // both would reload twice per selection change.
  dependencies: [contexts.value],
});

const rowClasses = (row: V1Pod) => {
  const classes: string[] = [];

  if (route.query.uid && row.metadata?.uid === route.query.uid) {
    classes.push("animate-pulse-highlight-once");
  }

  // Terminating: subtle tint + dimmed, the Status column carries the colour.
  if (row.metadata?.deletionTimestamp) {
    classes.push("bg-destructive/[0.05] opacity-60");
  }

  return classes.join(" ");
};
</script>

<template>
  <DataTable
    :data="pods"
    :loading="loading"
    :error="loadError"
    :last-updated="lastUpdated"
    resource-name="pods"
    :columns="tableColumns"
    :allow-filter="true"
    :sticky-headers="true"
    :row-actions="rowActions"
    :row-classes="rowClasses"
    @row-clicked="showDetails"
    @retry="retry"
    :estimated-row-height="38"
  />
</template>

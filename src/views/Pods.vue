<script setup lang="ts">
import { injectStrict } from "@/lib/utils";
import { PodMetric, V1Pod } from "@kubernetes/client-node";
import { Kubernetes } from "@/services/Kubernetes";

import { KubeContextStateKey } from "@/providers/KubeContextProvider";

import DataTable from "@/components/ui/VirtualDataTable.vue";
import { RowAction, getDefaultActions } from "@/components/tables/types";
import { ColumnDef } from "@tanstack/vue-table";
import { multiContextColumns } from "@/components/tables/multicontext";
import {
  activeTargets,
  kubectlGetForContext,
  kubectlPollingForced,
} from "@/lib/multicontext";
import { SettingsContextStateKey } from "@/providers/SettingsContextProvider";
import { columns } from "@/components/tables/pods";
import type { MetricsSample } from "@/components/tables/metrics";
import { actions as podActions } from "@/actions/pods";
import {
  ContextTarget,
  useWatchedList,
} from "@/composables/useWatchedList";
import { podMetricKey, usePodMetrics } from "@/composables/usePodMetrics";
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
const { settings } = injectStrict(SettingsContextStateKey);

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
} & { metrics: PodMetric[]; metricsHistory?: MetricsSample[] };

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
  ...podActions<ContextAwarePod>(addTab, spawnDialog),
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
 * kubectl fallback for one context (watch unavailable, or the
 * `experimental.useKubectlPolling` setting): pods, plus metrics when the
 * metrics service is disabled. Metrics are optional: clusters without
 * metrics-server (kind, minikube, ...) fail `get podmetrics`, which must not
 * hide the pods themselves.
 */
const kubectlMetrics = shallowRef<Map<string, ContextAwarePodMetric>>(
  new Map()
);

const fetchContext = async (
  target: ContextTarget
): Promise<ContextAwarePod[]> => {
  const { context: ctx, kubeConfig, namespaces } = target;
  const [podsResult, metricsResult] = await Promise.allSettled([
    kubectlGetForContext<V1Pod>("pods", ctx, kubeConfig, namespaces),
    forcePolling()
      ? kubectlGetForContext<PodMetric>("podmetrics", ctx, kubeConfig, namespaces)
      : Promise.resolve([]),
  ]);

  if (podsResult.status === "rejected") {
    throw podsResult.reason;
  }

  if (metricsResult.status === "fulfilled" && forcePolling()) {
    const next = new Map(
      [...kubectlMetrics.value].filter(([key]) => !key.startsWith(`${ctx}/`))
    );
    for (const metric of metricsResult.value as ContextAwarePodMetric[]) {
      next.set(podMetricKey(metric.metadata), metric);
    }
    kubectlMetrics.value = next;
  }

  return podsResult.value as ContextAwarePod[];
};

const forcePolling = () => kubectlPollingForced(settings.value);
const targets = () =>
  activeTargets(contexts.value, contextKubeConfigMapping.value);

/*
 * Live pods across every activated (context, namespaces) from the backend
 * WatchHub. Authentication failures that open the login dialog are not
 * reported as errors (the other contexts keep updating).
 */
const {
  items: watchedPods,
  loading,
  error: loadError,
  lastUpdated,
  retry,
} = useWatchedList<ContextAwarePod>({
  resource: () => "pods",
  kind: () => "Pod",
  targets,
  fallback: (_resource, target) => fetchContext(target),
  forcePolling,
  onAuthError: (target, message) =>
    handleAuthError(target.context, target.kubeConfig, message),
});

const { metrics, history: metricsHistory } = usePodMetrics(
  targets,
  () => !forcePolling()
);

/*
 * Pods joined with their latest metric and usage history (the sparkline
 * columns, see tables/metrics.ts). A row object is reused while neither the
 * pod, its metric nor its history changed (history arrays are replaced when
 * a sample is added), so the table only re-renders changed rows. Without a
 * history (kubectl fallback) the columns show the single latest sample.
 */
const rowCache = new WeakMap<
  object,
  { metric: unknown; history: unknown; row: ContextAwarePod }
>();
const pods = computed<ContextAwarePod[]>(() => {
  const serviceMetrics = metrics.value;
  const fallbackMetrics = kubectlMetrics.value;
  const histories = metricsHistory.value;
  return watchedPods.value.map((pod) => {
    const key = podMetricKey(pod.metadata);
    const metric = (serviceMetrics.get(key) ?? fallbackMetrics.get(key)) as
      | ContextAwarePodMetric
      | undefined;
    const history = histories.get(key);
    const cached = rowCache.get(pod);
    if (cached && cached.metric === metric && cached.history === history) {
      return cached.row;
    }
    const row = markRaw({
      ...pod,
      metrics: metric ? [metric] : [],
      ...(history ? { metricsHistory: history } : {}),
    });
    rowCache.set(pod, { metric, history, row });
    return row;
  });
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

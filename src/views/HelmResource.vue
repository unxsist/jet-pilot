<script setup lang="ts">
import { useRoute, useRouter, onBeforeRouteUpdate } from "vue-router";
import { Command } from "@tauri-apps/plugin-shell";
import { KubeContextStateKey } from "@/providers/KubeContextProvider";
import { injectStrict } from "@/lib/utils";
import { onMounted } from "vue";
import { useToast, ToastAction } from "@/components/ui/toast";
import { h } from "vue";
import DataTable from "@/components/ui/VirtualDataTable.vue";
import { ColumnDef } from "@tanstack/vue-table";
import { columns as defaultGenericColumns } from "@/components/tables/generic";
import { multiContextColumns } from "@/components/tables/multicontext";

const route = useRoute();
const router = useRouter();
const {
  context,
  namespace,
  kubeConfig,
  contexts,
  contextKubeConfigMapping,
} = injectStrict(KubeContextStateKey);

const { toast } = useToast();

const actions = ref(null);
const resourceData = ref<object[]>([]);
const refreshIntervalRef = ref<NodeJS.Timer | null>(null);
const isFetchingRef = ref(false);
const currentResource = ref(route.query.resource as string);

/*
 * HelmResource drives its own watcher interval (helm has no kubectl-style
 * single-shot invocation in this view), so start/stop are local: stopping
 * halts periodic refreshes, starting resumes them via a fresh fetch.
 */
const stopRefreshing = () => {
  if (refreshIntervalRef.value) {
    clearInterval(refreshIntervalRef.value);
    refreshIntervalRef.value = null;
  }
};

const startRefreshing = () => {
  if (refreshIntervalRef.value) {
    return;
  }
  isFetchingRef.value = false;
  initiateHelmWatcher(route.query.resource as string);
};

import { RowAction, getDefaultActions } from "@/components/tables/types";
import { PanelProviderAddTabKey } from "@/providers/PanelProvider";
const addTab = injectStrict(PanelProviderAddTabKey);

import { DialogProviderSpawnDialogKey } from "@/providers/DialogProvider";
import { error } from "@/lib/logger";
const spawnDialog = injectStrict(DialogProviderSpawnDialogKey);

import { PanelProviderSetSidePanelComponentKey } from "@/providers/PanelProvider";
const setSidePanelComponent = injectStrict(
  PanelProviderSetSidePanelComponentKey
);

const columns = ref<ColumnDef<any>[]>([]);
const rowActions = ref<RowAction<any>[]>([]);

const tableColumns = computed<ColumnDef<any>[]>(() => {
  // Helm releases carry their own Namespace column; only add the Context one.
  const multiColumns =
    route.query.resource === "release"
      ? multiContextColumns.slice(0, 1)
      : multiContextColumns;

  return [...multiColumns, ...columns.value];
});

const initColumns = async (resource: string) => {
  try {
    columns.value = defaultGenericColumns;

    const customColumns = await import(
      `@/components/tables/helm-${resource}.ts`
    );
    columns.value = customColumns.columns;
  } catch (e) {
    error(`Error initializing columns for ${resource}: ${e}`);
  }
};

const initRowActions = async (resource: string) => {
  try {
    rowActions.value = [];

    actions.value = null;
    actions.value = await import(`@/actions/helm-${resource}.ts`);

    rowActions.value = [
      ...rowActions.value,
      ...(actions.value
        ? actions.value.actions(
            addTab,
            spawnDialog,
            setSidePanelComponent,
            router
          )
        : []),
    ];
  } catch (e) {
    error(`Error initializing row actions for ${resource}: ${e}`);
  }
};

const rowClasses = (row: any) => {
  if (route.query.uid) {
    return row.metadata.uid === route.query.uid
      ? "animate-pulse-highlight-once"
      : "";
  }

  return "";
};

onBeforeRouteUpdate(async (to, from, next) => {
  currentResource.value = to.query.resource as string;

  if (refreshIntervalRef.value) {
    clearInterval(refreshIntervalRef.value);
  }

  isFetchingRef.value = false;
  initiateHelmWatcher(to.query.resource as string);
  await initColumns(to.query.resource as string);
  await initRowActions(to.query.resource as string);

  next();
});

const initiateHelmWatcher = (resource: string) => {
  resourceData.value = [];

  fetchHelmResource(resource);
  refreshIntervalRef.value = setInterval(() => {
    /* Skip overlapping runs: helm can be slow across multiple contexts. */
    if (isFetchingRef.value) {
      return;
    }
    fetchHelmResource(resource);
  }, 2500);
};

const tagRows = (rows: any[], ctx: string, kc: string) => {
  return rows.map((row: any) => ({
    ...row,
    metadata: {
      context: ctx,
      kubeConfig: kc,
    },
  }));
};

/*
 * `helm list`: per-context aggregation of releases. Each row carries the
 * context + kubeconfig it was fetched with so rollback/delete target the
 * right cluster.
 */
const fetchHelmReleasesForContext = async (
  ctx: string,
  namespaces: string[]
): Promise<object[]> => {
  const kubeConfig = contextKubeConfigMapping.value.get(ctx);
  if (!kubeConfig) {
    return [];
  }

  const baseArgs = [
    "list",
    "--kube-context",
    ctx,
    "-o",
    "json",
    "--kubeconfig",
    kubeConfig,
  ];

  const scopes: (string | null)[] =
    namespaces.includes("all") ? [null] : namespaces;

  const rows: object[] = [];
  for (const nsScope of scopes) {
    const args = [...baseArgs];
    if (nsScope) {
      args.push("--namespace", nsScope);
    } else {
      args.push("--all-namespaces");
    }

    const { stdout, code } = await Command.create("helm", args).execute();
    if (code !== 0) {
      throw new Error(
        `helm list exited with code ${code} for context ${ctx}`
      );
    }

    const parsed = JSON.parse(stdout);
    rows.push(...tagRows(Array.isArray(parsed) ? parsed : [], ctx, kubeConfig));
  }

  return rows;
};

const fetchHelmResource = async (resource: string) => {
  isFetchingRef.value = true;
  const fetchingResource = resource;

  try {
    let rows: object[] = [];

    /*
     * `helm search repo` searches the local repository cache - it is not
     * cluster-scoped, so it is fetched once using the global selection even
     * in multi-context mode (per-context runs would duplicate identical
     * rows).
     */
    if (resource === "release" && contexts.value.size > 0) {
      let failedContexts = 0;
      const aggregated: object[] = [];

      for (const [ctx, namespaces] of contexts.value) {
        try {
          aggregated.push(
            ...(await fetchHelmReleasesForContext(ctx, namespaces))
          );
        } catch (e) {
          failedContexts++;
          error(`Failed to fetch helm releases for context ${ctx}: ${e}`);
        }
      }

      rows = aggregated;

      if (failedContexts === contexts.value.size && rows.length === 0) {
        toast({
          title: "An error occured",
          description:
            "Failed to fetch helm releases from any of the active contexts",
          variant: "destructive",
          action: h(
            ToastAction,
            { altText: "Retry", onClick: () => startRefreshing() },
            { default: () => "Retry" }
          ),
        });
        stopRefreshing();
      }
    } else {
      const args =
        resource === "release"
          ? [
              "list",
              "--kube-context",
              context.value,
              "-o",
              "json",
              "--kubeconfig",
              kubeConfig.value,
            ]
          : [
              "search",
              "repo",
              "--kube-context",
              context.value,
              "-o",
              "json",
              "--kubeconfig",
              kubeConfig.value,
            ];

      if (namespace.value) {
        args.push("--namespace", namespace.value);
      } else if (resource === "release") {
        args.push("--all-namespaces");
      }

      const { stdout } = await Command.create("helm", args).execute();
      const parsed = JSON.parse(stdout);
      rows = tagRows(
        Array.isArray(parsed) ? parsed : [],
        context.value,
        kubeConfig.value
      );
    }

    /*
     * Make sure we never show data that's not related to the current resource
     * e.g. due to route switching mid-fetch.
     */
    if (fetchingResource !== currentResource.value) {
      return;
    }

    resourceData.value = rows;
  } catch (e) {
    error(`Error fetching Helm ${resource}: ${e}`);
  } finally {
    isFetchingRef.value = false;
  }
};

onMounted(() => {
  initColumns(route.query.resource as string);
  initRowActions(route.query.resource as string);

  initiateHelmWatcher(route.query.resource as string);
});

onUnmounted(() => {
  if (refreshIntervalRef.value) {
    clearInterval(refreshIntervalRef.value);
  }
});
</script>
<template>
  <DataTable
    :key="`${route.query.resource}-${resourceData.length}`"
    :data="resourceData"
    :columns="tableColumns"
    :allow-filter="true"
    :sticky-headers="true"
    :row-actions="rowActions"
    :row-classes="rowClasses"
  />
</template>

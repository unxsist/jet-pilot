<script setup lang="ts">
import { useRoute, useRouter, onBeforeRouteUpdate } from "vue-router";
import { Command } from "@tauri-apps/plugin-shell";
import { KubeContextStateKey } from "@/providers/KubeContextProvider";
import { injectStrict } from "@/lib/utils";
import { onMounted } from "vue";
import DataTable from "@/components/ui/VirtualDataTable.vue";
import { ColumnDef } from "@tanstack/vue-table";
import { columns as defaultGenericColumns } from "@/components/tables/generic";
import { multiContextColumns } from "@/components/tables/multicontext";
import {
  useResourceList,
  ContextFailure,
  ResourceListResult,
} from "@/composables/useResourceList";

const route = useRoute();
const router = useRouter();
const { context, kubeConfig, contexts, contextKubeConfigMapping } =
  injectStrict(KubeContextStateKey);

const actions = ref<any>(null);
const currentResource = ref(route.query.resource as string);

import { RowAction } from "@/components/tables/types";
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

const tagRows = (rows: any[], ctx: string, kc: string) => {
  return rows.map((row: any) => ({
    ...row,
    metadata: {
      context: ctx,
      kubeConfig: kc,
    },
  }));
};

/* Runs helm and parses its JSON output; non-zero exits throw with stderr. */
const helmJson = async (args: string[]): Promise<any[]> => {
  const { stdout, stderr, code } = await Command.create("helm", args).execute();
  if (code !== 0) {
    throw new Error(stderr.trim() || `helm ${args[0]} exited with code ${code}`);
  }

  const parsed = JSON.parse(stdout || "[]");
  return Array.isArray(parsed) ? parsed : [];
};

/*
 * `helm list` for one context; namespace scopes are fetched in parallel. Each
 * row carries the context + kubeconfig it was fetched with so rollback /
 * delete target the right cluster.
 */
const fetchHelmReleasesForContext = async (
  ctx: string,
  namespaces: string[]
): Promise<object[]> => {
  const kubeConfig = contextKubeConfigMapping.value.get(ctx) || "";
  const baseArgs = ["list", "--kube-context", ctx, "-o", "json"];
  if (kubeConfig) {
    baseArgs.push("--kubeconfig", kubeConfig);
  }

  const scopes: (string | null)[] = namespaces.includes("all")
    ? [null]
    : namespaces;

  const results = await Promise.all(
    scopes.map((nsScope) =>
      helmJson([
        ...baseArgs,
        ...(nsScope ? ["--namespace", nsScope] : ["--all-namespaces"]),
      ])
    )
  );

  return tagRows(results.flat(), ctx, kubeConfig);
};

/*
 * Releases are aggregated per active context (in parallel). `helm search
 * repo` searches the local repository cache - it is not cluster-scoped, so it
 * runs once using the primary context. Superseded fetches (resource or
 * context switches mid-fetch) are dropped by useResourceList.
 */
const loadHelmResource = async (): Promise<ResourceListResult<object>> => {
  const resource = currentResource.value;

  if (resource === "release") {
    const activeContexts = [...contexts.value.entries()];
    const results = await Promise.allSettled(
      activeContexts.map(([ctx, namespaces]) =>
        fetchHelmReleasesForContext(ctx, namespaces)
      )
    );

    const items: object[] = [];
    const failures: ContextFailure[] = [];
    results.forEach((result, i) => {
      if (result.status === "fulfilled") {
        items.push(...result.value);
      } else {
        const ctx = activeContexts[i][0];
        failures.push({ context: ctx, reason: result.reason });
        error(`Failed to fetch helm releases for context ${ctx}: ${result.reason}`);
      }
    });

    return { items, failures, attempted: activeContexts.length };
  }

  const args = ["search", "repo", "-o", "json"];
  const rows = await helmJson(args);
  return { items: tagRows(rows, context.value, kubeConfig.value) };
};

const {
  items: resourceData,
  loading,
  error: loadError,
  lastUpdated,
  retry,
} = useResourceList(loadHelmResource, {
  // helm is comparatively slow (it decodes release secrets), poll gently.
  interval: 10000,
  dependencies: [contexts.value, currentResource],
});

const resourceName = computed(() =>
  currentResource.value === "release" ? "releases" : "charts"
);

onBeforeRouteUpdate(async (to) => {
  currentResource.value = to.query.resource as string;

  await initColumns(to.query.resource as string);
  await initRowActions(to.query.resource as string);
});

onMounted(() => {
  initColumns(route.query.resource as string);
  initRowActions(route.query.resource as string);
});
</script>
<template>
  <DataTable
    :key="currentResource"
    :data="resourceData"
    :loading="loading"
    :error="loadError"
    :last-updated="lastUpdated"
    :resource-name="resourceName"
    :columns="tableColumns"
    :allow-filter="true"
    :sticky-headers="true"
    :row-actions="rowActions"
    :row-classes="rowClasses"
    @retry="retry"
  />
</template>

<script setup lang="ts">
import { useRoute, useRouter, onBeforeRouteUpdate } from "vue-router";
import { KubeContextStateKey } from "@/providers/KubeContextProvider";
import { injectStrict, formatResourceKind } from "@/lib/utils";
import { onMounted } from "vue";
import DataTable from "@/components/ui/VirtualDataTable.vue";
import { ColumnDef } from "@tanstack/vue-table";
import { columns as defaultGenericColumns } from "@/components/tables/generic";
import { multiContextColumns } from "@/components/tables/multicontext";
import { kubectlGetForContext } from "@/lib/multicontext";

const route = useRoute();
const router = useRouter();
const { toast, toasts, dismiss } = useToast();
const {
  context,
  namespace,
  kubeConfig,
  contexts,
  contextKubeConfigMapping,
} = injectStrict(KubeContextStateKey);

const actions = ref(null);
const currentResource = ref(route.query.resource as string);
const resourceData = ref<any[]>([]);

import { RowAction, getDefaultActions } from "@/components/tables/types";
import { PanelProviderAddTabKey } from "@/providers/PanelProvider";
const addTab = injectStrict(PanelProviderAddTabKey);

import { DialogProviderSpawnDialogKey } from "@/providers/DialogProvider";
import { error } from "@/lib/logger";
const spawnDialog = injectStrict(DialogProviderSpawnDialogKey);

import { PanelProviderSetSidePanelComponentKey } from "@/providers/PanelProvider";
import { useDataRefresher } from "@/composables/refresher";
import { useToast } from "@/components/ui/toast";
import ToastAction from "@/components/ui/toast/ToastAction.vue";
const setSidePanelComponent = injectStrict(
  PanelProviderSetSidePanelComponentKey
);

const columns = ref<ColumnDef<any>[]>([]);
const rowActions = ref<RowAction<any>[]>([]);
const refreshKey = ref<number>(0);

// The VirtualDataTable toggles the Context/Namespace columns based on the
// active context state.
const tableColumns = computed<ColumnDef<any>[]>(() => [
  ...multiContextColumns,
  ...columns.value,
]);

const initColumns = async (resource: string) => {
  try {
    columns.value = defaultGenericColumns;

    const customColumns = await import(`@/components/tables/${resource}.ts`);
    columns.value = customColumns.columns;
  } catch (e) {
    error(`Error initializing columns for ${resource}: ${e}`);
  }
};

const initRowActions = async (resource: string) => {
  try {
    rowActions.value = [
      ...getDefaultActions<any>(addTab, spawnDialog, setSidePanelComponent, true),
    ];

    actions.value = null;
    actions.value = await import(`@/actions/${resource}.ts`);

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

const showDetails = (row: any) => {
  setSidePanelComponent({
    title: `${row.kind}: ${row.metadata?.name}` || "Resource",
    icon: formatResourceKind(row.kind).toLowerCase(),
    component: defineAsyncComponent(
      () => import("@/views/panels/Resource.vue")
    ),
    props: {
      resource: row,
    },
  });
};

const create = () => {
  addTab(
    `create_` + Math.random().toString(36).substring(7),
    `New ${route.query.kind}`,
    defineAsyncComponent(() => import("@/views/ObjectEditor.vue")),
    {
      context: context,
      namespace: namespace.value === "all" ? "" : namespace,
      kubeConfig: kubeConfig,
      create: true,
      type: route.query.kind.toLowerCase(),
      kind: route.query.kind,
      useKubeCtl: false,
    },
    "edit"
  );
};

onBeforeRouteUpdate(async (to, from, next) => {
  resourceData.value = [];
  currentResource.value = to.query.resource as string;

  dismissAllToasts();
  getResourceData();

  await initColumns(to.query.resource as string);
  await initRowActions(to.query.resource as string);

  next();

  if (!isRefreshing.value) {
    startRefreshing();
  }
});

const dismissAllToasts = () => {
  toasts.value.forEach((t) => dismiss(t.id));
};

/*
 * Interval ticks are skipped while a fetch is still running (slow clusters can
 * take longer than the refresh interval); explicit reloads (route or context
 * changes) always run and supersede older fetches via the generation counter,
 * so stale results never overwrite newer ones.
 */
let fetchGeneration = 0;
let fetchInFlight = false;

const getResourceData = async (refresh = false) => {
  if (refresh && fetchInFlight) {
    return;
  }

  if (!refresh) {
    resourceData.value = [];
  }

  const generation = ++fetchGeneration;
  const fetchingResource = currentResource.value;
  fetchInFlight = true;

  try {
    // Aggregate rows across every activated (context, namespaces) combination.
    const activeContexts = [...contexts.value.entries()];
    const results = await Promise.allSettled(
      activeContexts.map(([ctx, namespaces]) =>
        kubectlGetForContext<any>(
          fetchingResource,
          ctx,
          contextKubeConfigMapping.value.get(ctx) || "",
          namespaces
        )
      )
    );

    if (generation !== fetchGeneration) {
      return;
    }

    const aggregated: object[] = [];
    results.forEach((result, i) => {
      if (result.status === "fulfilled") {
        aggregated.push(...result.value);
      } else {
        error(
          `Failed to fetch ${fetchingResource} for context ${activeContexts[i][0]}: ${result.reason}`
        );
      }
    });

    resourceData.value = aggregated;

    const failures = results.filter((r) => r.status === "rejected");
    if (results.length > 0 && failures.length === results.length) {
      toast({
        title: "An error occured",
        description:
          results.length === 1
            ? String((failures[0] as PromiseRejectedResult).reason)
            : "Failed to fetch the resource from any of the active contexts",
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
};

onMounted(async () => {
  initColumns(route.query.resource as string);
  initRowActions(route.query.resource as string);
});

const { startRefreshing, stopRefreshing, isRefreshing } = useDataRefresher(
  getResourceData,
  5000,
  // contexts and contextKubeConfigMapping always change together; watching
  // both would reload twice per selection change.
  [contexts.value]
);
</script>
<template>
  <DataTable
    :key="`${route.query.resource}-${refreshKey}`"
    :data="resourceData"
    :columns="tableColumns"
    :allow-filter="true"
    :sticky-headers="true"
    :row-actions="rowActions"
    :row-classes="rowClasses"
    @row-clicked="showDetails"
  >
    <template #action-buttons>
      <button
        class="transition-all ml-2 hover:opacity-100 opacity-50 z-50 rounded-full w-9 h-9 flex items-center justify-center bg-primary text-white text-lg"
        @click="create"
      >
        +
      </button>
    </template>
  </DataTable>
</template>

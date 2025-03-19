<script setup lang="ts">
import { useRoute, useRouter, onBeforeRouteUpdate } from "vue-router";
import { KubeContextStateKey } from "@/providers/KubeContextProvider";
import { injectStrict, formatResourceKind } from "@/lib/utils";
import { onMounted } from "vue";
import DataTable from "@/components/ui/VirtualDataTable.vue";
import { ColumnDef } from "@tanstack/vue-table";
import { columns as defaultGenericColumns } from "@/components/tables/generic";

const route = useRoute();
const router = useRouter();
const { toast, toasts, dismiss } = useToast();
const { context, namespace, kubeConfig } = injectStrict(KubeContextStateKey);

const actions = ref(null);
const currentResource = ref(route.query.resource as string);
const resourceData = ref<object[]>([]);

import { RowAction, getDefaultActions } from "@/components/tables/types";
import { PanelProviderAddTabKey } from "@/providers/PanelProvider";
const addTab = injectStrict(PanelProviderAddTabKey);

import { DialogProviderSpawnDialogKey } from "@/providers/DialogProvider";
import { error } from "@/lib/logger";
const spawnDialog = injectStrict(DialogProviderSpawnDialogKey);

import { PanelProviderSetSidePanelComponentKey } from "@/providers/PanelProvider";
import { Kubernetes } from "@/services/Kubernetes";
import { useDataRefresher } from "@/composables/refresher";
import { useToast } from "@/components/ui/toast";
import ToastAction from "@/components/ui/toast/ToastAction.vue";
const setSidePanelComponent = injectStrict(
  PanelProviderSetSidePanelComponentKey
);

const columns = ref<ColumnDef<any>[]>([]);
const rowActions = ref<RowAction<any>[]>([]);
const refreshKey = ref<number>(0);

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
      ...getDefaultActions<any>(
        addTab,
        spawnDialog,
        setSidePanelComponent,
        context.value,
        kubeConfig.value,
        true
      ),
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
            router,
            context.value,
            kubeConfig.value
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
  getResourceData(true);

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

const getResourceData = async (refresh = false) => {
  if (!refresh) {
    resourceData.value = [];
  }

  const fetchingResource = currentResource.value;

  const args = [
    "get",
    fetchingResource,
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

  try {
    const data = await Kubernetes.kubectl(args);

    /*
     * Make sure we never show data that's not related to the current resource
     * e.g. due to route switching mid-fetch
     */
    if (fetchingResource !== currentResource.value) {
      return;
    }

    resourceData.value = JSON.parse(data).items;
  } catch (e) {
    resourceData.value = [];
    toast({
      title: "An error occured",
      description: e,
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
};

onMounted(async () => {
  initColumns(route.query.resource as string);
  initRowActions(route.query.resource as string);
});

const { startRefreshing, stopRefreshing, isRefreshing } = useDataRefresher(
  getResourceData,
  5000,
  [context, namespace]
);
</script>
<template>
  <DataTable
    :key="`${route.query.resource}-${refreshKey}`"
    :data="resourceData"
    :columns="columns"
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

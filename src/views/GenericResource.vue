<script setup lang="ts">
import { useRoute, useRouter, onBeforeRouteUpdate } from "vue-router";
import { KubeContextStateKey } from "@/providers/KubeContextProvider";
import { injectStrict, formatResourceKind } from "@/lib/utils";
import { onMounted } from "vue";
import DataTable from "@/components/ui/VirtualDataTable.vue";
import { Button } from "@/components/ui/button";
import { Plus } from "lucide-vue-next";
import { ColumnDef } from "@tanstack/vue-table";
import { columns as defaultGenericColumns } from "@/components/tables/generic";
import { multiContextColumns } from "@/components/tables/multicontext";
import {
  activeTargets,
  kubectlGetForContext,
  kubectlPollingForced,
} from "@/lib/multicontext";
import { SettingsContextStateKey } from "@/providers/SettingsContextProvider";

const route = useRoute();
const router = useRouter();
const {
  context,
  kubeConfig,
  contexts,
  contextKubeConfigMapping,
} = injectStrict(KubeContextStateKey);

const actions = ref<any>(null);
const currentResource = ref(route.query.resource as string);
const currentKind = ref<string | undefined>(
  (route.query.kind as string) || undefined
);
const { settings } = injectStrict(SettingsContextStateKey);

import { RowAction, getDefaultActions } from "@/components/tables/types";
import { PanelProviderAddTabKey } from "@/providers/PanelProvider";
const addTab = injectStrict(PanelProviderAddTabKey);

import { DialogProviderSpawnDialogKey } from "@/providers/DialogProvider";
import { error } from "@/lib/logger";
const spawnDialog = injectStrict(DialogProviderSpawnDialogKey);

import { PanelProviderSetSidePanelComponentKey } from "@/providers/PanelProvider";
import { useWatchedList } from "@/composables/useWatchedList";
import { resolveCreateTarget } from "@/components/tables/identity";
import { allowed } from "@/lib/guardrails/guard";
import { guardedCluster } from "@/lib/guardrails/backstop";
import { readOnlyReason } from "@/lib/guardrails/policy";
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

const createTarget = () =>
  resolveCreateTarget(
    context.value,
    kubeConfig.value,
    contexts.value,
    contextKubeConfigMapping.value
  );

/* New objects go to the primary context: not when it is read-only. */
const createBlocked = computed(() => {
  const target = createTarget();
  const cluster = guardedCluster(target.context, target.kubeConfig);
  return cluster.readOnly ? readOnlyReason(cluster) : "";
});

const create = () => {
  const kind = String(route.query.kind || "");
  const target = createTarget();
  if (!allowed("create", [{ ...target, kind }])) return;

  addTab(
    `create_` + Math.random().toString(36).substring(7),
    `New ${kind}`,
    defineAsyncComponent(() => import("@/views/ObjectEditor.vue")),
    {
      ...target,
      create: true,
      type: kind.toLowerCase(),
      kind,
      useKubeCtl: false,
    },
    "edit"
  );
};

/*
 * Live rows across every activated (context, namespaces) combination from the
 * backend WatchHub; contexts whose watch can't start (or with the
 * `experimental.useKubectlPolling` setting) poll with kubectl instead.
 */
const {
  items: resourceData,
  loading,
  error: loadError,
  lastUpdated,
  retry,
} = useWatchedList<any>({
  resource: () => currentResource.value,
  kind: () => currentKind.value,
  targets: () =>
    activeTargets(contexts.value, contextKubeConfigMapping.value),
  fallback: (resource, target) =>
    kubectlGetForContext<any>(
      resource,
      target.context,
      target.kubeConfig,
      target.namespaces
    ),
  forcePolling: () => kubectlPollingForced(settings.value),
});

onBeforeRouteUpdate(async (to) => {
  currentKind.value = (to.query.kind as string) || undefined;
  currentResource.value = to.query.resource as string;

  await initColumns(to.query.resource as string);
  await initRowActions(to.query.resource as string);
});

onMounted(async () => {
  initColumns(route.query.resource as string);
  initRowActions(route.query.resource as string);
});
</script>
<template>
  <DataTable
    :key="`${route.query.resource}-${refreshKey}`"
    :data="resourceData"
    :loading="loading"
    :error="loadError"
    :last-updated="lastUpdated"
    :resource-name="currentResource"
    :columns="tableColumns"
    :allow-filter="true"
    :sticky-headers="true"
    :row-actions="rowActions"
    :row-classes="rowClasses"
    @row-clicked="showDetails"
    @retry="retry"
  >
    <template #action-buttons>
      <!-- The wrapper shows the reason: a disabled button gets no hover. -->
      <span class="inline-flex" :title="createBlocked || undefined">
        <Button
          size="sm"
          variant="outline"
          :title="createBlocked ? undefined : `Create ${route.query.kind || 'resource'}`"
          :disabled="!!createBlocked"
          @click="create"
        >
          <Plus class="h-3.5 w-3.5" />
          New
        </Button>
      </span>
    </template>
  </DataTable>
</template>

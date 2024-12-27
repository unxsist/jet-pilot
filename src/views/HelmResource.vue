<script setup lang="ts">
import { useRoute, useRouter, onBeforeRouteUpdate } from "vue-router";
import { Command, Child } from "@tauri-apps/plugin-shell";
import { KubeContextStateKey } from "@/providers/KubeContextProvider";
import { injectStrict } from "@/lib/utils";
import { onMounted } from "vue";
import DataTable from "@/components/ui/VirtualDataTable.vue";
import { ColumnDef } from "@tanstack/vue-table";
import { columns as defaultGenericColumns } from "@/components/tables/generic";

const route = useRoute();
const router = useRouter();
const { context, namespace, kubeConfig } = injectStrict(KubeContextStateKey);

const actions = ref(null);
const resourceData = ref<object[]>([]);
const refreshIntervalRef = ref<NodeJS.Timer | null>(null);

import { RowAction, getDefaultActions } from "@/components/tables/types";
import { TabProviderAddTabKey } from "@/providers/TabProvider";
const addTab = injectStrict(TabProviderAddTabKey);

import { DialogProviderSpawnDialogKey } from "@/providers/DialogProvider";
const spawnDialog = injectStrict(DialogProviderSpawnDialogKey);

const columns = ref<ColumnDef<any>[]>([]);
const rowActions = ref<RowAction<any>[]>([]);

const initColumns = async (resource: string) => {
  try {
    columns.value = defaultGenericColumns;

    const customColumns = await import(
      `@/components/tables/helm-${resource}.ts`
    );
    columns.value = customColumns.columns;
  } catch (e) {
    console.log(e);
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
            router,
            context.value,
            kubeConfig.value
          )
        : []),
    ];
  } catch (e) {
    console.log(e);
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
  if (refreshIntervalRef.value) {
    clearInterval(refreshIntervalRef.value);
  }

  initiateHelmWatcher(to.query.resource as string);
  await initColumns(to.query.resource as string);
  await initRowActions(to.query.resource as string);

  next();
});

const initiateHelmWatcher = (resource: string) => {
  resourceData.value = [];

  fetchHelmResource(resource);
  refreshIntervalRef.value = setInterval(async () => {
    fetchHelmResource(resource);
  }, 2500);
};

const fetchHelmResource = (resource: string) => {
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

  const command = Command.create("helm", args);
  command.stdout.on("data", (data) => {
    const parsedData = JSON.parse(data);

    resourceData.value = parsedData;
  });

  command.stderr.on("data", (data) => {
    console.error(data);
  });

  command.spawn();
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
    :columns="columns"
    :row-actions="rowActions"
    :row-classes="rowClasses"
  />
</template>

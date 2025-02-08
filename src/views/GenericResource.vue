<script setup lang="ts">
import { useRoute, useRouter, onBeforeRouteUpdate } from "vue-router";
import { Command, Child } from "@tauri-apps/plugin-shell";
import { KubeContextStateKey } from "@/providers/KubeContextProvider";
import { injectStrict } from "@/lib/utils";
import { onMounted } from "vue";
import DataTable from "@/components/ui/VirtualDataTable.vue";
import { ColumnDef } from "@tanstack/vue-table";
import { columns as defaultGenericColumns } from "@/components/tables/generic";

let process: Child | null = null;
const route = useRoute();
const router = useRouter();
const { context, namespace, kubeConfig } = injectStrict(KubeContextStateKey);

const actions = ref(null);
const resourceData = ref<object[]>([]);

import { RowAction, getDefaultActions } from "@/components/tables/types";
import { PanelProviderAddTabKey } from "@/providers/PanelProvider";
const addTab = injectStrict(PanelProviderAddTabKey);

import { DialogProviderSpawnDialogKey } from "@/providers/DialogProvider";
import { error } from "@/lib/logger";
const spawnDialog = injectStrict(DialogProviderSpawnDialogKey);

const columns = ref<ColumnDef<any>[]>([]);
const rowActions = ref<RowAction<any>[]>([]);
const intervalRef = ref<NodeJS.Timer | null>(null);
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

onBeforeRouteUpdate(async (to, from, next) => {
  killWatchCommand();
  initiateWatchCommand(to.query.resource as string);

  await initColumns(to.query.resource as string);
  await initRowActions(to.query.resource as string);

  next();
});

const initiateWatchCommand = (resource: string) => {
  resourceData.value = [];

  let args = [
    "get",
    resource,
    "--context",
    context.value,
    "-w",
    "--output-watch-events=true",
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

  const command = Command.create("kubectl", args);
  command.stdout.on("data", (data) => {
    const watchEvent = JSON.parse(data) as {
      type: string;
      object: any;
    };

    if (watchEvent.type === "ADDED") {
      resourceData.value.push(watchEvent.object);
    } else if (watchEvent.type === "DELETED") {
      resourceData.value = resourceData.value.filter(
        (item: any) => item.metadata.uid !== watchEvent.object.metadata.uid
      );
    } else if (watchEvent.type === "MODIFIED") {
      resourceData.value = resourceData.value.map((item: any) =>
        item.metadata.uid === watchEvent.object.metadata.uid
          ? watchEvent.object
          : item
      );
    }
  });

  command.stderr.on("data", (data) => {
    error(`Error watching ${resource}: ${data}`);
  });

  command.spawn().then((child) => {
    process = child;
  });
};

const killWatchCommand = () => {
  if (process) {
    process.kill();
    process = null;
  }
};

onMounted(() => {
  initiateWatchCommand(route.query.resource as string);
  initColumns(route.query.resource as string);
  initRowActions(route.query.resource as string);

  intervalRef.value = setInterval(() => {
    if (refreshKey.value !== resourceData.value.length) {
      refreshKey.value = resourceData.value.length;
    }
  }, 250);
});

onUnmounted(() => {
  killWatchCommand();

  if (intervalRef.value) {
    clearInterval(intervalRef.value);
  }
});
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
  />
</template>

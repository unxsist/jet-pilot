<script setup lang="ts">
import { useRoute, onBeforeRouteUpdate } from "vue-router";
import { Command, Child } from "@tauri-apps/api/shell";
import { KubeContextStateKey } from "@/providers/KubeContextProvider";
import { injectStrict } from "@/lib/utils";
import { onMounted } from "vue";
import DataTable from "@/components/ui/VirtualDataTable.vue";
import { ColumnDef } from "@tanstack/vue-table";
import { columns as defaultGenericColumns } from "@/components/tables/generic";

let process: Child | null = null;
const route = useRoute();
const { context, namespace, kubeConfig } = injectStrict(KubeContextStateKey);

const actions = ref(null);

const props = withDefaults(
  defineProps<{
    columns?: ColumnDef<any>[];
  }>(),
  {
    columns: defaultGenericColumns,
  }
);

const resourceData = ref<object[]>([]);

import { RowAction, getDefaultActions } from "@/components/tables/types";
import { TabProviderAddTabKey } from "@/providers/TabProvider";
const addTab = injectStrict(TabProviderAddTabKey);

import { DialogProviderSpawnDialogKey } from "@/providers/DialogProvider";
const spawnDialog = injectStrict(DialogProviderSpawnDialogKey);

const rowActions = ref<RowAction<any>[]>([]);

const initRowActions = async (resource: string) => {
  try {
    actions.value = null;
    actions.value = await import(`@/actions/${resource}.ts`);

    rowActions.value = [
      ...getDefaultActions<any>(
        addTab,
        spawnDialog,
        context.value,
        kubeConfig.value,
        true
      ),
      ...(actions.value
        ? actions.value.actions(
            addTab,
            spawnDialog,
            context.value,
            kubeConfig.value
          )
        : []),
    ];
  } catch (e) {
    console.log(e);
  }
};

onBeforeRouteUpdate(async (to, from, next) => {
  killWatchCommand();
  initiateWatchCommand(to.query.resource as string);

  console.log(to.params.pathMatch);
  await initRowActions(to.params.pathMatch[0]);

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

  const command = new Command("kubectl", args);
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
    console.log(data);
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
  initRowActions();
});

onUnmounted(() => {
  killWatchCommand();
});
</script>
<template>
  <DataTable
    :data="resourceData"
    :columns="columns"
    :row-actions="rowActions"
    :key="resourceData.length"
  />
</template>

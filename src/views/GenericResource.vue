<script setup lang="ts">
import { useRoute, onBeforeRouteUpdate } from "vue-router";
import { Command, Child } from "@tauri-apps/api/shell";
import { KubeContextStateKey } from "@/providers/KubeContextProvider";
import { injectStrict } from "@/lib/utils";
import { onMounted } from "vue";
import DataTable from "@/components/ui/DataTable.vue";
import DataTableManager from "@/components/ui/DataTableManager.vue";
import { columns } from "@/components/tables/generic";

let process: Child | null = null;
const route = useRoute();
const { context, namespace } = injectStrict(KubeContextStateKey);

const resourceData = ref<object[]>([]);

import { RowAction, getDefaultActions } from "@/components/tables/types";
import { TabProviderAddTabKey } from "@/providers/TabProvider";
const addTab = injectStrict(TabProviderAddTabKey);

const rowActions: RowAction<any>[] = [
  ...getDefaultActions<any>(addTab, context.value, true),
];

onBeforeRouteUpdate((to, from, next) => {
  killWatchCommand();
  initiateWatchCommand(to.query.resource as string);

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
  ];

  if (namespace.value) {
    args.push("--namespace", namespace.value);
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
});

onUnmounted(() => {
  killWatchCommand();
});
</script>
<template>
  <DataTableManager
    :default-columns="columns"
    :data="resourceData"
    v-slot="{ availableColumns }"
  >
    <DataTable
      :data="resourceData"
      :columns="availableColumns"
      :row-actions="rowActions"
      :key="resourceData.length"
    />
  </DataTableManager>
</template>

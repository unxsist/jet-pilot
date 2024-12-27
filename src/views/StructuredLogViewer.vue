<script setup lang="ts">
import { invoke } from "@tauri-apps/api/core";
import { Child, Command } from "@tauri-apps/plugin-shell";
import DataTable from "@/components/ui/VirtualDataTable.vue";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { h } from "vue";
import ArrowDownIcon from "@/assets/icons/arrow_down_xl.svg";
import { Checkbox } from "@/components/ui/checkbox";
import { useDebounceFn } from "@vueuse/core";
import { formatSnakeCaseToHumanReadable } from "@/lib/utils";

const sessionId = ref<string>("");
const columns = ref<string[]>([]);
const facets = ref<any>([]);
const sortingState = ref<any[]>([]);
const searchQuery = ref<string>("");
let logProcess: Child | null = null;

const autoScroll = ref(true);
const liveTail = ref(true);
const currentSince = ref<string>("1h");

const logsSinceOptions = ["1m", "5m", "15m", "30m", "1h"];

const logData = ref<any[]>([]);

const props = defineProps<{
  context: string;
  namespace: string;
  kubeConfig: string;
  object: string;
}>();

const initCommand = computed(() => {
  const initCommandArgs = [
    "logs",
    "--context",
    props.context,
    "--namespace",
    props.namespace,
    "--timestamps",
    "--kubeconfig",
    props.kubeConfig,
  ];

  if (liveTail.value) {
    initCommandArgs.push("--follow");
  }

  initCommandArgs.push("--since=" + currentSince.value);

  initCommandArgs.push(props.object);

  return initCommandArgs;
});

const initLogOutput = async () => {
  killProcess();

  const command = Command.create("kubectl", initCommand.value);

  command.stdout.on("data", async (data: string) => {
    if (data === "") {
      return;
    }

    await invoke("add_data_to_structured_logging_session", {
      sessionId: sessionId.value,
      data: data,
    });

    updateColumns();
    updateFacetValues();

    fetchDataDebounced();
  });

  command.stderr.on("data", (data: string) => {
    console.log("stderr", data);
  });

  const child = await command.spawn();
  logProcess = child;
};

const repurposeLoggingSession = async () => {
  await invoke("repurpose_structured_logging_session", {
    sessionId: sessionId.value,
  });
  logData.value = [];
};

const killProcess = async () => {
  if (logProcess) {
    logProcess.kill();
  }
};

const datatableColumns = computed(() => {
  return [
    // {
    //   id: "marked",
    //   cell: ({ row }) => {
    //     return h(Checkbox, {
    //       checked: row.marked,
    //       onChange: (value: boolean) => {
    //         row.marked = value;
    //       },
    //     });
    //   },
    // },
    {
      accessorKey: "timestamp",
      header: "Timestamp",
    },
    {
      accessorKey: "content",
      header: "Content",
    },
  ];
});

const addFacet = async (facet: string, matchType: "AND" | "OR") => {
  await invoke("add_facet_to_structured_logging_session", {
    sessionId: sessionId.value,
    matchType: matchType,
    property: facet,
  });

  updateFacetValues();
};

const setFacetMatchType = async (facet: string, matchType: "AND" | "OR") => {
  await invoke("set_facet_match_type_for_structured_logging_session", {
    sessionId: sessionId.value,
    property: facet,
    matchType: matchType,
  });

  await updateFacetValues();
  fetchData();
};

const removeFacet = async (facet: string) => {
  await invoke("remove_facet_from_structured_logging_session", {
    sessionId: sessionId.value,
    property: facet,
  });

  await updateFacetValues();
  fetchData();
};

const setFilteredForFacetValue = async (
  facet: string,
  value: string,
  filtered: boolean
) => {
  await invoke("set_filtered_for_facet_value", {
    sessionId: sessionId.value,
    property: facet,
    value: value,
    filtered: filtered,
  });

  await updateFacetValues();
  fetchData();
};

const updateFacetValues = async () => {
  facets.value = await invoke("get_facets_for_structured_logging_session", {
    sessionId: sessionId.value,
  });
};

const updateColumns = async () => {
  columns.value = await invoke("get_columns_for_structured_logging_session", {
    sessionId: sessionId.value,
  });
};

const getFacetForColumn = (column: string) => {
  return facets.value.find((f) => f.property === column);
};

watch(
  () => searchQuery.value,
  useDebounceFn(async () => {
    await fetchData();
  }, 250)
);

const updateSorting = async (sorting: []) => {
  sortingState.value = sorting;

  fetchData();
};

const fetchDataDebounced = useDebounceFn(() => {
  fetchData();
}, 25);

const fetchData = async () => {
  if (!sessionId.value) {
    return;
  }

  const results = await invoke(
    "get_filtered_data_for_structured_logging_session",
    {
      sessionId: sessionId.value,
      searchQuery: searchQuery.value,
      sorting: sortingState.value,
    }
  );

  logData.value = results.entries;
};

const setLogsSince = async (value: string) => {
  currentSince.value = value;
  await killProcess();
  await repurposeLoggingSession();
  await initLogOutput();
};

const setLiveTail = async (value: boolean) => {
  liveTail.value = value;
  await killProcess();
  await repurposeLoggingSession();
  await initLogOutput();
};

onMounted(async () => {
  sessionId.value = await invoke("start_structured_logging_session", {
    initialData: [],
  });

  initLogOutput();
});

onUnmounted(() => {
  killProcess();
});
</script>
<template>
  <div class="absolute left-0 top-0 flex flex-row w-full h-full border-t">
    <div
      v-if="columns.length > 0"
      class="overflow-y-auto h-full min-w-[300px] max-w-[300px] border-r p-2 space-y-4"
    >
      <span class="font-bold">Filters</span>
      <div v-for="column in columns" :key="column">
        <div
          class="flex items-center mb-3 cursor-pointer"
          :class="{
            'text-foreground dark:text-white': facets.find(
              (f) => f.property === column
            ),
            'text-muted-foreground': !facets.find((f) => f.property === column),
          }"
          @click="
            !facets.find((f) => f.property === column)
              ? addFacet(column, 'OR')
              : removeFacet(column)
          "
        >
          <ArrowDownIcon
            class="h-5 mx-2"
            :class="{
              '-rotate-90':
                facets.find((f) => f.property === column) === undefined,
            }"
          />
          <div class="font-medium">
            {{ formatSnakeCaseToHumanReadable(column) }}
          </div>
        </div>
        <ul
          class="border rounded-lg overflow-hidden"
          v-if="facets.find((f) => f.property === column) !== undefined"
        >
          <li
            v-for="value in getFacetForColumn(column).values.sort(
              (a, b) => b.total - a.total
            )"
            :key="value.value"
            class="flex items-center justify-between p-3 border-b cursor-pointer hover:bg-gray-100/25 dark:hover:bg-gray-100/5 last:border-b-0"
            :title="value.value"
            @click="
              setFilteredForFacetValue(column, value.value, !value.filtered)
            "
          >
            <label
              :for="`facet-${column}-${value.value}`"
              class="flex truncate space-x-2 cursor-pointer"
            >
              <Checkbox
                :id="`facet-${column}-${value.value}`"
                class="border-secondary"
                :checked="value.filtered"
              />
              <span class="text-xs truncate">{{ value.value }}</span>
            </label>
            <span class="bg-secondary text-foreground rounded-full px-2">{{
              value.total
            }}</span>
          </li>
        </ul>
      </div>
    </div>
    <div class="relative flex flex-col w-full h-full overflow-auto">
      <div class="flex p-2 space-x-2">
        <Input v-model="searchQuery" type="text" placeholder="Search..." />
        <Button variant="outline" @click="autoScroll = !autoScroll">
          <div
            class="w-2 h-2 rounded-full mr-2 bg-green-500"
            :class="{ 'bg-red-600': !autoScroll }"
          ></div>
          Autoscroll
        </Button>
        <Button
          class="flex-shrink-0"
          variant="outline"
          @click="setLiveTail(!liveTail)"
        >
          <div
            class="w-2 h-2 rounded-full mr-2 bg-green-500"
            :class="{ 'bg-red-600': !liveTail }"
          ></div>
          Live Tail
        </Button>
        <Button
          v-for="since in logsSinceOptions"
          :key="since"
          :variant="currentSince == since ? 'outline' : 'ghost'"
          @click="setLogsSince(since)"
        >
          {{ since }}
        </Button>
      </div>
      <!-- Hack to fix sticky header table data to shine through -->
      <div class="absolute h-[5px] w-full bg-background z-[9999]"></div>
      <DataTable
        :columns="datatableColumns"
        :data="logData"
        :row-classes="() => 'font-mono text-xs select-text'"
        :estimated-row-height="33"
        :auto-scroll="autoScroll"
        sticky-headers
        @sorting-change="updateSorting"
      />
    </div>
  </div>
</template>

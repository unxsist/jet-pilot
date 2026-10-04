<script setup lang="ts">
import { invoke } from "@tauri-apps/api/core";
import { Child, Command } from "@tauri-apps/plugin-shell";
import DataTable from "@/components/ui/VirtualDataTable.vue";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import ArrowDownIcon from "@/assets/icons/arrow_down_xl.svg";
import { Checkbox } from "@/components/ui/checkbox";
import { useDebounceFn } from "@vueuse/core";
import { formatSnakeCaseToHumanReadable, injectStrict } from "@/lib/utils";
import { SettingsContextStateKey } from "@/providers/SettingsContextProvider";
import { error } from "@/lib/logger";

const { settings } = injectStrict(SettingsContextStateKey);

const sessionId = ref<string>("");
const columns = ref<string[]>([]);
interface FacetValue {
  value: string;
  filtered: boolean;
  total: number;
}

interface Facet {
  property: string;
  match_type: "AND" | "OR";
  values: FacetValue[];
}

const facets = ref<Facet[]>([]);
const sortingState = ref<any[]>([]);
const searchQuery = ref<string>("");
let logProcess: Child | null = null;

const autoScroll = ref(true);
const liveTail = ref(true);
const currentSince = ref<string>("tail");

const logsSinceOptions = ["1m", "5m", "15m", "30m", "1h", "tail", "head"];

// Mirrors the backend cap (logs::MAX_ENTRIES_PER_SESSION).
const MAX_ROWS = 20_000;

interface StructuredLogEntry {
  id: string;
  seq: number;
  content: string;
  timestamp: string;
  data: unknown;
}

interface FilteredLogResult {
  entries: StructuredLogEntry[];
  total: number;
  filtered_total: number;
  oldest_seq: number;
  latest_seq: number;
}

interface AddDataResult {
  columns_changed: boolean;
  has_facets: boolean;
  total: number;
}

// shallowRef: the rows are replaced wholesale, never mutated in place, so
// deep reactivity on thousands of log entries would only cost time.
const logData = shallowRef<StructuredLogEntry[]>([]);
// Highest sequence number already in logData (incremental fetches).
let lastSeq = 0;
// Lines received from kubectl that haven't been sent to the backend yet.
let pendingLines: string[] = [];
let unmounted = false;

/*
 * All backend round-trips that read or reset logData run one after another,
 * so an incremental fetch can never interleave with a full refetch or a
 * session reset and append stale / duplicate rows.
 */
let queue: Promise<unknown> = Promise.resolve();
const enqueue = (task: () => Promise<unknown>) => {
  queue = queue.then(task).catch((e) => {
    error(`Structured log viewer: ${e}`);
  });
  return queue;
};

const props = defineProps<{
  context: string;
  namespace: string;
  kubeConfig: string;
  object: string;
  container?: string;
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

  if (currentSince.value !== "tail" && currentSince.value !== "head") {
    initCommandArgs.push("--since=" + currentSince.value);
  }

  if (currentSince.value === "tail") {
    initCommandArgs.push(`--tail=${settings.value.logs.tail_lines}`);
  }

  initCommandArgs.push(props.object);

  if (props.container) {
    initCommandArgs.push("-c");
    initCommandArgs.push(props.container);
  } else {
    initCommandArgs.push("--all-containers");
  }

  console.log(initCommandArgs);

  return initCommandArgs;
});

const initLogOutput = async () => {
  killProcess();

  console.log(initCommand.value);
  const command = Command.create("kubectl", initCommand.value);

  // kubectl emits one event per line; batch them so a busy pod costs a
  // handful of IPC round-trips per second instead of several per line.
  command.stdout.on("data", (data: string) => {
    if (data === "") {
      return;
    }

    pendingLines.push(data);
    flushPendingDebounced();
  });

  command.stderr.on("data", (data: string) => {
    error(`Error fetching logs: ${data}`);
  });

  const child = await command.spawn();
  logProcess = child;
};

const flushPendingLines = () =>
  enqueue(async () => {
    if (!sessionId.value || pendingLines.length === 0) {
      return;
    }

    const data = pendingLines.join("\n");
    pendingLines = [];

    const result = await invoke<AddDataResult | null>(
      "add_data_to_structured_logging_session",
      {
        sessionId: sessionId.value,
        data: data,
      }
    );

    if (!result) {
      return;
    }

    await Promise.all([
      result.columns_changed ? updateColumns() : undefined,
      result.has_facets ? updateFacetValues() : undefined,
    ]);

    await fetchNewEntries();
  });

const flushPendingDebounced = useDebounceFn(flushPendingLines, 100, {
  maxWait: 500,
});

const repurposeLoggingSession = () =>
  enqueue(async () => {
    pendingLines = [];
    await invoke("repurpose_structured_logging_session", {
      sessionId: sessionId.value,
    });
    logData.value = [];
    lastSeq = 0;
  });

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
  facets.value = await invoke<Facet[]>("get_facets_for_structured_logging_session", {
    sessionId: sessionId.value,
  });
};

const updateColumns = async () => {
  columns.value = await invoke<string[]>("get_columns_for_structured_logging_session", {
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

const queryEntries = (sinceSeq?: number) =>
  invoke<FilteredLogResult>(
    "get_filtered_data_for_structured_logging_session",
    {
      sessionId: sessionId.value,
      searchQuery: searchQuery.value,
      sorting: sortingState.value,
      sinceSeq: sinceSeq,
      limit: MAX_ROWS,
    }
  );

/*
 * Appends only the entries that arrived since the last fetch. With a custom
 * sort order new rows can land anywhere, so fall back to a full refetch.
 */
const fetchNewEntries = async () => {
  if (!sessionId.value) {
    return;
  }

  if (sortingState.value.length > 0) {
    await refetchAll();
    return;
  }

  const result = await queryEntries(lastSeq);
  lastSeq = result.latest_seq;

  // Drop rows the backend has evicted (session cap reached).
  const retained =
    logData.value.length > 0 && logData.value[0].seq < result.oldest_seq
      ? logData.value.filter((entry) => entry.seq >= result.oldest_seq)
      : logData.value;

  if (result.entries.length > 0 || retained !== logData.value) {
    logData.value = retained.concat(result.entries);
  }
};

const refetchAll = async () => {
  if (!sessionId.value) {
    return;
  }

  const result = await queryEntries();
  lastSeq = result.latest_seq;
  logData.value = result.entries;
};

const fetchData = () => enqueue(refetchAll);

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
  const id = await invoke<string>("start_structured_logging_session", {
    initialData: [],
  });

  if (unmounted) {
    invoke("end_structured_logging_session", { sessionId: id });
    return;
  }

  sessionId.value = id;
  initLogOutput();
});

onUnmounted(() => {
  unmounted = true;
  killProcess();
  pendingLines = [];

  // Free the backend session (parsed lines + facet state); it is not reused.
  if (sessionId.value) {
    const id = sessionId.value;
    enqueue(() => invoke("end_structured_logging_session", { sessionId: id }));
  }
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
            v-for="value in (getFacetForColumn(column)?.values ?? [])
              .slice()
              .sort((a, b) => b.total - a.total)"
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
      <div class="log-table-wrapper mt-0 mb-0 w-full">
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
  </div>
</template>

<style scoped>
.log-table-wrapper {
  height: calc(100% - 55px);
}
</style>

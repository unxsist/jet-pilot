<script setup lang="ts">
import { invoke } from "@tauri-apps/api/core";
import { Child, Command } from "@tauri-apps/plugin-shell";
import DataTable from "@/components/ui/VirtualDataTable.vue";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { StatusDot } from "@/components/ui/status";
import {
  ArrowDownToLine,
  ChevronRight,
  ListFilter,
  Search,
} from "lucide-vue-next";
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
      size: 210,
      meta: {
        class: () => "whitespace-nowrap tabular-nums text-muted-foreground",
      },
    },
    {
      accessorKey: "content",
      header: "Content",
      meta: {
        class: (row: StructuredLogEntry) => levelClass(logLevelOf(row)),
      },
    },
  ];
});

/* Log level of a parsed (JSON) line, if it has one. */
const logLevelOf = (row: StructuredLogEntry): string => {
  const data = row.data as Record<string, unknown> | null;
  const level = data?.level ?? data?.severity ?? data?.lvl;
  return typeof level === "string" ? level.toLowerCase() : "";
};

const levelClass = (level: string): string => {
  if (["error", "err", "fatal", "critical", "panic"].includes(level)) {
    return "text-destructive";
  }
  if (["warn", "warning"].includes(level)) return "text-warning";
  if (["debug", "trace"].includes(level)) return "text-muted-foreground";
  return "text-foreground";
};

/* Level facet values get the same colour as their lines. */
const levelTextClass = (column: string, value: string) =>
  ["level", "severity", "lvl"].includes(column)
    ? levelClass(value.toLowerCase())
    : "";

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
  <div class="absolute left-0 top-0 flex h-full w-full flex-row bg-background">
    <aside
      v-if="columns.length > 0"
      class="flex h-full w-64 min-w-[16rem] flex-col border-r bg-surface-1"
      aria-label="Log filters"
    >
      <div
        class="flex h-11 shrink-0 items-center gap-2 border-b px-3 text-2xs font-semibold uppercase tracking-[0.06em] text-muted-foreground"
      >
        <ListFilter class="h-3.5 w-3.5" />
        Fields
      </div>
      <div class="min-h-0 flex-1 space-y-0.5 overflow-y-auto p-1.5">
        <div v-for="column in columns" :key="column">
          <button
            type="button"
            class="flex h-7 w-full items-center gap-1.5 rounded-md px-1.5 text-left text-sm transition-colors duration-fast hover:bg-accent focus-ring"
            :class="
              facets.find((f) => f.property === column)
                ? 'font-medium text-foreground'
                : 'text-muted-foreground hover:text-foreground'
            "
            :aria-expanded="facets.find((f) => f.property === column) !== undefined"
            @click="
              !facets.find((f) => f.property === column)
                ? addFacet(column, 'OR')
                : removeFacet(column)
            "
          >
            <ChevronRight
              class="h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform duration-base ease-out"
              :class="{
                'rotate-90':
                  facets.find((f) => f.property === column) !== undefined,
              }"
            />
            <span class="truncate">{{
              formatSnakeCaseToHumanReadable(column)
            }}</span>
            <span
              v-if="
                (getFacetForColumn(column)?.values ?? []).some((v) => v.filtered)
              "
              class="ml-auto rounded bg-primary/15 px-1.5 text-2xs font-medium tabular-nums text-link"
              >{{
                (getFacetForColumn(column)?.values ?? []).filter(
                  (v) => v.filtered
                ).length
              }}</span
            >
          </button>
          <ul
            v-if="facets.find((f) => f.property === column) !== undefined"
            class="mb-1.5 ml-3 mt-0.5 space-y-px border-l border-border-subtle pl-2"
          >
            <li
              v-for="value in (getFacetForColumn(column)?.values ?? [])
                .slice()
                .sort((a, b) => b.total - a.total)"
              :key="value.value"
              class="flex h-7 cursor-pointer items-center justify-between gap-2 rounded-md px-1.5 transition-colors duration-fast hover:bg-accent"
              :title="value.value"
              @click="
                setFilteredForFacetValue(column, value.value, !value.filtered)
              "
            >
              <label
                :for="`facet-${column}-${value.value}`"
                class="flex min-w-0 cursor-pointer items-center gap-2"
              >
                <Checkbox
                  :id="`facet-${column}-${value.value}`"
                  :checked="value.filtered"
                />
                <span
                  class="truncate font-mono text-xs"
                  :class="levelTextClass(column, value.value)"
                  >{{ value.value }}</span
                >
              </label>
              <span class="text-2xs tabular-nums text-muted-foreground">{{
                value.total
              }}</span>
            </li>
          </ul>
        </div>
      </div>
    </aside>
    <div class="relative flex h-full min-w-0 flex-1 flex-col">
      <div
        class="flex h-11 shrink-0 items-center gap-2 border-b px-3"
        role="toolbar"
        aria-label="Log controls"
      >
        <div class="relative flex w-full max-w-sm items-center">
          <Search
            class="pointer-events-none absolute left-2.5 h-3.5 w-3.5 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            v-model="searchQuery"
            type="text"
            placeholder="Search logs…"
            aria-label="Search logs"
            class="h-7 pl-8"
          />
        </div>
        <div
          class="inline-flex h-7 items-center rounded-md bg-muted p-0.5"
          role="group"
          aria-label="Show logs since"
        >
          <button
            v-for="since in logsSinceOptions"
            :key="since"
            type="button"
            class="h-6 rounded-[5px] px-2 text-xs font-medium tabular-nums transition-colors duration-fast focus-ring"
            :class="
              currentSince == since
                ? 'bg-background text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground'
            "
            :aria-pressed="currentSince == since"
            @click="setLogsSince(since)"
          >
            {{ since }}
          </button>
        </div>
        <div class="ml-auto flex items-center gap-1.5">
          <Button
            variant="outline"
            size="sm"
            class="flex-shrink-0"
            :aria-pressed="liveTail"
            @click="setLiveTail(!liveTail)"
          >
            <StatusDot
              :tone="liveTail ? 'success' : 'muted'"
              :pulse="liveTail"
            />
            Live tail
          </Button>
          <Button
            variant="outline"
            size="sm"
            :aria-pressed="autoScroll"
            @click="autoScroll = !autoScroll"
          >
            <ArrowDownToLine
              class="h-3.5 w-3.5"
              :class="autoScroll ? 'text-primary' : 'text-muted-foreground'"
            />
            Autoscroll
          </Button>
        </div>
      </div>
      <div class="min-h-0 w-full flex-1">
        <DataTable
          :columns="datatableColumns"
          :data="logData"
          :row-classes="() => 'font-mono text-xs select-text'"
          :estimated-row-height="30"
          :auto-scroll="autoScroll"
          resource-name="log lines"
          sticky-headers
          @sorting-change="updateSorting"
        />
      </div>
    </div>
  </div>
</template>

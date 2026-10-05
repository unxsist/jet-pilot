<script setup lang="ts">
import { Channel, invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { resetLogStreams } from "@/lib/logStreams";
import { useThrottleFn, useDebounceFn } from "@vueuse/core";
import {
  ArrowDown,
  ArrowDownToLine,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Clock,
  Download,
  Eraser,
  History,
  KeyRound,
  ListFilter,
  Loader2,
  PanelLeft,
  Pause,
  Play,
  Search,
  TriangleAlert,
  WrapText,
  X,
} from "lucide-vue-next";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { EmptyState } from "@/components/ui/empty-state";
import { StatusDot, type StatusTone } from "@/components/ui/status";
import { TooltipProvider } from "@/components/ui/tooltip";
import { toast } from "@/components/ui/toast";
import LogLines from "@/components/log-viewer/LogLines.vue";
import ToolbarButton from "@/components/log-viewer/ToolbarButton.vue";
import { runCli, cliSucceeded, cliErrorMessage } from "@/actions/command";
import { formatSnakeCaseToHumanReadable, injectStrict } from "@/lib/utils";
import { SettingsContextStateKey } from "@/providers/SettingsContextProvider";
import { error } from "@/lib/logger";
import { Kubernetes, type LogStreamSpec } from "@/services/Kubernetes";
import { credential, onRecovered, report, requestSignIn } from "@/lib/auth/center";
import {
  LogRow,
  SourceColors,
  capRows,
  exportFileName,
  facetDisplayValue,
  levelClass,
  matchingRowIndexes,
  mergeByTimestamp,
  shortPodNames,
  stepMatch,
} from "@/lib/logViewer";
import {
  clusterArgs,
  isPodRef,
  podNameOf,
  workloadSelector,
} from "@/lib/workloads";

/*
 * Structured log viewer for a pod, or for every pod of a workload / service
 * (`object` = `deployment/web`, `statefulset/db`, `service/api`, ...).
 *
 * kubectl runs in the backend (start_log_stream): lines go straight into the
 * structured logging session and this view only gets "appended"
 * notifications, after which it fetches the new (filtered) entries.
 */
const props = defineProps<{
  context: string;
  namespace: string;
  kubeConfig: string;
  /* Pod name, `pod/name`, or `kind/name` of a workload / service. */
  object: string;
  container?: string;
  /* Pod selector; resolved from the object when omitted. */
  selector?: string;
  /* Start with the logs of previous container instances. */
  previous?: boolean;
  tabId?: string;
}>();

const { settings } = injectStrict(SettingsContextStateKey);

/* Mirrors the backend cap (logs::MAX_ENTRIES_PER_SESSION). */
const MAX_ROWS = 20_000;
const POD_FACET = "@pod";
const CONTAINER_FACET = "@container";
const SOURCE_FACETS = [POD_FACET, CONTAINER_FACET];

/* ------------------------------------------------------------ types -- */

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

interface FilteredLogResult {
  entries: LogRow[];
  total: number;
  filtered_total: number;
  oldest_seq: number;
  latest_seq: number;
}

type SourceState = "streaming" | "waiting" | "skipped" | "ended" | "failed";

interface PodSource {
  name: string;
  state: SourceState;
}

type LogStreamEvent =
  | {
      type: "appended";
      latestSeq: number;
      total: number;
      added: number;
      columnsChanged: boolean;
    }
  | { type: "sources"; pods: PodSource[] }
  | { type: "notice"; level: "info" | "warning" | "error"; message: string }
  | { type: "ended" };

type LogTarget = LogStreamSpec["target"];

/* ------------------------------------------------------------ state -- */

const sessionId = ref("");
const target = shallowRef<LogTarget | null>(null);
const resolveError = ref("");

const columns = ref<string[]>([]);
const facets = ref<Facet[]>([]);
const rows = shallowRef<LogRow[]>([]);
let lastSeq = 0;
const latestSeq = ref(0);
const totalLines = ref(0);

type StreamStatus = "resolving" | "starting" | "streaming" | "ended" | "error";
const status = ref<StreamStatus>("resolving");
const sources = ref<PodSource[]>([]);
const notices = ref<{ level: "info" | "warning" | "error"; message: string }[]>([]);

/* Defaults: Settings › Tables & Logs › Logs. */
const follow = ref(settings.value.logs.follow);
const previous = ref(props.previous ?? false);
const currentSince = ref("tail");
const logsSinceOptions = ["1m", "5m", "15m", "30m", "1h", "tail", "head"];

const showTimestamps = ref(settings.value.logs.timestamps);
const wrap = ref(settings.value.logs.wrap);
const paused = ref(false);
const stickToBottom = ref(true);
const showSidebar = ref(true);

const searchQuery = ref("");
const filterMode = ref(false);
const activeMatch = ref(-1);
const searchInput = ref<HTMLInputElement | null>(null);
const logLines = ref<InstanceType<typeof LogLines> | null>(null);

let streamToken = 0;
let unmounted = false;

/*
 * The cluster needs a sign-in: the auth center knows (toast, badges), this
 * view offers it and restarts the stream once signed in.
 */
const authTarget = { context: props.context, kubeConfig: props.kubeConfig || "" };
const authView = credential(authTarget);
const authBlocked = ref(false);
const needsSignIn = computed(() => authBlocked.value && authView.value.needsSignIn);
const reportAuth = (reason: unknown) => {
  // The error says so, or the backend reported the cluster already.
  if (report(authTarget, reason, "logs") || authView.value.needsSignIn) {
    authBlocked.value = true;
  }
};
const signIn = () => void requestSignIn(authTarget);
/* Reported by the backend after the stream failed. */
watch(
  () => authView.value.needsSignIn,
  (needs) => {
    const failed = status.value === "error" || notices.value.some((n) => n.level === "error");
    if (needs && failed) authBlocked.value = true;
  }
);
/* The backend doesn't restart log streams after a sign-in: this view does. */
const stopRecovered = onRecovered(authTarget, () => {
  if (!authBlocked.value || unmounted) return;
  authBlocked.value = false;
  void startStream();
});

/* ---------------------------------------------------- target lookup -- */

const isMultiPod = computed(() => target.value?.kind === "selector");

const resolveTarget = async (): Promise<LogTarget> => {
  if (isPodRef(props.object)) {
    return { kind: "pod", name: podNameOf(props.object) };
  }
  if (props.selector) {
    return { kind: "selector", selector: props.selector };
  }

  // Workloads / services: stream every pod matched by their selector.
  const result = await runCli("kubectl", [
    "get",
    props.object,
    "--output=json",
    ...clusterArgs(props),
  ]);
  if (cliSucceeded(result)) {
    try {
      const selector = workloadSelector(JSON.parse(result.stdout));
      if (selector) return { kind: "selector", selector };
    } catch (e) {
      error(`Unable to parse ${props.object}: ${e}`);
    }
  } else {
    error(`Unable to get ${props.object}: ${cliErrorMessage(result)}`);
  }

  // No selector (CronJob, ...): let kubectl pick a pod.
  return { kind: "object", name: props.object };
};

/* ---------------------------------------------------------- stream -- */

const streamSpec = (streamTarget: LogTarget): LogStreamSpec => ({
  context: props.context,
  namespace: props.namespace,
  kubeConfig: props.kubeConfig || null,
  target: streamTarget,
  container: props.container || null,
  follow: follow.value && !previous.value,
  previous: previous.value,
  since:
    currentSince.value !== "tail" && currentSince.value !== "head"
      ? currentSince.value
      : null,
  tail: currentSince.value === "tail" ? settings.value.logs.tailLines : null,
});

const startStream = async () => {
  if (!sessionId.value || !target.value) return;

  const token = ++streamToken;
  rows.value = [];
  lastSeq = 0;
  latestSeq.value = 0;
  totalLines.value = 0;
  activeMatch.value = -1;
  notices.value = [];
  sources.value = [];
  paused.value = false;
  stickToBottom.value = true;
  status.value = "starting";
  resetRate();

  const channel = new Channel<LogStreamEvent>();
  channel.onmessage = (event) => {
    if (token === streamToken && !unmounted) handleEvent(event);
  };

  try {
    await Kubernetes.startLogStream(
      sessionId.value,
      streamSpec(target.value),
      channel
    );
    if (token === streamToken && status.value === "starting") {
      status.value = "streaming";
    }
  } catch (e) {
    if (token !== streamToken) return;
    status.value = "error";
    notices.value = [{ level: "error", message: String(e) }];
    reportAuth(e);
    error(`Unable to start the log stream: ${e}`);
  }
};

const stopStream = () => {
  streamToken++;
  if (sessionId.value) {
    Kubernetes.stopLogStream(sessionId.value).catch(() => {});
  }
};

const handleEvent = (event: LogStreamEvent) => {
  switch (event.type) {
    case "appended":
      latestSeq.value = event.latestSeq;
      totalLines.value = event.total;
      recordRate(event.added);
      if (event.columnsChanged) updateColumns();
      if (facets.value.length > 0) updateFacetValuesThrottled();
      if (!paused.value) requestFetch();
      break;
    case "sources":
      sources.value = event.pods;
      break;
    case "notice":
      notices.value = [...notices.value.slice(-19), event];
      if (event.level === "error") {
        reportAuth(event.message);
        error(`Log stream: ${event.message}`);
      }
      break;
    case "ended":
      status.value = "ended";
      scheduleFetch();
      break;
  }
};

/* ------------------------------------------------------------ rate -- */

const rate = ref(0);
let rateWindow: { at: number; added: number }[] = [];
const resetRate = () => {
  rateWindow = [];
  rate.value = 0;
};
const recordRate = (added: number) => {
  const now = performance.now();
  rateWindow.push({ at: now, added });
  rateWindow = rateWindow.filter((sample) => now - sample.at <= 2000);
  rate.value = Math.round(
    rateWindow.reduce((sum, sample) => sum + sample.added, 0) / 2
  );
};
const rateTimer = window.setInterval(() => {
  if (rateWindow.length > 0) recordRate(0);
}, 1000);

/* ----------------------------------------------------------- fetch -- */

const backendQuery = () => (filterMode.value ? searchQuery.value : "");

const queryEntries = (sinceSeq?: number) =>
  invoke<FilteredLogResult>("get_filtered_data_for_structured_logging_session", {
    sessionId: sessionId.value,
    searchQuery: backendQuery(),
    sorting: [],
    sinceSeq,
    limit: MAX_ROWS,
  });

let fetching = false;
let fetchAgain = false;
let refetchRequested = false;

/*
 * One fetch at a time; notifications arriving meanwhile coalesce into one
 * follow-up fetch. A full refetch (filters / search changed) takes
 * precedence over incremental ones.
 */
const scheduleFetch = async (full = false) => {
  if (full) refetchRequested = true;
  if (fetching) {
    fetchAgain = true;
    return;
  }
  fetching = true;
  try {
    do {
      fetchAgain = false;
      const token = streamToken;
      const fullFetch = refetchRequested;
      refetchRequested = false;
      const result = await queryEntries(fullFetch ? undefined : lastSeq);
      if (token !== streamToken || unmounted) continue;

      lastSeq = Math.max(fullFetch ? 0 : lastSeq, result.latest_seq);
      rows.value = capRows(
        mergeByTimestamp(fullFetch ? [] : rows.value, result.entries),
        MAX_ROWS,
        result.oldest_seq
      );
    } while ((fetchAgain || refetchRequested) && !unmounted);
  } catch (e) {
    error(`Structured log viewer: ${e}`);
  } finally {
    fetching = false;
  }
};

const refetchAll = () => scheduleFetch(true);

/*
 * New-line notifications are coalesced: at most one fetch (and one render)
 * per MIN_FETCH_INTERVAL. Nobody reads faster than that, and at thousands
 * of lines per second it keeps the main thread mostly idle.
 */
const MIN_FETCH_INTERVAL = 200;
let lastFetchAt = 0;
let fetchTimer: number | undefined;
const requestFetch = () => {
  if (fetchTimer !== undefined) return;
  const delay = Math.max(0, lastFetchAt + MIN_FETCH_INTERVAL - performance.now());
  fetchTimer = window.setTimeout(() => {
    fetchTimer = undefined;
    lastFetchAt = performance.now();
    scheduleFetch();
  }, delay);
};

/* ---------------------------------------------------------- facets -- */

const updateColumns = async () => {
  columns.value = await invoke<string[]>(
    "get_columns_for_structured_logging_session",
    { sessionId: sessionId.value }
  );
};

const updateFacetValues = async () => {
  facets.value = await invoke<Facet[]>(
    "get_facets_for_structured_logging_session",
    { sessionId: sessionId.value }
  );
};
const updateFacetValuesThrottled = useThrottleFn(updateFacetValues, 500, true);

const addFacet = async (property: string, matchType: "AND" | "OR" = "OR") => {
  await invoke("add_facet_to_structured_logging_session", {
    sessionId: sessionId.value,
    matchType,
    property,
  });
  await updateFacetValues();
};

const removeFacet = async (property: string) => {
  await invoke("remove_facet_from_structured_logging_session", {
    sessionId: sessionId.value,
    property,
  });
  await updateFacetValues();
  refetchAll();
};

const setFilteredForFacetValue = async (
  property: string,
  value: string,
  filtered: boolean
) => {
  await invoke("set_filtered_for_facet_value", {
    sessionId: sessionId.value,
    property,
    value,
    filtered,
  });
  await updateFacetValues();
  refetchAll();
};

const facetFor = (property: string) =>
  facets.value.find((f) => f.property === property);

const fieldColumns = computed(() =>
  columns.value.filter((c) => !SOURCE_FACETS.includes(c))
);

const levelTextClass = (column: string, value: string) =>
  ["level", "severity", "lvl"].includes(column)
    ? levelClass(facetDisplayValue(value).toLowerCase())
    : "";

/* --------------------------------------------------------- sources -- */

const colors = new SourceColors();

const podNames = computed(() => {
  const names = new Set<string>(sources.value.map((s) => s.name));
  for (const value of facetFor(POD_FACET)?.values ?? []) {
    names.add(facetDisplayValue(value.value));
  }
  return [...names].sort();
});

const shortNames = computed(() => shortPodNames(podNames.value));

const containerValues = computed(() =>
  (facetFor(CONTAINER_FACET)?.values ?? [])
    .slice()
    .sort((a, b) => a.value.localeCompare(b.value))
);

const multiContainer = computed(() => containerValues.value.length > 1);
const showSource = computed(
  () => isMultiPod.value || podNames.value.length > 1 || multiContainer.value
);

const sourceLabel = (row: LogRow) => {
  const pod =
    isMultiPod.value || podNames.value.length > 1
      ? shortNames.value.get(row.pod ?? "") ?? row.pod ?? ""
      : "";
  if (multiContainer.value && row.container) {
    return pod ? `${pod}/${row.container}` : row.container;
  }
  return pod;
};

const sourceWidth = computed(() => {
  const podWidth =
    isMultiPod.value || podNames.value.length > 1
      ? Math.max(0, ...[...shortNames.value.values()].map((n) => n.length))
      : 0;
  const containerWidth = multiContainer.value
    ? Math.max(
        0,
        ...containerValues.value.map((v) => facetDisplayValue(v.value).length)
      ) + (podWidth ? 1 : 0)
    : 0;
  return Math.min(32, Math.max(4, podWidth + containerWidth));
});

const sourceHue = (row: LogRow) => colors.hue(row.pod ?? row.container ?? "");
const podHue = (name: string) => colors.hue(name);

const podRows = computed(() => {
  const counts = new Map<string, FacetValue>();
  for (const value of facetFor(POD_FACET)?.values ?? []) {
    counts.set(facetDisplayValue(value.value), value);
  }
  const states = new Map(sources.value.map((s) => [s.name, s.state]));
  return podNames.value.map((name) => ({
    name,
    short: shortNames.value.get(name) ?? name,
    state: states.get(name),
    total: counts.get(name)?.total ?? 0,
    filtered: counts.get(name)?.filtered ?? false,
    key: JSON.stringify(name),
    hue: podHue(name),
  }));
});

const sourceTone: Record<SourceState, StatusTone> = {
  streaming: "success",
  waiting: "warning",
  skipped: "muted",
  ended: "muted",
  failed: "destructive",
};

const sourceStateLabel: Record<SourceState, string> = {
  streaming: "Streaming",
  waiting: "Waiting for the pod to start",
  skipped: "Not streamed (pod limit reached)",
  ended: "Stream ended",
  failed: "Failed to stream",
};

const streamingCount = computed(
  () => sources.value.filter((s) => s.state === "streaming").length
);

const hasSidebar = computed(
  () =>
    isMultiPod.value ||
    podNames.value.length > 1 ||
    multiContainer.value ||
    fieldColumns.value.length > 0
);

/* ---------------------------------------------------------- search -- */

const matches = computed(() =>
  searchQuery.value && !filterMode.value
    ? matchingRowIndexes(rows.value, searchQuery.value)
    : []
);

const activeRowIndex = computed(() =>
  activeMatch.value >= 0 ? matches.value[activeMatch.value] ?? -1 : -1
);

const goToMatch = (direction: 1 | -1) => {
  if (matches.value.length === 0) return;
  activeMatch.value = stepMatch(matches.value.length, activeMatch.value, direction);
  stickToBottom.value = false;
  logLines.value?.scrollToIndex(matches.value[activeMatch.value]);
};

watch(searchQuery, () => {
  activeMatch.value = -1;
});

watch(
  searchQuery,
  useDebounceFn(() => {
    if (filterMode.value) refetchAll();
  }, 250)
);

const toggleFilterMode = () => {
  filterMode.value = !filterMode.value;
  activeMatch.value = -1;
  if (searchQuery.value) refetchAll();
};

const clearSearch = () => {
  searchQuery.value = "";
  activeMatch.value = -1;
};

const matchLabel = computed(() => {
  if (!searchQuery.value || filterMode.value) return "";
  if (matches.value.length === 0) return "No matches";
  return `${activeMatch.value >= 0 ? activeMatch.value + 1 : 0}/${matches.value.length}`;
});

const onSearchKeydown = (event: KeyboardEvent) => {
  if (event.key === "Enter") {
    event.preventDefault();
    goToMatch(event.shiftKey ? -1 : 1);
  } else if (event.key === "Escape") {
    event.preventDefault();
    if (searchQuery.value) clearSearch();
    else (event.target as HTMLElement).blur();
  }
};

/* -------------------------------------------------------- controls -- */

const setLogsSince = (value: string) => {
  currentSince.value = value;
  startStream();
};

const toggleFollow = () => {
  follow.value = !follow.value;
  if (follow.value) previous.value = false;
  startStream();
};

const togglePrevious = () => {
  previous.value = !previous.value;
  startStream();
};

const togglePause = () => {
  paused.value = !paused.value;
  if (!paused.value) {
    scheduleFetch();
    stickToBottom.value = true;
  }
};

const newWhilePaused = computed(() =>
  paused.value ? Math.max(0, latestSeq.value - lastSeq) : 0
);

const jumpToLatest = () => {
  activeMatch.value = -1;
  stickToBottom.value = true;
  logLines.value?.scrollToBottom();
};

const clearLines = async () => {
  await invoke("repurpose_structured_logging_session", {
    sessionId: sessionId.value,
  });
  rows.value = [];
  activeMatch.value = -1;
  totalLines.value = 0;
  await updateFacetValues();
};

const exporting = ref(false);
const download = async () => {
  const path = await save({
    title: "Export logs",
    defaultPath: exportFileName(props.object),
    filters: [
      { name: "Log file", extensions: ["log", "txt"] },
      { name: "JSON Lines", extensions: ["jsonl"] },
    ],
  });
  if (!path) return;

  exporting.value = true;
  try {
    const written = await invoke<number>("export_structured_logging_session", {
      sessionId: sessionId.value,
      path,
      searchQuery: searchQuery.value,
      format: path.endsWith(".jsonl") ? "jsonl" : "text",
    });
    toast({
      title: `Exported ${written.toLocaleString()} lines`,
      description: path,
      variant: "success",
      autoDismiss: true,
    });
  } catch (e) {
    toast({
      title: "Export failed",
      description: String(e),
      variant: "destructive",
      duration: 15000,
    });
  } finally {
    exporting.value = false;
  }
};

/* Keyboard: ⌘/Ctrl+F search, F3 / ⇧F3 matches, End = latest. */
const onKeydown = (event: KeyboardEvent) => {
  const mod = event.metaKey || event.ctrlKey;
  if (mod && event.key.toLowerCase() === "f") {
    event.preventDefault();
    searchInput.value?.focus();
    searchInput.value?.select();
  } else if (event.key === "F3") {
    event.preventDefault();
    goToMatch(event.shiftKey ? -1 : 1);
  } else if (
    event.key === "End" &&
    !(event.target instanceof HTMLInputElement)
  ) {
    event.preventDefault();
    jumpToLatest();
  }
};

const uid = Math.random().toString(36).slice(2, 8);

/* ------------------------------------------------------- lifecycle -- */

const statusText = computed(() => {
  if (needsSignIn.value) return "Sign-in needed";
  switch (status.value) {
    case "resolving":
      return "Finding pods…";
    case "starting":
      return "Connecting…";
    case "ended":
      return "Stream ended";
    case "error":
      return "Stream failed";
    default:
      if (previous.value) return "Previous container logs";
      if (!follow.value) return "Loaded";
      if (isMultiPod.value) {
        return `Streaming ${streamingCount.value} of ${podNames.value.length} pods`;
      }
      return "Streaming";
  }
});

const statusTone = computed<StatusTone>(() => {
  if (needsSignIn.value) return "warning";
  if (status.value === "error") return "destructive";
  if (status.value === "streaming" && follow.value && !previous.value) {
    return paused.value ? "warning" : "success";
  }
  if (status.value === "resolving" || status.value === "starting") return "info";
  return "muted";
});

const lastNotice = computed(() => notices.value[notices.value.length - 1]);

const emptyTitle = computed(() => {
  if (status.value === "resolving" || status.value === "starting") {
    return "Waiting for log lines…";
  }
  if (filterMode.value && searchQuery.value) return "No matching lines";
  if (previous.value) return "No previous container logs";
  return follow.value && status.value === "streaming"
    ? "No log lines yet"
    : "No log lines";
});

onMounted(async () => {
  // Never race the boot-time reset of a previous page load's sessions.
  await resetLogStreams();
  if (unmounted) return;
  const id = await invoke<string>("start_structured_logging_session", {
    initialData: [],
  });
  if (unmounted) {
    invoke("end_structured_logging_session", { sessionId: id });
    return;
  }
  sessionId.value = id;

  try {
    target.value = await resolveTarget();
  } catch (e) {
    resolveError.value = String(e);
    status.value = "error";
    return;
  }
  if (unmounted) return;

  // Source facets: counts per pod / container and filtering by them.
  await addFacet(POD_FACET);
  await addFacet(CONTAINER_FACET);
  await startStream();
});

const dispose = () => {
  if (unmounted) return;
  unmounted = true;
  stopRecovered();
  window.clearInterval(rateTimer);
  window.clearTimeout(fetchTimer);
  stopStream();
  if (sessionId.value) {
    const id = sessionId.value;
    invoke("end_structured_logging_session", { sessionId: id }).catch(() => {});
  }
};

/* The tab component stays cached (keep-alive): stop when the tab closes. */
const handleTabClosed = (e: Event) => {
  const event = e as CustomEvent<{ id: string }>;
  if (props.tabId && event.detail.id === props.tabId) dispose();
};
onMounted(() => window.addEventListener("TabOrchestrator_TabClosed", handleTabClosed));
onUnmounted(() => {
  window.removeEventListener("TabOrchestrator_TabClosed", handleTabClosed);
  dispose();
});
</script>

<template>
  <TooltipProvider>
    <div
      class="absolute left-0 top-0 flex h-full w-full flex-row bg-background"
      @keydown="onKeydown"
    >
      <aside
        v-if="hasSidebar && showSidebar"
        class="flex h-full w-64 min-w-[16rem] flex-col border-r bg-surface-1"
        aria-label="Log filters"
      >
        <div class="min-h-0 flex-1 overflow-y-auto pb-2">
          <!-- Pods -->
          <section v-if="isMultiPod || podNames.length > 1" aria-label="Pods">
            <div
              class="sticky top-0 z-10 flex h-9 items-center gap-2 bg-surface-1 px-3 text-xs font-medium text-muted-foreground"
            >
              Pods
              <span class="ml-auto font-normal normal-case tracking-normal tabular-nums">
                {{ podNames.length }}
              </span>
            </div>
            <ul class="space-y-px px-1.5">
              <li
                v-for="pod in podRows"
                :key="pod.name"
                class="flex h-7 cursor-pointer items-center gap-2 rounded-md px-1.5 transition-colors duration-fast hover:bg-accent"
                :title="`${pod.name}${pod.state ? ` · ${sourceStateLabel[pod.state]}` : ''}`"
                @click="setFilteredForFacetValue(POD_FACET, pod.key, !pod.filtered)"
              >
                <Checkbox
                  :checked="pod.filtered"
                  :aria-label="`Only show ${pod.name}`"
                  @click.stop="setFilteredForFacetValue(POD_FACET, pod.key, !pod.filtered)"
                />
                <span
                  class="h-2 w-2 shrink-0 rounded-full bg-[hsl(var(--pod-h)_65%_48%)] dark:bg-[hsl(var(--pod-h)_75%_62%)]"
                  :style="{ '--pod-h': pod.hue }"
                  aria-hidden="true"
                />
                <span class="min-w-0 flex-1 truncate font-mono text-xs">{{
                  pod.short
                }}</span>
                <StatusDot
                  v-if="pod.state"
                  size="sm"
                  :tone="sourceTone[pod.state]"
                  :label="sourceStateLabel[pod.state]"
                />
                <span class="w-10 text-right text-2xs tabular-nums text-muted-foreground">{{
                  pod.total.toLocaleString()
                }}</span>
              </li>
            </ul>
          </section>

          <!-- Containers -->
          <section v-if="multiContainer" aria-label="Containers">
            <div
              class="sticky top-0 z-10 flex h-9 items-center bg-surface-1 px-3 text-xs font-medium text-muted-foreground"
            >
              Containers
            </div>
            <ul class="space-y-px px-1.5">
              <li
                v-for="value in containerValues"
                :key="value.value"
                class="flex h-7 cursor-pointer items-center gap-2 rounded-md px-1.5 transition-colors duration-fast hover:bg-accent"
                @click="setFilteredForFacetValue(CONTAINER_FACET, value.value, !value.filtered)"
              >
                <Checkbox
                  :checked="value.filtered"
                  :aria-label="`Only show container ${facetDisplayValue(value.value)}`"
                  @click.stop="setFilteredForFacetValue(CONTAINER_FACET, value.value, !value.filtered)"
                />
                <span class="min-w-0 flex-1 truncate font-mono text-xs">{{
                  facetDisplayValue(value.value)
                }}</span>
                <span class="text-2xs tabular-nums text-muted-foreground">{{
                  value.total.toLocaleString()
                }}</span>
              </li>
            </ul>
          </section>

          <!-- Parsed fields -->
          <section v-if="fieldColumns.length > 0" aria-label="Fields">
            <div
              class="sticky top-0 z-10 flex h-9 items-center gap-2 bg-surface-1 px-3 text-xs font-medium text-muted-foreground"
            >
              <ListFilter class="h-3.5 w-3.5" />
              Fields
            </div>
            <div class="space-y-0.5 px-1.5">
              <div v-for="column in fieldColumns" :key="column">
                <button
                  type="button"
                  class="flex h-7 w-full items-center gap-1.5 rounded-md px-1.5 text-left text-sm transition-colors duration-fast hover:bg-accent focus-ring"
                  :class="
                    facetFor(column)
                      ? 'font-medium text-foreground'
                      : 'text-muted-foreground hover:text-foreground'
                  "
                  :aria-expanded="facetFor(column) !== undefined"
                  @click="facetFor(column) ? removeFacet(column) : addFacet(column)"
                >
                  <ChevronRight
                    class="h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform duration-base ease-out"
                    :class="{ 'rotate-90': facetFor(column) !== undefined }"
                  />
                  <span class="truncate">{{
                    formatSnakeCaseToHumanReadable(column)
                  }}</span>
                  <span
                    v-if="(facetFor(column)?.values ?? []).some((v) => v.filtered)"
                    class="ml-auto rounded bg-primary/15 px-1.5 text-2xs font-medium tabular-nums text-link"
                    >{{
                      (facetFor(column)?.values ?? []).filter((v) => v.filtered)
                        .length
                    }}</span
                  >
                </button>
                <ul
                  v-if="facetFor(column) !== undefined"
                  class="mb-1.5 ml-3 mt-0.5 space-y-px border-l border-border-subtle pl-2"
                >
                  <li
                    v-for="value in (facetFor(column)?.values ?? [])
                      .slice()
                      .sort((a, b) => b.total - a.total)"
                    :key="value.value"
                    class="flex h-7 cursor-pointer items-center justify-between gap-2 rounded-md px-1.5 transition-colors duration-fast hover:bg-accent"
                    :title="value.value"
                    @click="setFilteredForFacetValue(column, value.value, !value.filtered)"
                  >
                    <span class="flex min-w-0 items-center gap-2">
                      <Checkbox
                        :checked="value.filtered"
                        :aria-label="`Filter ${column} ${value.value}`"
                        @click.stop="setFilteredForFacetValue(column, value.value, !value.filtered)"
                      />
                      <span
                        class="truncate font-mono text-xs"
                        :class="levelTextClass(column, value.value)"
                        >{{ facetDisplayValue(value.value) }}</span
                      >
                    </span>
                    <span class="text-2xs tabular-nums text-muted-foreground">{{
                      value.total.toLocaleString()
                    }}</span>
                  </li>
                </ul>
              </div>
            </div>
          </section>
        </div>
      </aside>

      <div class="relative flex h-full min-w-0 flex-1 flex-col">
        <!-- Toolbar -->
        <div
          class="flex h-11 shrink-0 items-center gap-2 overflow-x-auto border-b bg-surface-1 px-2"
          role="toolbar"
          aria-label="Log controls"
        >
          <ToolbarButton
            v-if="hasSidebar"
            label="Toggle filters"
            :pressed="showSidebar"
            @click="showSidebar = !showSidebar"
          >
            <PanelLeft class="h-3.5 w-3.5" />
          </ToolbarButton>

          <div
            class="relative flex h-7 w-72 min-w-[12rem] shrink items-center rounded-md border border-input bg-background shadow-xs focus-within:border-primary focus-within:ring-[3px] focus-within:ring-ring/20"
          >
            <Search
              class="pointer-events-none ml-2.5 h-3.5 w-3.5 shrink-0 text-muted-foreground"
              aria-hidden="true"
            />
            <input
              :id="`log-search-${uid}`"
              ref="searchInput"
              v-model="searchQuery"
              type="text"
              :placeholder="filterMode ? 'Filter lines…' : 'Find in logs…'"
              aria-label="Search logs"
              class="h-full min-w-0 flex-1 bg-transparent px-2 text-sm outline-none placeholder:text-muted-foreground"
              @keydown="onSearchKeydown"
            />
            <span
              v-if="matchLabel"
              class="shrink-0 pr-1 text-2xs tabular-nums text-muted-foreground"
              aria-live="polite"
              >{{ matchLabel }}</span
            >
            <template v-if="searchQuery && !filterMode">
              <Button
                variant="ghost"
                size="icon-xs"
                class="h-5 w-5 text-muted-foreground"
                aria-label="Previous match"
                title="Previous match (Shift+Enter)"
                :disabled="matches.length === 0"
                @click="goToMatch(-1)"
              >
                <ChevronUp class="h-3.5 w-3.5" />
              </Button>
              <Button
                variant="ghost"
                size="icon-xs"
                class="h-5 w-5 text-muted-foreground"
                aria-label="Next match"
                title="Next match (Enter)"
                :disabled="matches.length === 0"
                @click="goToMatch(1)"
              >
                <ChevronDown class="h-3.5 w-3.5" />
              </Button>
            </template>
            <Button
              v-if="searchQuery"
              variant="ghost"
              size="icon-xs"
              class="mr-0.5 h-5 w-5 text-muted-foreground"
              aria-label="Clear search"
              title="Clear (Esc)"
              @click="clearSearch"
            >
              <X class="h-3.5 w-3.5" />
            </Button>
          </div>
          <ToolbarButton
            label="Only show matching lines"
            :pressed="filterMode"
            @click="toggleFilterMode"
          >
            <ListFilter class="h-3.5 w-3.5" />
          </ToolbarButton>

          <div
            class="inline-flex h-7 shrink-0 items-center rounded-md bg-muted p-0.5"
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
              :title="
                since === 'tail'
                  ? `Last ${settings.logs.tailLines} lines per pod`
                  : since === 'head'
                    ? 'All retained logs'
                    : `Logs of the last ${since}`
              "
              @click="setLogsSince(since)"
            >
              {{ since }}
            </button>
          </div>

          <div class="ml-auto flex shrink-0 items-center gap-0.5">
            <ToolbarButton
              label="Follow new lines"
              text
              variant="outline"
              :pressed="follow && !previous"
              class="mr-1"
              @click="toggleFollow"
            >
              <StatusDot
                :tone="follow && !previous ? 'success' : 'muted'"
                :pulse="follow && !previous && !paused && status === 'streaming'"
              />
              Live
            </ToolbarButton>
            <ToolbarButton
              :label="paused ? 'Resume view' : 'Pause view'"
              :pressed="paused"
              @click="togglePause"
            >
              <Play v-if="paused" class="h-3.5 w-3.5" />
              <Pause v-else class="h-3.5 w-3.5" />
            </ToolbarButton>
            <ToolbarButton
              label="Previous container instance"
              :pressed="previous"
              @click="togglePrevious"
            >
              <History class="h-3.5 w-3.5" />
            </ToolbarButton>
            <div class="mx-1 h-4 w-px bg-border" aria-hidden="true" />
            <ToolbarButton
              label="Timestamps"
              :pressed="showTimestamps"
              @click="showTimestamps = !showTimestamps"
            >
              <Clock class="h-3.5 w-3.5" />
            </ToolbarButton>
            <ToolbarButton label="Wrap lines" :pressed="wrap" @click="wrap = !wrap">
              <WrapText class="h-3.5 w-3.5" />
            </ToolbarButton>
            <ToolbarButton
              label="Scroll to latest"
              :shortcut="['End']"
              :pressed="stickToBottom"
              @click="jumpToLatest"
            >
              <ArrowDownToLine class="h-3.5 w-3.5" />
            </ToolbarButton>
            <div class="mx-1 h-4 w-px bg-border" aria-hidden="true" />
            <ToolbarButton label="Clear" @click="clearLines">
              <Eraser class="h-3.5 w-3.5" />
            </ToolbarButton>
            <ToolbarButton
              label="Export lines…"
              :disabled="exporting || totalLines === 0"
              @click="download"
            >
              <Loader2 v-if="exporting" class="h-3.5 w-3.5 animate-spin" />
              <Download v-else class="h-3.5 w-3.5" />
            </ToolbarButton>
          </div>
        </div>

        <!-- Lines -->
        <div class="relative min-h-0 w-full flex-1">
          <LogLines
            ref="logLines"
            v-model:stick-to-bottom="stickToBottom"
            :rows="rows"
            :show-timestamps="showTimestamps"
            :wrap="wrap"
            :show-source="showSource"
            :source-width="sourceWidth"
            :source-label="sourceLabel"
            :source-hue="sourceHue"
            :query="filterMode ? '' : searchQuery"
            :active-index="activeRowIndex"
          >
            <template #empty>
              <EmptyState
                v-if="needsSignIn"
                :icon="KeyRound"
                title="Sign-in needed"
                description="The cluster needs you to sign in again. Logs stream again once you have."
                size="sm"
                class="max-w-lg"
              >
                <template #action>
                  <Button size="sm" :disabled="authView.signingIn" @click="signIn">
                    {{ authView.signingIn ? "Signing in…" : "Sign in" }}
                  </Button>
                </template>
              </EmptyState>
              <EmptyState
                v-else-if="status === 'error'"
                :icon="TriangleAlert"
                title="Unable to stream logs"
                :description="resolveError || lastNotice?.message"
                size="sm"
                class="max-w-lg"
              >
                <template #action>
                  <Button variant="outline" size="sm" @click="startStream">
                    Retry
                  </Button>
                </template>
              </EmptyState>
              <EmptyState
                v-else
                :title="emptyTitle"
                :description="
                  status === 'resolving'
                    ? `Resolving the pods of ${object}`
                    : lastNotice?.message
                "
                size="sm"
                class="max-w-lg"
              >
                <template #icon>
                  <Loader2
                    v-if="status === 'resolving' || status === 'starting'"
                    class="h-5 w-5 animate-spin"
                  />
                </template>
              </EmptyState>
            </template>
          </LogLines>

          <button
            v-if="!stickToBottom && rows.length > 0"
            type="button"
            class="absolute bottom-3 left-1/2 inline-flex h-7 -translate-x-1/2 items-center gap-1.5 rounded-full border bg-popover px-3 text-xs font-medium text-foreground shadow-md transition-colors duration-fast hover:bg-accent focus-ring animate-slide-up-fade"
            @click="paused ? togglePause() : jumpToLatest()"
          >
            <ArrowDown class="h-3.5 w-3.5" />
            {{
              paused && newWhilePaused > 0
                ? `Resume · ${newWhilePaused.toLocaleString()} new lines`
                : "Jump to latest"
            }}
          </button>
        </div>

        <!-- Status bar -->
        <div
          class="flex h-7 shrink-0 items-center gap-3 border-t bg-surface-1 px-3 text-2xs text-muted-foreground"
          role="status"
        >
          <span class="inline-flex items-center gap-1.5">
            <StatusDot :tone="statusTone" size="sm" />
            {{ statusText }}
          </span>
          <span class="tabular-nums">
            {{ rows.length.toLocaleString() }}
            <template v-if="rows.length !== totalLines">
              of {{ totalLines.toLocaleString() }}</template
            >
            lines
          </span>
          <span v-if="rate > 0 && follow && !previous" class="tabular-nums"
            >{{ rate.toLocaleString() }} lines/s</span
          >
          <span v-if="paused" class="font-medium text-warning">Paused</span>
          <button
            v-if="needsSignIn && rows.length > 0"
            type="button"
            class="rounded-sm font-medium text-link hover:underline focus-ring"
            :disabled="authView.signingIn"
            @click="signIn"
          >
            {{ authView.signingIn ? "Signing in…" : "Sign in" }}
          </button>
          <span
            v-if="lastNotice"
            class="ml-auto inline-flex min-w-0 items-center gap-1.5"
            :class="
              lastNotice.level === 'error'
                ? 'text-destructive'
                : lastNotice.level === 'warning'
                  ? 'text-warning'
                  : ''
            "
            :title="notices.map((n) => n.message).join('\n')"
          >
            <TriangleAlert
              v-if="lastNotice.level !== 'info'"
              class="h-3 w-3 shrink-0"
            />
            <span class="truncate">{{ lastNotice.message }}</span>
            <span v-if="notices.length > 1" class="shrink-0 tabular-nums"
              >(+{{ notices.length - 1 }})</span
            >
          </span>
        </div>
      </div>
    </div>
  </TooltipProvider>
</template>

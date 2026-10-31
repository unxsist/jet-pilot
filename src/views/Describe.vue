<script setup lang="ts">
/**
 * Describe tab: the native describe (a structured document from the API,
 * no kubectl needed) by default, `kubectl describe` output for those used
 * to it, and the object's YAML. Cmd/Ctrl+F searches the document or the
 * kubectl output in place; the YAML view uses the editor's own search.
 */
import yaml from "js-yaml";
import { clusterArgs } from "@/lib/workloads";
import Loading from "@/components/Loading.vue";
import MonacoView from "@/components/monaco/MonacoView.vue";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Kbd } from "@/components/ui/kbd";
import {
  Check,
  ChevronDown,
  ChevronUp,
  Copy,
  RefreshCw,
  Search,
  TriangleAlert,
} from "lucide-vue-next";
import { error } from "@/lib/logger";
import { Command } from "@tauri-apps/plugin-shell";
import { routedCliArgs } from "@/lib/clusters/connection";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { type as getOsType } from "@tauri-apps/plugin-os";
import NativeDescribe from "@/views/describe/NativeDescribe.vue";
import { describeStrings, describeText, matchStarts, type DescribeDoc } from "@/lib/resources/describe";
import { loadDescribe } from "@/lib/resources/describeLoad";
import { preferredDescribeView } from "@/views/describe/preference";

const props = defineProps<{
  context: string;
  namespace?: string;
  kubeConfig: string;
  type: string;
  name: string;
}>();

const mod = getOsType() === "macos" ? "⌘" : "Ctrl+";
/* "native": the structured describe; "describe": kubectl's text. */
type View = "native" | "describe" | "yaml";
const VIEWS: { id: View; label: string }[] = [
  { id: "native", label: "Describe" },
  { id: "describe", label: "kubectl describe" },
  { id: "yaml", label: "YAML" },
];
const view = ref<View>(preferredDescribeView.value);
const contents = reactive<Record<View, string>>({ native: "", describe: "", yaml: "" });
const loaded = reactive<Record<View, boolean>>({ native: false, describe: false, yaml: false });
const doc = shallowRef<DescribeDoc | null>(null);
const target = computed(() => ({ context: props.context, kubeConfig: props.kubeConfig }));
const loading = ref(true);
const describeError = ref<string | null>(null);

const runKubectl = async (args: string[]) => {
  const fullArgs = [
    ...args,
    ...clusterArgs({
      context: props.context,
      kubeConfig: props.kubeConfig,
      namespace: props.namespace,
    }),
  ];
  // Only the exit code decides success: kubectl also writes warnings to
  // stderr.
  const { code, stdout, stderr } = await Command.create("kubectl", await routedCliArgs(fullArgs)).execute();
  if (code !== 0) throw new Error(stderr.trim() || `kubectl exited with code ${code}`);
  return stdout;
};

/* The object as `kubectl get -o yaml` shows it: without managed fields (and the app's tags). */
const objectYaml = (object: any) => {
  const metadata = { ...object.metadata };
  for (const key of ["context", "kubeConfig", "managedFields"]) delete metadata[key];
  return yaml.dump({ ...object, metadata }, { lineWidth: 120, noArrayIndent: true });
};

/* The native describe and the YAML come from the same request. */
const loadNative = async () => {
  const result = await loadDescribe(target.value, props.type, props.name, props.namespace || undefined);
  doc.value = result.doc;
  contents.native = describeText(result.doc);
  contents.yaml = objectYaml(result.object);
  loaded.native = loaded.yaml = true;
};

const fetchView = async (which: View) => {
  loading.value = true;
  describeError.value = null;
  try {
    if (which === "describe") {
      contents.describe = await runKubectl(["describe", `${props.type}/${props.name}`]);
      loaded.describe = true;
    } else {
      await loadNative();
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    error(`Error loading ${which} for ${props.type}/${props.name}: ${message}`);
    describeError.value = message;
  } finally {
    loading.value = false;
  }
};

const refresh = () => fetchView(view.value);

/* kubectl can't be started (not installed, not found): not an error of the object. */
const kubectlMissing = computed(
  () =>
    view.value === "describe" &&
    /no such file|program not found|cannot find the file|failed to spawn|program not allowed|os error 2/i.test(describeError.value ?? "")
);

const setView = (which: View) => {
  view.value = which;
  // The choice between the two describes sticks for the session.
  if (which !== "yaml") preferredDescribeView.value = which;
  if (!loaded[which]) fetchView(which);
  else describeError.value = null;
};

const root = ref<HTMLElement | null>(null);
onMounted(() => {
  // Take focus so Cmd/Ctrl+F searches this output, not the table behind.
  root.value?.focus({ preventScroll: true });
  fetchView(view.value);
});

/* --------------------------------------------------------------- copy -- */
const copied = ref(false);
let copiedTimer: ReturnType<typeof setTimeout> | undefined;
const copy = async () => {
  try {
    await writeText(contents[view.value]);
    copied.value = true;
    clearTimeout(copiedTimer);
    copiedTimer = setTimeout(() => (copied.value = false), 1500);
  } catch (e) {
    error(`Failed to copy to the clipboard: ${e}`);
  }
};
onUnmounted(() => clearTimeout(copiedTimer));

/* ------------------------------------------------------------- search -- */
const query = ref("");
const searchInput = ref<InstanceType<typeof Input> | null>(null);
const activeMatch = ref(0);
const yamlView = ref<InstanceType<typeof MonacoView> | null>(null);

/*
 * Light syntax colouring of `kubectl describe` output: top-level sections
 * stand out, nested keys are muted, Warning events are tinted.
 */
const describeLines = computed(() =>
  contents.describe
    .replace(/\n$/, "")
    .split("\n")
    .map((line) => {
      const match = /^(\s*)([A-Za-z][\w .\-/()]{0,48}?:)(\s.*|$)/.exec(line);
      if (/^\s+Warning\s/.test(line)) {
        return { text: line, keyStart: 0, keyEnd: 0, class: "text-warning", keyClass: "" };
      }
      if (!match) return { text: line, keyStart: 0, keyEnd: 0, class: "", keyClass: "" };
      const section = match[1].length === 0 && match[3].trim() === "";
      return {
        text: line,
        keyStart: match[1].length,
        keyEnd: match[1].length + match[2].length,
        class: section ? "mt-1" : "",
        keyClass: section ? "font-semibold text-foreground" : "text-muted-foreground",
      };
    })
);

/* Matches as [line, start] pairs, case-insensitive. */
const matches = computed(() => {
  const needle = query.value.toLowerCase();
  if (!needle) return [] as [number, number][];
  const found: [number, number][] = [];
  describeLines.value.forEach((line, index) => {
    const haystack = line.text.toLowerCase();
    let from = haystack.indexOf(needle);
    while (from !== -1) {
      found.push([index, from]);
      from = haystack.indexOf(needle, from + needle.length);
    }
  });
  return found;
});

/* line -> [{ start, index }] of its matches. */
const matchesByLine = computed(() => {
  const byLine = new Map<number, { start: number; index: number }[]>();
  matches.value.forEach(([line, start], index) => {
    if (!byLine.has(line)) byLine.set(line, []);
    byLine.get(line)!.push({ start, index });
  });
  return byLine;
});

/* The native document: each text's first match number, in reading order. */
const nativeMatches = computed(() => {
  const starts = new Map<string, number>();
  let total = 0;
  if (doc.value && query.value) {
    for (const [key, text] of describeStrings(doc.value)) {
      starts.set(key, total);
      total += matchStarts(text, query.value).length;
    }
  }
  return { starts, total };
});
const matchCount = computed(() =>
  view.value === "native" ? nativeMatches.value.total : matches.value.length
);
const searchable = computed(() => view.value !== "yaml");

watch([query, view], () => {
  activeMatch.value = 0;
  nextTick(scrollToActive);
});

/* A line split into plain / key / match segments for rendering. */
const segmentsFor = (index: number) => {
  const line = describeLines.value[index];
  const cuts = new Set<number>([0, line.text.length]);
  if (line.keyEnd) {
    cuts.add(line.keyStart);
    cuts.add(line.keyEnd);
  }
  const length = query.value.length;
  const lineMatches = matchesByLine.value.get(index) || [];
  for (const { start } of lineMatches) {
    cuts.add(start);
    cuts.add(start + length);
  }
  const points = [...cuts].sort((a, b) => a - b);
  const segments: { text: string; class: string; match: number }[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const [from, to] = [points[i], points[i + 1]];
    if (from === to) continue;
    const isKey = line.keyEnd && from >= line.keyStart && to <= line.keyEnd;
    const match = lineMatches.find(({ start }) => from >= start && to <= start + length);
    segments.push({
      text: line.text.slice(from, to),
      class: isKey ? line.keyClass : "",
      match: match ? match.index : -1,
    });
  }
  return segments;
};


const scrollToActive = () => {
  root.value
    ?.querySelector(`[data-describe-match="${activeMatch.value}"]`)
    ?.scrollIntoView({ block: "center" });
};

const step = (delta: number) => {
  const total = matchCount.value;
  if (!total) return;
  activeMatch.value = (activeMatch.value + delta + total) % total;
  nextTick(scrollToActive);
};

const focusSearch = () => {
  if (view.value === "yaml") {
    yamlView.value?.find();
    return;
  }
  const el = (searchInput.value as any)?.$el as HTMLInputElement | undefined;
  el?.focus();
  el?.select();
};

const onSearchKeydown = (event: KeyboardEvent) => {
  if (event.key === "Enter") {
    event.preventDefault();
    step(event.shiftKey ? -1 : 1);
  } else if (event.key === "Escape") {
    event.preventDefault();
    query.value = "";
  }
};

const onKeydown = (event: KeyboardEvent) => {
  if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === "f") {
    event.preventDefault();
    focusSearch();
  }
};
</script>
<template>
  <div
    ref="root"
    tabindex="-1"
    class="flex h-full flex-col bg-background outline-none"
    @keydown="onKeydown"
  >
    <div
      class="flex h-9 shrink-0 items-center gap-2 border-b border-border-subtle px-3"
      role="toolbar"
      :aria-label="`${type}/${name}`"
    >
      <div
        class="inline-flex h-6 items-center rounded-md bg-muted p-0.5"
        role="group"
        aria-label="View"
      >
        <button
          v-for="option in VIEWS"
          :key="option.id"
          type="button"
          class="h-5 rounded-[5px] px-2 text-2xs font-medium transition-colors duration-fast focus-ring"
          :class="
            view === option.id
              ? 'bg-background text-foreground shadow-sm dark:bg-accent'
              : 'text-muted-foreground hover:text-foreground'
          "
          :aria-pressed="view === option.id"
          @click="setView(option.id)"
        >
          {{ option.label }}
        </button>
      </div>
      <span v-if="view === 'describe'" class="truncate font-mono text-xs text-muted-foreground">
        kubectl describe {{ type }}/{{ name }}
      </span>

      <div class="ml-auto flex items-center gap-1">
        <div v-if="searchable" class="relative flex w-56 items-center">
          <Search
            class="pointer-events-none absolute left-2 h-3.5 w-3.5 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            ref="searchInput"
            v-model="query"
            type="text"
            :placeholder="`Find (${mod}F)`"
            aria-label="Find in output"
            class="h-6 pl-7 pr-14 text-xs"
            @keydown="onSearchKeydown"
          />
          <span
            v-if="query"
            class="pointer-events-none absolute right-2 text-2xs text-muted-foreground tnum"
            aria-live="polite"
          >
            {{ matchCount ? `${activeMatch + 1}/${matchCount}` : "0/0" }}
          </span>
        </div>
        <template v-if="searchable && query">
          <Button
            variant="ghost"
            size="icon-xs"
            class="text-muted-foreground"
            aria-label="Previous match"
            title="Previous match (Shift+Enter)"
            :disabled="!matchCount"
            @click="step(-1)"
          >
            <ChevronUp class="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon-xs"
            class="text-muted-foreground"
            aria-label="Next match"
            title="Next match (Enter)"
            :disabled="!matchCount"
            @click="step(1)"
          >
            <ChevronDown class="h-3.5 w-3.5" />
          </Button>
        </template>
        <Button
          v-else-if="view === 'yaml'"
          variant="ghost"
          size="xs"
          class="text-muted-foreground"
          title="Find"
          @click="focusSearch"
        >
          <Search class="h-3.5 w-3.5" />
          <Kbd variant="ghost" size="sm">{{ mod }}F</Kbd>
        </Button>
        <Button
          variant="ghost"
          size="icon-xs"
          class="text-muted-foreground"
          :aria-label="copied ? 'Copied' : 'Copy to clipboard'"
          :title="copied ? 'Copied' : 'Copy to clipboard'"
          :disabled="!contents[view]"
          @click="copy"
        >
          <Check v-if="copied" class="h-3.5 w-3.5 text-success" />
          <Copy v-else class="h-3.5 w-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon-xs"
          class="text-muted-foreground"
          aria-label="Refresh"
          title="Refresh"
          @click="refresh"
        >
          <RefreshCw class="h-3.5 w-3.5" :class="{ 'animate-spin': loading }" />
        </Button>
      </div>
    </div>

    <Loading
      v-if="loading && !loaded[view]"
      :label="view === 'yaml' ? `Loading ${type}/${name}…` : `Describing ${type}/${name}…`"
    />
    <div
      v-else-if="describeError && !loaded[view]"
      role="alert"
      class="flex min-h-0 flex-1 items-center justify-center p-4"
    >
      <EmptyState
        :icon="TriangleAlert"
        :title="kubectlMissing ? `kubectl isn't available` : `Couldn't ${view === 'yaml' ? 'load' : 'describe'} ${type}/${name}`"
        class="max-w-xl"
      >
        <p v-if="kubectlMissing" class="text-sm text-muted-foreground">
          JET Pilot can't run kubectl here. The Describe view shows the same and more without it.
        </p>
        <pre v-else class="whitespace-pre-wrap break-words font-mono text-xs select-text">{{
          describeError
        }}</pre>
        <template #action>
          <Button v-if="kubectlMissing" variant="outline" size="sm" @click="setView('native')">Show Describe</Button>
          <Button v-else variant="outline" size="sm" @click="refresh">
            <RefreshCw class="h-3.5 w-3.5" />
            Retry
          </Button>
        </template>
      </EmptyState>
    </div>
    <NativeDescribe
      v-else-if="view === 'native' && doc"
      :doc="doc"
      :target="target"
      :query="query"
      :active="activeMatch"
      :starts="nativeMatches.starts"
    />
    <pre
      v-else-if="view === 'describe'"
      class="min-h-0 flex-1 cursor-text overflow-auto px-4 py-3 font-mono text-xs leading-5 text-foreground select-text"
      data-testid="describe-output"
    ><div
        v-for="(line, index) in describeLines"
        :key="index"
        class="min-h-5"
        :class="line.class"
      ><template v-if="line.keyEnd || matchesByLine.has(index)"><span
          v-for="(segment, s) in segmentsFor(index)"
          :key="s"
          :class="[
            segment.class,
            segment.match >= 0 &&
              (segment.match === activeMatch
                ? 'rounded-[2px] bg-warning/50 text-foreground ring-1 ring-warning'
                : 'rounded-[2px] bg-warning/20'),
          ]"
          :data-describe-match="segment.match >= 0 ? segment.match : undefined"
        >{{ segment.text }}</span></template><template v-else>{{ line.text }}</template></div></pre>
    <div v-else class="min-h-0 flex-1">
      <MonacoView ref="yamlView" :value="contents.yaml" />
    </div>
  </div>
</template>

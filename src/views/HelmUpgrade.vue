<script setup lang="ts">
import yaml from "js-yaml";
import {
  CircleArrowUp,
  FileDiff,
  Loader2,
  RotateCcw,
  TriangleAlert,
} from "lucide-vue-next";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { toast } from "@/components/ui/toast";
import KindIcon from "@/components/KindIcon.vue";
import DiffView from "@/components/workloads/DiffView.vue";
import ValuesEditor from "@/components/workloads/ValuesEditor.vue";
import {
  CliResult,
  cliErrorMessage,
  cliSucceeded,
  runCli,
  runHelmWithValues,
} from "@/actions/command";
import { injectStrict } from "@/lib/utils";
import { error } from "@/lib/logger";
import { DialogProviderSpawnDialogKey } from "@/providers/DialogProvider";
import { helmClusterArgs } from "@/lib/workloads";
import { diffLines, diffSummary } from "@/lib/diff";
import {
  ChartSearchResult,
  chartVersionsByRepo,
  hasDiffPlugin,
  helmStatusTone,
  normalizeValues,
  parseChartField,
  stripAnsi,
} from "@/lib/helm";

/*
 * Helm upgrade with a values diff: edit the release's user-supplied values,
 * pick the chart (repo reference) and version, preview the change (the
 * helm-diff plugin when installed, otherwise rendered manifests vs. the
 * deployed manifest), then upgrade after a confirmation.
 */
const props = defineProps<{
  context: string;
  namespace: string;
  kubeConfig: string;
  release: {
    name: string;
    namespace: string;
    chart: string;
    app_version?: string;
    revision: number | string;
    status: string;
  };
  tabId?: string;
}>();

const spawnDialog = injectStrict(DialogProviderSpawnDialogKey);

const cluster = computed(() =>
  helmClusterArgs({
    context: props.context,
    namespace: props.release.namespace,
    kubeConfig: props.kubeConfig,
  })
);

const installed = computed(() => parseChartField(props.release.chart));

const loading = ref(true);
const loadError = ref("");
const currentValues = ref("");
const values = ref("");

/* chart reference (repo/chart, oci://..., path) -> versions */
const repoVersions = shallowRef(new Map<string, ChartSearchResult[]>());
const chartRef = ref("");
const customRef = ref(false);
const version = ref("");
const diffPlugin = ref(false);

const atomic = ref(false);
const wait = ref(false);

const tab = ref("values");

const helm = (args: string[]) => runCli("helm", [...args, ...cluster.value]);

const load = async () => {
  loading.value = true;
  loadError.value = "";

  const [valuesResult, searchResult, pluginResult] = await Promise.all([
    helm(["get", "values", props.release.name, "--output=yaml"]),
    runCli("helm", ["search", "repo", installed.value.name, "--versions", "--output=json"]),
    runCli("helm", ["plugin", "list"]),
  ]);

  if (!cliSucceeded(valuesResult)) {
    loadError.value = cliErrorMessage(valuesResult);
    loading.value = false;
    return;
  }
  currentValues.value = normalizeValues(valuesResult.stdout);
  values.value = currentValues.value;
  diffPlugin.value = cliSucceeded(pluginResult) && hasDiffPlugin(pluginResult.stdout);

  if (cliSucceeded(searchResult)) {
    try {
      repoVersions.value = chartVersionsByRepo(
        JSON.parse(searchResult.stdout),
        installed.value.name
      );
    } catch (e) {
      error(`Unable to parse helm search output: ${e}`);
    }
  }

  const refs = [...repoVersions.value.keys()];
  customRef.value = refs.length === 0;
  chartRef.value = refs[0] ?? "";
  version.value = installed.value.version;
  loading.value = false;
};

const versions = computed(() =>
  customRef.value ? [] : repoVersions.value.get(chartRef.value) ?? []
);

watch(chartRef, () => {
  // Keep the installed version when the repo has it, else the newest.
  const list = versions.value;
  if (list.length && !list.some((v) => v.version === version.value)) {
    version.value = list[0].version;
  }
});

const latest = computed(() => versions.value[0]?.version);

const toggleCustomRef = () => {
  customRef.value = !customRef.value;
  if (!customRef.value) {
    chartRef.value = [...repoVersions.value.keys()][0] ?? "";
  }
};

/* ---------------------------------------------------------- values -- */

const valuesError = computed(() => {
  try {
    const parsed = yaml.load(values.value);
    if (parsed !== undefined && parsed !== null && typeof parsed !== "object") {
      return "Values must be a YAML mapping";
    }
    return "";
  } catch (e) {
    return e instanceof Error ? e.message.split("\n")[0] : String(e);
  }
});

const valuesSummary = computed(() =>
  diffSummary(diffLines(currentValues.value, values.value))
);
const valuesChanged = computed(
  () => valuesSummary.value.added + valuesSummary.value.removed > 0
);

/* --------------------------------------------------------- preview -- */

const preview = shallowRef<
  | { kind: "plugin"; output: string }
  | { kind: "manifest"; old: string; new: string }
  | { kind: "error"; message: string }
  | null
>(null);
const previewing = ref(false);
let previewKey = "";

const chartArgs = () => [
  props.release.name,
  chartRef.value.trim(),
  ...(version.value.trim() ? [`--version=${version.value.trim()}`] : []),
];

const canRun = computed(
  () => !!chartRef.value.trim() && !valuesError.value && !loading.value
);

const runPreview = async () => {
  if (!canRun.value) return;
  previewing.value = true;
  previewKey = `${chartRef.value}|${version.value}|${values.value}`;
  try {
    if (diffPlugin.value) {
      const result = await runHelmWithValues(
        ["diff", "upgrade", ...chartArgs(), "--no-color", "--context=3", ...cluster.value],
        values.value
      );
      preview.value = cliSucceeded(result)
        ? { kind: "plugin", output: stripAnsi(result.stdout) }
        : { kind: "error", message: cliErrorMessage(result) };
      return;
    }

    const [deployed, rendered] = await Promise.all([
      helm(["get", "manifest", props.release.name]),
      runHelmWithValues(["template", ...chartArgs(), ...cluster.value], values.value),
    ]);
    const failed = [deployed, rendered].find((r) => !cliSucceeded(r)) as CliResult | undefined;
    preview.value = failed
      ? { kind: "error", message: cliErrorMessage(failed) }
      : { kind: "manifest", old: deployed.stdout, new: rendered.stdout };
  } finally {
    previewing.value = false;
  }
};

const previewStale = computed(
  () =>
    preview.value !== null &&
    previewKey !== `${chartRef.value}|${version.value}|${values.value}`
);

watch(tab, (value) => {
  if (value === "manifest" && (preview.value === null || previewStale.value)) {
    runPreview();
  }
});

const pluginLines = computed(() =>
  preview.value?.kind === "plugin"
    ? preview.value.output.split("\n").map((text) => ({
        text,
        tone: /^\s*\+/.test(text)
          ? "bg-success/10"
          : /^\s*-/.test(text)
            ? "bg-destructive/10"
            : /^\S.*, \S+, \S+ \(.*\) has (changed|been added|been removed)/.test(text)
              ? "mt-2 font-semibold text-foreground"
              : "",
      }))
    : []
);

/* --------------------------------------------------------- upgrade -- */

const upgrading = ref(false);

const confirmUpgrade = () => {
  if (!canRun.value) return;
  const target = `${chartRef.value.trim()}${version.value ? ` ${version.value}` : ""}`;
  const changes = valuesChanged.value
    ? `+${valuesSummary.value.added} −${valuesSummary.value.removed} lines of values`
    : "values unchanged";

  spawnDialog({
    title: `Upgrade ${props.release.name}?`,
    message:
      `${installed.value.name} ${installed.value.version} → ${target}, ${changes}.` +
      (atomic.value ? " Rolled back automatically if the upgrade fails." : "") +
      `\nRelease ${props.release.namespace} on ${props.context}.`,
    buttons: [
      { label: "Cancel", variant: "ghost", handler: (dialog) => dialog.close() },
      {
        label: "Upgrade",
        handler: (dialog) => {
          dialog.close();
          upgrade();
        },
      },
    ],
  });
};

const upgrade = async () => {
  upgrading.value = true;
  const result = await runHelmWithValues(
    [
      "upgrade",
      ...chartArgs(),
      ...(atomic.value ? ["--atomic"] : []),
      ...(wait.value && !atomic.value ? ["--wait"] : []),
      ...cluster.value,
    ],
    values.value
  );
  upgrading.value = false;

  if (cliSucceeded(result)) {
    const revision = /REVISION:\s*(\d+)/.exec(result.stdout)?.[1];
    toast({
      title: `Upgraded ${props.release.name}`,
      description: revision ? `Now at revision ${revision}` : undefined,
      variant: "success",
      autoDismiss: true,
    });
    preview.value = null;
    await load();
    return;
  }

  const message = cliErrorMessage(result);
  error(`helm upgrade ${props.release.name} failed: ${message}`);
  toast({
    title: `Upgrade of ${props.release.name} failed`,
    description: message,
    variant: "destructive",
    duration: 15000,
  });
};

/* ⌘/Ctrl+Enter upgrades. */
const onKeydown = (event: KeyboardEvent) => {
  if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
    event.preventDefault();
    confirmUpgrade();
  }
};

onMounted(load);
</script>

<template>
  <div class="flex h-full flex-col bg-background" @keydown="onKeydown">
    <div class="flex h-11 shrink-0 items-center gap-3 border-b bg-surface-1 px-3">
      <KindIcon name="helm" class="text-muted-foreground" />
      <span class="truncate text-sm font-medium">Upgrade {{ release.name }}</span>
      <span class="hidden truncate text-xs text-muted-foreground md:inline"
        >{{ context }} › {{ release.namespace }}</span
      >
      <Badge variant="outline" size="sm" class="font-mono">{{ release.chart }}</Badge>
      <Badge :variant="helmStatusTone(release.status)" size="sm">{{ release.status }}</Badge>
      <span class="ml-auto text-xs tabular-nums text-muted-foreground"
        >revision {{ release.revision }}</span
      >
    </div>

    <div v-if="loading" class="flex flex-1 items-center justify-center">
      <Loader2 class="h-5 w-5 animate-spin text-muted-foreground" />
    </div>
    <div v-else-if="loadError" class="flex flex-1 items-center justify-center p-4">
      <EmptyState :icon="TriangleAlert" :title="`Unable to load ${release.name}`" class="max-w-xl">
        <pre class="whitespace-pre-wrap break-words font-mono text-xs select-text">{{ loadError }}</pre>
        <template #action>
          <Button variant="outline" size="sm" @click="load">Retry</Button>
        </template>
      </EmptyState>
    </div>
    <div v-else class="flex min-h-0 flex-1">
      <!-- Chart + options -->
      <form
        class="flex w-80 min-w-[18rem] flex-col gap-5 overflow-y-auto border-r bg-surface-1 p-4"
        @submit.prevent="confirmUpgrade"
      >
        <section class="space-y-3">
          <h3 class="text-2xs font-semibold uppercase tracking-[0.06em] text-muted-foreground">
            Chart
          </h3>
          <div class="grid gap-1.5">
            <Label for="helm-chart-ref">Chart reference</Label>
            <Select
              v-if="!customRef"
              v-model="chartRef"
            >
              <SelectTrigger id="helm-chart-ref" class="font-mono text-xs">
                <SelectValue placeholder="Select a chart" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem
                  v-for="ref in repoVersions.keys()"
                  :key="ref"
                  :value="ref"
                  class="font-mono text-xs"
                  >{{ ref }}</SelectItem
                >
              </SelectContent>
            </Select>
            <Input
              v-else
              id="helm-chart-ref"
              v-model="chartRef"
              class="font-mono text-xs"
              placeholder="repo/chart, oci://… or a path"
            />
            <button
              v-if="!customRef || repoVersions.size > 0"
              type="button"
              class="justify-self-start rounded-sm text-xs text-link hover:underline focus-ring"
              @click="toggleCustomRef"
            >
              {{ customRef ? "Pick from repositories" : "Enter a reference" }}
            </button>
            <p
              v-if="repoVersions.size === 0"
              class="text-xs text-muted-foreground"
            >
              {{ installed.name }} was not found in your Helm repositories
              (<span class="font-mono">helm repo add</span>, then
              <span class="font-mono">helm repo update</span>). Enter the chart
              reference instead.
            </p>
          </div>

          <div class="grid gap-1.5">
            <Label for="helm-chart-version">Version</Label>
            <Select v-if="versions.length" v-model="version">
              <SelectTrigger id="helm-chart-version" class="font-mono text-xs">
                <SelectValue placeholder="Select a version" />
              </SelectTrigger>
              <SelectContent class="max-h-72">
                <SelectItem
                  v-for="v in versions"
                  :key="v.version"
                  :value="v.version"
                  class="font-mono text-xs"
                >
                  {{ v.version }}
                  <span class="text-muted-foreground">
                    · app {{ v.app_version || "–" }}
                    {{ v.version === installed.version ? "· installed" : v.version === latest ? "· latest" : "" }}
                  </span>
                </SelectItem>
              </SelectContent>
            </Select>
            <Input
              v-else
              id="helm-chart-version"
              v-model="version"
              class="font-mono text-xs"
              placeholder="Latest"
            />
            <p class="text-xs text-muted-foreground">
              Installed: <span class="font-mono">{{ installed.version || "unknown" }}</span>
              <template v-if="release.app_version">
                (app <span class="font-mono">{{ release.app_version }}</span>)</template
              >
            </p>
          </div>
        </section>

        <section class="space-y-3">
          <h3 class="text-2xs font-semibold uppercase tracking-[0.06em] text-muted-foreground">
            Options
          </h3>
          <label class="flex cursor-pointer items-start gap-2 text-sm">
            <Checkbox :checked="atomic" class="mt-0.5" @update:checked="atomic = $event === true" />
            <span>
              Atomic
              <span class="block text-xs text-muted-foreground"
                >Wait for resources and roll back automatically if the upgrade fails</span
              >
            </span>
          </label>
          <label class="flex cursor-pointer items-start gap-2 text-sm" :class="atomic ? 'opacity-50' : ''">
            <Checkbox :checked="wait" :disabled="atomic" class="mt-0.5" @update:checked="wait = $event === true" />
            <span>
              Wait
              <span class="block text-xs text-muted-foreground"
                >Wait until pods, services and PVCs are ready</span
              >
            </span>
          </label>
          <p class="text-xs text-muted-foreground">
            The edited values replace the release's user values (no
            <span class="font-mono">--reuse-values</span>).
          </p>
        </section>

        <div class="mt-auto space-y-2">
          <Button
            type="button"
            variant="outline"
            class="w-full"
            :disabled="!canRun || previewing"
            @click="tab = 'manifest'; runPreview()"
          >
            <Loader2 v-if="previewing" class="h-3.5 w-3.5 animate-spin" />
            <FileDiff v-else class="h-3.5 w-3.5" />
            Preview changes
          </Button>
          <Button type="submit" class="w-full" :disabled="!canRun || upgrading">
            <Loader2 v-if="upgrading" class="h-3.5 w-3.5 animate-spin" />
            <CircleArrowUp v-else class="h-3.5 w-3.5" />
            Upgrade…
          </Button>
          <p class="text-center text-2xs text-muted-foreground">
            {{ diffPlugin ? "Preview uses the helm-diff plugin" : "Preview renders the chart (helm template)" }}
            · <kbd class="font-sans">Ctrl/⌘ Enter</kbd> upgrades
          </p>
        </div>
      </form>

      <!-- Values / diffs -->
      <Tabs v-model="tab" class="flex min-w-0 flex-1 flex-col">
        <div class="flex shrink-0 items-center gap-3 border-b px-3">
          <TabsList variant="line" class="border-0">
            <TabsTrigger value="values">Values</TabsTrigger>
            <TabsTrigger value="values-diff">
              Values diff
              <span
                v-if="valuesChanged"
                class="ml-1.5 font-mono text-2xs tabular-nums"
                ><span class="text-success">+{{ valuesSummary.added }}</span>
                <span class="text-destructive">−{{ valuesSummary.removed }}</span></span
              >
            </TabsTrigger>
            <TabsTrigger value="manifest">Manifest diff</TabsTrigger>
          </TabsList>
          <span v-if="valuesError" class="truncate text-xs text-destructive" role="alert">
            {{ valuesError }}
          </span>
          <Button
            v-if="tab === 'values' && valuesChanged"
            variant="ghost"
            size="sm"
            class="ml-auto text-muted-foreground"
            @click="values = currentValues"
          >
            <RotateCcw class="h-3.5 w-3.5" />
            Reset
          </Button>
        </div>
        <TabsContent value="values" class="mt-0 min-h-0 flex-1">
          <ValuesEditor v-model="values" :invalid="!!valuesError" :label="`Values of ${release.name}`" />
        </TabsContent>
        <TabsContent value="values-diff" class="mt-0 min-h-0 flex-1">
          <DiffView
            :old-text="currentValues"
            :new-text="values"
            :old-label="`revision ${release.revision}`"
            new-label="edited"
            empty-text="Values unchanged"
          />
        </TabsContent>
        <TabsContent value="manifest" class="mt-0 min-h-0 flex-1">
          <div class="flex h-full flex-col [&>*:first-child]:min-h-0 [&>*:first-child]:flex-1">
          <div v-if="previewing" class="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
            <Loader2 class="h-4 w-4 animate-spin" />
            Rendering {{ chartRef }} {{ version }}…
          </div>
          <div v-else-if="preview?.kind === 'error'" class="flex h-full items-center justify-center p-4">
            <EmptyState :icon="TriangleAlert" title="Preview failed" class="max-w-xl">
              <pre class="whitespace-pre-wrap break-words text-left font-mono text-xs select-text">{{ preview.message }}</pre>
            </EmptyState>
          </div>
          <DiffView
            v-else-if="preview?.kind === 'manifest'"
            :old-text="preview.old"
            :new-text="preview.new"
            :old-label="`deployed (revision ${release.revision})`"
            :new-label="`${chartRef} ${version}`"
            empty-text="No manifest changes"
          />
          <div
            v-else-if="preview?.kind === 'plugin'"
            class="h-full overflow-auto py-2 font-mono text-xs leading-5 select-text"
          >
            <p v-if="!preview.output.trim()" class="px-3 text-muted-foreground">
              No changes
            </p>
            <div
              v-for="(line, i) in pluginLines"
              :key="i"
              class="whitespace-pre px-3"
              :class="line.tone"
            >{{ line.text }}</div>
          </div>
          <div v-else class="flex h-full items-center justify-center">
            <EmptyState :icon="FileDiff" title="Preview the upgrade" description="Renders the chart with the edited values and compares it with the deployed manifest." size="sm" />
          </div>
          <p
            v-if="previewStale"
            class="border-t bg-warning/10 px-3 py-1.5 text-xs text-warning"
          >
            The chart, version or values changed since this preview.
            <button type="button" class="font-medium underline" @click="runPreview">Refresh</button>
          </p>
          </div>
        </TabsContent>
      </Tabs>
    </div>
  </div>
</template>

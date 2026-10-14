<script setup lang="ts">
/*
 * Install a chart, calmly: pick the version, name the release, choose
 * where it goes, adjust the values (checked against the chart's schema
 * when it has one), preview what will be created (a dry run), install, and
 * read the chart's notes. Charts from Artifact Hub get their repository
 * added first, after asking.
 */
import { useRouter } from "vue-router";
import yaml from "js-yaml";
import {
  ArrowUpRight,
  BadgeCheck,
  CircleCheck,
  Eye,
  Loader2,
  Rocket,
  RotateCcw,
  ShieldCheck,
  TriangleAlert,
} from "lucide-vue-next";
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
import ContextAvatar from "@/components/ContextAvatar.vue";
import MonacoView from "@/components/monaco/MonacoView.vue";
import ChartAvatar from "./ChartAvatar.vue";
import ChartReadme from "./ChartReadme.vue";
import ReleaseNotes from "./ReleaseNotes.vue";
import ValuesCodeEditor from "./ValuesCodeEditor.vue";
import { reloadRepos, useHelmRepos } from "./repos";
import { open as openExternal } from "@tauri-apps/plugin-shell";
import { cliErrorMessage, cliSucceeded, runHelmWithValues } from "@/actions/command";
import { confirmDialog, guard } from "@/lib/guardrails/guard";
import { guardedCluster } from "@/lib/guardrails/backstop";
import { readOnlyReason } from "@/lib/guardrails/policy";
import { Kubernetes } from "@/services/Kubernetes";
import { injectStrict, formatResourceKind } from "@/lib/utils";
import { error as logError } from "@/lib/logger";
import { DialogProviderSpawnDialogKey } from "@/providers/DialogProvider";
import { KubeContextStateKey } from "@/providers/KubeContextProvider";
import { PanelProviderCloseTabKey } from "@/providers/PanelProvider";
import {
  addRepo,
  artifactHubPackage,
  artifactHubValues,
  artifactHubValuesSchema,
  inspectChart,
  searchRepos,
} from "@/lib/helmApi";
import {
  chartVersionsByRepo,
  groupByKind,
  installArgs,
  namespaceProblem,
  parseInstallOutput,
  parseManifest,
  pluralKindLabel,
  releaseNameProblem,
  suggestRepoName,
  timeAgo,
  type ChartEntry,
  type InstallResult,
} from "@/lib/helm";

const props = defineProps<{
  chart: ChartEntry;
  context: string;
  kubeConfig: string;
  /** The namespace to suggest ("" when several are selected). */
  namespace: string;
  tabId?: string;
}>();

const router = useRouter();
const spawnDialog = injectStrict(DialogProviderSpawnDialogKey);
const closeTab = injectStrict(PanelProviderCloseTabKey);
const { contexts, contextKubeConfigMapping } = injectStrict(KubeContextStateKey);
const { repos } = useHelmRepos();

/* ------------------------------------------------------------- chart -- */

interface VersionOption {
  version: string;
  appVersion: string;
  prerelease: boolean;
  updated?: number | null;
}

/* The repository the chart installs from (once added, for Artifact Hub). */
const localRepo = ref(props.chart.localRepo ?? "");
const reference = computed(() => (localRepo.value ? `${localRepo.value}/${props.chart.name}` : ""));
const fromHub = computed(() => props.chart.source === "artifacthub" && !props.chart.localRepo);

const versions = shallowRef<VersionOption[]>([]);
const version = ref(props.chart.version);
const showPrereleases = ref(false);
const description = ref(props.chart.description);
const home = ref("");
const readme = ref("");
const defaults = ref("");
const schema = shallowRef<Record<string, unknown> | null>(null);
const values = ref("");
const loadingChart = ref(true);
const loadingValues = ref(false);
const chartError = ref("");

const visibleVersions = computed(() =>
  versions.value.filter((v) => showPrereleases.value || !v.prerelease || v.version === version.value)
);
const latestVersion = computed(() => versions.value.find((v) => !v.prerelease)?.version);

const loadVersions = async () => {
  loadingChart.value = true;
  chartError.value = "";
  try {
    if (fromHub.value) {
      const pkg = await artifactHubPackage(props.chart.repo, props.chart.name);
      versions.value = pkg.versions;
      description.value = pkg.description || description.value;
      home.value = pkg.homeUrl ?? "";
      readme.value = pkg.readme;
    } else {
      const rows = await searchRepos(reference.value, true);
      const list = chartVersionsByRepo(rows, props.chart.name).get(reference.value) ?? [];
      versions.value = list.map((v) => ({ version: v.version, appVersion: v.app_version ?? "", prerelease: false }));
    }
    if (!versions.value.some((v) => v.version === version.value)) {
      version.value = latestVersion.value ?? versions.value[0]?.version ?? version.value;
    }
  } catch (e) {
    chartError.value = e instanceof Error ? e.message : String(e);
  } finally {
    loadingChart.value = false;
  }
};

/* Default values, schema and README of the chosen version. */
let valuesSeq = 0;
const loadVersion = async () => {
  if (!version.value) return;
  const seq = ++valuesSeq;
  const untouched = values.value === defaults.value;
  loadingValues.value = true;
  try {
    let next: { values: string; schema: Record<string, unknown> | null; readme?: string; home?: string };
    if (fromHub.value) {
      const hasSchema = (await artifactHubPackage(props.chart.repo, props.chart.name, version.value)).hasValuesSchema;
      const [text, valuesSchema] = await Promise.all([
        artifactHubValues(props.chart.packageId!, version.value),
        hasSchema ? artifactHubValuesSchema(props.chart.packageId!, version.value).catch(() => null) : null,
      ]);
      next = { values: text, schema: valuesSchema };
    } else {
      const pkg = await inspectChart(reference.value, version.value);
      next = {
        values: pkg.values,
        schema: pkg.valuesSchema ?? null,
        readme: pkg.readme,
        home: pkg.metadata.home ?? "",
      };
      if (pkg.metadata.description) description.value = pkg.metadata.description;
    }
    if (seq !== valuesSeq) return;
    defaults.value = next.values;
    schema.value = next.schema;
    if (next.readme !== undefined) readme.value = next.readme;
    if (next.home) home.value = next.home;
    // Keep what the user wrote; start from the defaults otherwise.
    if (untouched) values.value = next.values;
    chartError.value = "";
  } catch (e) {
    if (seq === valuesSeq) chartError.value = e instanceof Error ? e.message : String(e);
  } finally {
    if (seq === valuesSeq) loadingValues.value = false;
  }
};

watch(version, () => {
  preview.value = null;
  loadVersion();
});

onMounted(async () => {
  await loadVersions();
  if (!chartError.value) await loadVersion();
});

/* ----------------------------------------------------------- release -- */

const releaseName = ref(props.chart.name.toLowerCase().replace(/[^a-z0-9-]+/g, "-").slice(0, 53));
const cluster = ref(props.context);
const clusterKubeConfig = computed(
  () => contextKubeConfigMapping.value.get(cluster.value) ?? (cluster.value === props.context ? props.kubeConfig : "")
);
const clusters = computed(() => [...contexts.value.keys()]);
const namespace = ref(props.namespace || props.chart.name.toLowerCase().replace(/[^a-z0-9-]+/g, "-"));
const namespaces = shallowRef<string[] | null>(null);
const atomic = ref(true);
const touched = reactive({ name: false, namespace: false });

watch(
  [cluster, clusterKubeConfig],
  async () => {
    namespaces.value = null;
    try {
      const list = await Kubernetes.getNamespaces(cluster.value, clusterKubeConfig.value);
      namespaces.value = list.map((n) => n.metadata?.name ?? "").filter(Boolean).sort();
    } catch (e) {
      logError(`Unable to list namespaces of ${cluster.value}: ${e}`);
      namespaces.value = [];
    }
  },
  { immediate: true }
);

const newNamespace = computed(
  () => !!namespaces.value && !!namespace.value.trim() && !namespaces.value.includes(namespace.value.trim())
);
const nameProblem = computed(() => releaseNameProblem(releaseName.value));
const nsProblem = computed(() => namespaceProblem(namespace.value));

const valuesError = computed(() => {
  try {
    const parsed = yaml.load(values.value);
    if (parsed !== undefined && parsed !== null && (typeof parsed !== "object" || Array.isArray(parsed))) {
      return "Values must be a YAML mapping";
    }
    return "";
  } catch (e) {
    return e instanceof Error ? e.message.split("\n")[0] : String(e);
  }
});
const schemaProblems = ref<{ message: string; line: number }[]>([]);
const editor = ref<InstanceType<typeof ValuesCodeEditor> | null>(null);

const blocked = computed(() => {
  const c = guardedCluster(cluster.value, clusterKubeConfig.value);
  return c.readOnly ? readOnlyReason(c) : "";
});

const ready = computed(
  () =>
    !loadingChart.value &&
    !!version.value &&
    !nameProblem.value &&
    !nsProblem.value &&
    !valuesError.value &&
    !chartError.value
);

/* ------------------------------------------------- repository first -- */

/** The chart reference helm installs from; adds the repository first (asking) for Artifact Hub charts. */
const ensureReference = async (): Promise<string | null> => {
  if (reference.value) return reference.value;
  const name = suggestRepoName(props.chart.repo, repos.value);
  const confirmed = await confirmDialog(spawnDialog, {
    title: `Add the ${props.chart.repoLabel} repository?`,
    message: `Helm installs charts from repositories. JET Pilot adds ${props.chart.repoUrl} to your Helm repositories as “${name}”, then carries on.`,
    confirmLabel: "Add repository",
  });
  if (!confirmed) return null;
  try {
    await addRepo(name, props.chart.repoUrl ?? "");
    await reloadRepos();
    localRepo.value = name;
    return reference.value;
  } catch (e) {
    toast({
      title: `Couldn't add ${props.chart.repoLabel}`,
      description: e instanceof Error ? e.message : String(e),
      variant: "destructive",
      duration: 15000,
    });
    return null;
  }
};

/* ----------------------------------------------------------- preview -- */

const tab = ref<"values" | "preview" | "readme">("values");
const preview = shallowRef<{ result: InstallResult; key: string } | { error: string; key: string } | null>(null);
const previewing = ref(false);
const showManifest = ref(false);

const settingsKey = () =>
  JSON.stringify([version.value, releaseName.value, cluster.value, namespace.value, values.value]);

const options = (chart: string, dryRun: boolean) => ({
  release: releaseName.value,
  chart,
  version: version.value,
  namespace: namespace.value,
  createNamespace: newNamespace.value || !namespaces.value,
  context: cluster.value,
  kubeConfig: clusterKubeConfig.value,
  dryRun,
  atomic: atomic.value,
});

const runPreview = async () => {
  touched.name = touched.namespace = true;
  if (!ready.value || previewing.value) return;
  tab.value = "preview";
  const chart = await ensureReference();
  if (!chart) return;
  previewing.value = true;
  const key = settingsKey();
  try {
    const output = await runHelmWithValues(installArgs(options(chart, true)), values.value);
    const result = cliSucceeded(output) ? parseInstallOutput(output.stdout) : null;
    preview.value = result
      ? { result, key }
      : { error: cliSucceeded(output) ? "helm printed something unexpected" : cliErrorMessage(output), key };
  } finally {
    previewing.value = false;
  }
};

const previewStale = computed(() => !!preview.value && preview.value.key !== settingsKey());
const previewObjects = computed(() =>
  preview.value && "result" in preview.value
    ? parseManifest(preview.value.result.manifest, namespace.value)
    : []
);
const previewGroups = computed(() => groupByKind(previewObjects.value));

/* ----------------------------------------------------------- install -- */

const installing = ref(false);
const installError = ref("");
const installed = shallowRef<InstallResult | null>(null);

const install = async () => {
  touched.name = touched.namespace = true;
  if (!ready.value || installing.value) return;
  const chart = await ensureReference();
  if (!chart) return;
  const objects = previewObjects.value.length && !previewStale.value ? previewObjects.value.length : null;
  const confirmed = await guard(
    "helm-install",
    [{ context: cluster.value, kubeConfig: clusterKubeConfig.value, name: releaseName.value, kind: "release", namespace: namespace.value }],
    {
      confirm: () =>
        confirmDialog(spawnDialog, {
          title: `Install ${releaseName.value}?`,
          message:
            `${props.chart.name} ${version.value} into ${namespace.value}${newNamespace.value ? " (a new namespace)" : ""} on ${cluster.value}` +
            (objects ? `, ${objects} objects.` : ".") +
            (atomic.value ? " Undone automatically if it doesn't become ready." : ""),
          confirmLabel: "Install",
        }),
    }
  );
  if (!confirmed) return;
  installing.value = true;
  installError.value = "";
  try {
    const output = await runHelmWithValues(installArgs(options(chart, false)), values.value, { guarded: true });
    if (!cliSucceeded(output)) {
      installError.value = cliErrorMessage(output);
      return;
    }
    installed.value =
      parseInstallOutput(output.stdout) ?? { status: "deployed", revision: 1, manifest: "", notes: "", hooks: [] };
  } catch (e) {
    installError.value = e instanceof Error ? e.message : String(e);
  } finally {
    installing.value = false;
  }
};

const showRelease = () =>
  router.push({
    path: "/helm-releases",
    query: { resource: "release", kind: "Release", release: releaseName.value, namespace: namespace.value },
  });

/* ⌘/Ctrl+Enter installs. */
const onKeydown = (event: KeyboardEvent) => {
  if ((event.metaKey || event.ctrlKey) && event.key === "Enter" && !installed.value) {
    event.preventDefault();
    install();
  }
};

const mark = computed(() =>
  props.chart.official ? "Official chart" : props.chart.verified ? "Verified publisher" : ""
);
</script>

<template>
  <div class="flex h-full flex-col bg-background" @keydown="onKeydown">
    <!-- Header -->
    <div class="flex h-11 shrink-0 items-center gap-2.5 border-b bg-surface-1 px-3">
      <ChartAvatar :name="chart.name" :logo-image-id="chart.logoImageId" size="sm" />
      <span class="truncate text-sm font-medium">Install {{ chart.name }}</span>
      <span class="hidden items-center gap-1 truncate text-xs text-muted-foreground md:flex">
        from {{ chart.repoLabel }}
        <span v-if="mark" class="inline-flex" :title="mark">
          <ShieldCheck v-if="chart.official" class="h-3.5 w-3.5 text-link" />
          <BadgeCheck v-else class="h-3.5 w-3.5 text-link" />
        </span>
      </span>
      <span v-if="!installed" class="ml-auto flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
        <ContextAvatar :name="cluster" :kube-config="clusterKubeConfig" size="sm" class="h-4 w-4 text-[9px]" />
        <span class="truncate">{{ cluster }} › {{ namespace || "…" }}</span>
      </span>
    </div>

    <!-- Done -->
    <div v-if="installed" class="min-h-0 flex-1 overflow-auto">
      <div class="mx-auto max-w-2xl space-y-6 px-8 py-10">
        <div class="flex items-start gap-4">
          <span class="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-success/10 text-success">
            <CircleCheck class="h-6 w-6" />
          </span>
          <div class="min-w-0 space-y-1">
            <h2 class="text-lg font-semibold">Installed {{ releaseName }}</h2>
            <p class="text-sm text-muted-foreground">
              {{ chart.name }} {{ version }} is running in {{ namespace }} on {{ cluster }}.
            </p>
          </div>
        </div>
        <div class="flex items-center gap-2 pl-[60px]">
          <Button size="sm" @click="showRelease">Show the release</Button>
          <Button variant="ghost" size="sm" @click="tabId && closeTab(tabId)">Close</Button>
        </div>
        <div v-if="installed.notes.trim()" class="space-y-2 border-t pt-6">
          <h3 class="text-xs font-medium text-muted-foreground">Notes from the chart</h3>
          <ReleaseNotes :notes="installed.notes" />
        </div>
      </div>
    </div>

    <div v-else class="flex min-h-0 flex-1">
      <!-- What and where -->
      <form
        class="flex w-80 min-w-[18rem] flex-col gap-6 overflow-y-auto border-r bg-surface-1 p-4"
        @submit.prevent="install"
      >
        <section class="space-y-3">
          <div class="space-y-1.5">
            <p class="line-clamp-3 text-xs leading-relaxed text-muted-foreground">{{ description }}</p>
            <button
              v-if="home && /^https?:\/\//.test(home)"
              type="button"
              class="inline-flex items-center gap-0.5 rounded-sm text-xs text-link hover:underline focus-ring"
              :title="home"
              @click="openExternal(home)"
            >
              Website <ArrowUpRight class="h-3 w-3" />
            </button>
          </div>
          <div class="grid gap-1.5">
            <Label for="helm-install-version">Version</Label>
            <Select v-model="version" :disabled="loadingChart || !versions.length">
              <SelectTrigger id="helm-install-version">
                <SelectValue :placeholder="loadingChart ? 'Loading versions…' : 'Pick a version'" />
              </SelectTrigger>
              <SelectContent class="max-h-72">
                <SelectItem v-for="v in visibleVersions" :key="v.version" :value="v.version">
                  <span class="tabular-nums">{{ v.version }}</span>
                  <span class="text-muted-foreground">
                    <template v-if="v.appVersion"> · app {{ v.appVersion }}</template>
                    <template v-if="v.version === latestVersion"> · latest</template>
                    <template v-else-if="v.prerelease"> · pre-release</template>
                    <template v-else-if="v.updated"> · {{ timeAgo(v.updated) }}</template>
                  </span>
                </SelectItem>
              </SelectContent>
            </Select>
            <label
              v-if="versions.some((v) => v.prerelease)"
              class="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground"
            >
              <Checkbox :checked="showPrereleases" @update:checked="showPrereleases = $event === true" />
              Show pre-releases
            </label>
          </div>
        </section>

        <section class="space-y-3">
          <h3 class="text-xs font-medium text-muted-foreground">Release</h3>
          <div class="grid gap-1.5">
            <Label for="helm-install-name">Name</Label>
            <Input
              id="helm-install-name"
              v-model="releaseName"
              autocomplete="off"
              spellcheck="false"
              :aria-invalid="touched.name && !!nameProblem"
              @blur="touched.name = true"
            />
            <p v-if="touched.name && nameProblem" class="text-xs text-destructive">{{ nameProblem }}</p>
          </div>
          <div v-if="clusters.length > 1" class="grid gap-1.5">
            <Label for="helm-install-cluster">Cluster</Label>
            <Select v-model="cluster">
              <SelectTrigger id="helm-install-cluster">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem v-for="c in clusters" :key="c" :value="c">{{ c }}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div class="grid gap-1.5">
            <Label for="helm-install-namespace">Namespace</Label>
            <Input
              id="helm-install-namespace"
              v-model="namespace"
              list="helm-install-namespaces"
              autocomplete="off"
              spellcheck="false"
              :aria-invalid="touched.namespace && !!nsProblem"
              @blur="touched.namespace = true"
            />
            <datalist id="helm-install-namespaces">
              <option v-for="ns in namespaces ?? []" :key="ns" :value="ns" />
            </datalist>
            <p v-if="touched.namespace && nsProblem" class="text-xs text-destructive">{{ nsProblem }}</p>
            <p v-else-if="newNamespace" class="text-xs text-muted-foreground">
              A new namespace: it's created on install.
            </p>
          </div>
        </section>

        <section class="space-y-3">
          <h3 class="text-xs font-medium text-muted-foreground">Options</h3>
          <label class="flex cursor-pointer items-start gap-2 text-sm">
            <Checkbox :checked="atomic" class="mt-0.5" @update:checked="atomic = $event === true" />
            <span>
              Wait until it's ready
              <span class="block text-xs text-muted-foreground">Undone automatically if it doesn't get there in 10 minutes</span>
            </span>
          </label>
        </section>

        <div class="mt-auto space-y-2">
          <p
            v-if="installError"
            role="alert"
            class="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-destructive/25 bg-destructive/5 px-2.5 py-2 text-xs text-destructive select-text"
          >{{ installError }}</p>
          <Button
            type="button"
            variant="outline"
            class="w-full"
            :disabled="!ready || previewing"
            @click="runPreview"
          >
            <Loader2 v-if="previewing" class="h-3.5 w-3.5 animate-spin" />
            <Eye v-else class="h-3.5 w-3.5" />
            Preview
          </Button>
          <span class="block" :title="blocked || undefined">
            <Button type="submit" class="w-full" :disabled="!ready || installing || !!blocked">
              <Loader2 v-if="installing" class="h-3.5 w-3.5 animate-spin" />
              <Rocket v-else class="h-3.5 w-3.5" />
              {{ installing ? "Installing…" : "Install…" }}
            </Button>
          </span>
          <p class="text-center text-2xs text-muted-foreground">
            <template v-if="fromHub && !localRepo">Adds the {{ chart.repoLabel }} repository first · </template>
            <kbd class="font-sans">Ctrl/⌘ Enter</kbd> installs
          </p>
        </div>
      </form>

      <!-- Values, preview, README -->
      <Tabs v-model="tab" class="flex min-w-0 flex-1 flex-col">
        <div class="flex shrink-0 items-center gap-3 border-b px-3">
          <TabsList variant="line" class="border-0">
            <TabsTrigger value="values">
              Values
              <span
                v-if="schemaProblems.length || valuesError"
                class="ml-1.5 rounded-full bg-destructive/10 px-1.5 text-2xs tabular-nums text-destructive"
                >{{ valuesError ? 1 : schemaProblems.length }}</span
              >
            </TabsTrigger>
            <TabsTrigger value="preview">
              Preview
              <span
                v-if="previewObjects.length && !previewStale"
                class="ml-1.5 text-2xs tabular-nums text-muted-foreground"
                >{{ previewObjects.length }}</span
              >
            </TabsTrigger>
            <TabsTrigger v-if="readme" value="readme">README</TabsTrigger>
          </TabsList>
          <template v-if="tab === 'values'">
            <span v-if="valuesError" class="truncate text-xs text-destructive" role="alert">{{ valuesError }}</span>
            <span v-else-if="schema" class="truncate text-xs text-muted-foreground">
              {{ schemaProblems.length ? `${schemaProblems.length} ${schemaProblems.length === 1 ? "problem" : "problems"} against the chart's schema` : "Checked against the chart's schema" }}
            </span>
            <Button
              v-if="values !== defaults"
              variant="ghost"
              size="sm"
              class="ml-auto text-muted-foreground"
              @click="values = defaults"
            >
              <RotateCcw class="h-3.5 w-3.5" /> Reset to defaults
            </Button>
          </template>
        </div>

        <TabsContent value="values" class="mt-0 min-h-0 flex-1">
          <div v-if="chartError" class="flex h-full items-center justify-center p-4">
            <EmptyState :icon="TriangleAlert" title="Can't read this chart" class="max-w-xl">
              <pre class="whitespace-pre-wrap break-words font-mono text-xs select-text">{{ chartError }}</pre>
              <template #action>
                <Button variant="outline" size="sm" @click="loadVersions().then(loadVersion)">Retry</Button>
              </template>
            </EmptyState>
          </div>
          <div v-else-if="loadingChart || (loadingValues && !defaults)" class="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
            <Loader2 class="h-4 w-4 animate-spin" /> Reading {{ chart.name }}…
          </div>
          <div v-else class="flex h-full flex-col">
            <div class="min-h-0 flex-1">
              <ValuesCodeEditor
                ref="editor"
                v-model="values"
                :schema="schema"
                :schema-id="`helm://${encodeURIComponent(chart.name)}/${encodeURIComponent(version)}/values.schema.json`"
                :label="`Values for ${chart.name}`"
                @problems="schemaProblems = $event"
              />
            </div>
            <ul
              v-if="schemaProblems.length"
              class="max-h-28 shrink-0 overflow-auto border-t bg-destructive/5 py-1 text-xs"
              aria-label="Problems"
            >
              <li v-for="(problem, i) in schemaProblems" :key="i">
                <button
                  type="button"
                  class="flex w-full gap-2 px-3 py-0.5 text-left hover:bg-destructive/10"
                  @click="editor?.reveal(problem.line)"
                >
                  <span class="w-12 shrink-0 tabular-nums text-muted-foreground">Line {{ problem.line }}</span>
                  <span class="text-destructive">{{ problem.message }}</span>
                </button>
              </li>
            </ul>
          </div>
        </TabsContent>

        <TabsContent value="preview" class="mt-0 min-h-0 flex-1 overflow-auto">
          <div v-if="previewing" class="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
            <Loader2 class="h-4 w-4 animate-spin" /> Rendering {{ chart.name }} {{ version }}…
          </div>
          <div v-else-if="preview && 'error' in preview" class="flex h-full items-center justify-center p-4">
            <EmptyState :icon="TriangleAlert" title="The dry run failed" class="max-w-xl">
              <pre class="whitespace-pre-wrap break-words text-left font-mono text-xs select-text">{{ preview.error }}</pre>
            </EmptyState>
          </div>
          <div v-else-if="preview" class="flex h-full flex-col">
            <p
              v-if="previewStale"
              class="flex shrink-0 items-center gap-2 border-b bg-warning/10 px-3 py-1.5 text-xs text-warning"
            >
              You changed something since this preview.
              <button type="button" class="font-medium underline" @click="runPreview">Preview again</button>
            </p>
            <div v-if="!showManifest" class="mx-auto w-full max-w-3xl space-y-6 px-6 py-6">
              <div>
                <h3 class="text-base font-semibold">
                  {{ previewObjects.length }} {{ previewObjects.length === 1 ? "object" : "objects" }} will be created
                </h3>
                <p class="mt-1 text-sm text-muted-foreground">
                  In {{ namespace }}{{ newNamespace ? " (new)" : "" }} on {{ cluster }}, as {{ releaseName }}.
                  <button type="button" class="ml-1 rounded-sm text-link hover:underline focus-ring" @click="showManifest = true">
                    View the manifest
                  </button>
                </p>
              </div>
              <div class="grid gap-x-8 gap-y-5 sm:grid-cols-2">
                <div v-for="group in previewGroups" :key="group.kind">
                  <p class="mb-1 flex items-center gap-2 text-xs text-muted-foreground">
                    <KindIcon :name="formatResourceKind(group.kind).toLowerCase()" class="h-3.5 w-3.5" />
                    <span class="font-medium text-foreground/80">{{ pluralKindLabel(group.kind, group.objects.length) }}</span>
                    <span class="tabular-nums">{{ group.objects.length }}</span>
                  </p>
                  <ul class="space-y-0.5 text-sm">
                    <li v-for="object in group.objects" :key="object.name" class="truncate pl-[22px]" :title="object.source">
                      {{ object.name }}
                    </li>
                  </ul>
                </div>
              </div>
              <div v-if="'result' in preview && preview.result.hooks.length">
                <p class="mb-1 text-xs font-medium text-muted-foreground">Hooks</p>
                <ul class="space-y-0.5 text-sm">
                  <li v-for="hook in preview.result.hooks" :key="hook.name" class="flex gap-2">
                    <span class="truncate">{{ hook.name }}</span>
                    <span class="shrink-0 text-xs text-muted-foreground">{{ hook.kind }} · {{ hook.events.join(", ") }}</span>
                  </li>
                </ul>
              </div>
            </div>
            <div v-else class="flex min-h-0 flex-1 flex-col">
              <div class="flex h-9 shrink-0 items-center gap-2 border-b border-border-subtle px-3 text-xs">
                <button type="button" class="rounded-sm text-link hover:underline focus-ring" @click="showManifest = false">
                  ← Summary
                </button>
                <span class="text-muted-foreground">Rendered manifest</span>
              </div>
              <div class="min-h-0 flex-1">
                <MonacoView :value="'result' in preview ? preview.result.manifest : ''" />
              </div>
            </div>
          </div>
          <div v-else class="flex h-full items-center justify-center">
            <EmptyState
              :icon="Eye"
              title="See what gets installed"
              description="A dry run renders the chart with your values and lists every object it would create. Nothing changes in the cluster."
              size="sm"
            >
              <template #action>
                <Button variant="outline" size="sm" :disabled="!ready" @click="runPreview">
                  <Eye class="h-3.5 w-3.5" /> Preview
                </Button>
              </template>
            </EmptyState>
          </div>
        </TabsContent>

        <TabsContent v-if="readme" value="readme" class="mt-0 min-h-0 flex-1 overflow-auto">
          <div class="mx-auto max-w-3xl px-8 py-6">
            <ChartReadme :markdown="readme" />
          </div>
        </TabsContent>
      </Tabs>
    </div>
  </div>
</template>

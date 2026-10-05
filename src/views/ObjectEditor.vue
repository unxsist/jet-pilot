<script setup lang="ts">
import { getCurrentInstance } from "vue";
import type * as Monaco from "monaco-editor";
import Loading from "@/components/Loading.vue";
import { Command } from "@tauri-apps/plugin-shell";
import { type as getOsType } from "@tauri-apps/plugin-os";
import {
  editorOptions,
  loadMonaco,
  prefersReducedMotion,
  type MonacoRuntime,
} from "@/components/monaco";
import { kindSchema, errorMessage } from "@/components/monaco/schemas";
import { diffLines, diffSummary } from "@/lib/diff";
import { readTypeMeta } from "@/components/monaco/kubernetesSchema";
import {
  classifyError,
  diffObjects,
  formatPath,
  locateProblems,
  parseApplyErrors,
  previewValue,
  readResourceVersion,
  rebaseEdits,
  withResourceVersion,
  type ApplyProblem,
  type Change,
  type RebaseResult,
} from "@/components/monaco/manifest";
import { parse as parseYaml } from "yaml";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Kbd } from "@/components/ui/kbd";
import { StatusDot } from "@/components/ui/status";
import {
  ArrowLeft,
  CircleCheck,
  CircleX,
  Columns2,
  GitCompareArrows,
  Loader2,
  RefreshCw,
  Rows2,
  ShieldCheck,
  ShieldOff,
  TriangleAlert,
  Undo2,
} from "lucide-vue-next";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction,
} from "@/components/ui/alert-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Kubernetes } from "@/services/Kubernetes";
import yaml from "js-yaml";
import { useToast } from "@/components/ui/toast";
import { useColorMode } from "@vueuse/core";
import { error, trace } from "@/lib/logger";
import { injectStrict } from "@/lib/utils";
import {
  PanelProviderAddTabKey,
  type TabClosedEvent,
} from "@/providers/PanelProvider";
import { KubeContextStateKey } from "@/providers/KubeContextProvider";

const props = withDefaults(
  defineProps<{
    context: string;
    namespace?: string;
    kubeConfig: string;
    type: string;
    kind?: string;
    name?: string;
    useKubeCtl: boolean;
    create?: boolean;
    createProps?: string[];
  }>(),
  {
    name: "",
    namespace: "",
    kind: "",
    create: false,
    createProps: () => [],
  }
);

type CodeEditor = Monaco.editor.IStandaloneCodeEditor;
type DiffEditor = Monaco.editor.IStandaloneDiffEditor;
type TextModel = Monaco.editor.ITextModel;

let rt: MonacoRuntime | null = null;
let editorInstance: CodeEditor | null = null;
let editorModel: TextModel | null = null;
let diffEditor: DiffEditor | null = null;
let baseModel: TextModel | null = null;
const disposables: Monaco.IDisposable[] = [];
let unmounted = false;

const colorMode = useColorMode();
watch(colorMode, (value) => rt?.setColorMode(value));

const editorElement = ref<HTMLElement | null>(null);
const diffElement = ref<HTMLElement | null>(null);
const originalContents = ref<string>("");
const editContents = ref<string>("");
const loading = ref(true);
const loadError = ref<string | null>(null);
const showUnsavedChangedDialog = ref<boolean>(false);
const instanceAttributes = getCurrentInstance()?.attrs || {};
const emit = defineEmits(["forceClose"]);
const isMac = getOsType() === "macos";
const mod = isMac ? "⌘" : "Ctrl+";
const { toast } = useToast();
const addTab = injectStrict(PanelProviderAddTabKey);
const { contexts, contextKubeConfigMapping } = injectStrict(KubeContextStateKey);

const hasChanges = computed(() => originalContents.value !== editContents.value);

const objectLabel = computed(() =>
  props.name ? `${props.type}/${props.name}` : props.kind || props.type
);

/* ------------------------------------------------------------ schema -- */

const schema = reactive<{
  state: "idle" | "loading" | "ready" | "none" | "error";
  key: string;
  label: string;
  message: string;
}>({ state: "idle", key: "", label: "", message: "" });
const markerCounts = reactive({ schema: 0, server: 0 });

const updateSchema = async () => {
  if (!rt || !editorModel) return;
  const meta = readTypeMeta(editContents.value);
  const key = meta ? `${meta.apiVersion} ${meta.kind}` : "";
  if (key === schema.key) return;
  schema.key = key;

  if (!meta) {
    rt.setModelSchema(editorModel, null, null);
    Object.assign(schema, {
      state: "none",
      label: "",
      message: "Set apiVersion and kind to enable schema validation",
    });
    return;
  }

  schema.state = "loading";
  try {
    const result = await kindSchema(
      props.context,
      props.kubeConfig,
      meta.apiVersion,
      meta.kind
    );
    if (schema.key !== key || !editorModel || !rt) return;
    rt.setModelSchema(editorModel, result?.id ?? null, result?.schema ?? null);
    Object.assign(
      schema,
      result
        ? { state: "ready", label: result.label, message: "" }
        : {
            state: "none",
            label: "",
            message: `The cluster publishes no schema for ${meta.kind} (${meta.apiVersion})`,
          }
    );
  } catch (e) {
    if (schema.key !== key || !editorModel || !rt) return;
    rt.setModelSchema(editorModel, null, null);
    trace(`Schema for ${key} unavailable: ${errorMessage(e)}`);
    Object.assign(schema, {
      state: "error",
      label: "",
      message: `Schema unavailable: ${errorMessage(e)}`,
    });
  }
};
let schemaTimer: ReturnType<typeof setTimeout> | undefined;
const scheduleSchemaUpdate = () => {
  clearTimeout(schemaTimer);
  schemaTimer = setTimeout(updateSchema, 400);
};

const problemCount = computed(() => markerCounts.schema + markerCounts.server);

const nextProblem = () => {
  const target =
    mode.value === "review" ? diffEditor?.getModifiedEditor() : editorInstance;
  target?.focus();
  target?.trigger("toolbar", "editor.action.marker.next", null);
};

/* ------------------------------------------------------------ kubectl -- */

const contextArgs = (context = props.context, kubeConfig = props.kubeConfig) => {
  const args = ["--context", context, "--kubeconfig", kubeConfig];
  if (props.namespace) args.push("--namespace", props.namespace);
  return args;
};

/*
 * Runs kubectl to completion. Only the exit code decides success: kubectl
 * also writes warnings (e.g. API deprecations) to stderr.
 */
const runKubectl = async (args: string[]): Promise<string> => {
  const { code, stdout, stderr } = await Command.create("kubectl", args).execute();
  if (stderr.trim()) trace(`kubectl ${args[0]} stderr: ${stderr}`);
  if (code !== 0) {
    throw new Error(stderr.trim() || `kubectl exited with code ${code}`);
  }
  return stdout;
};

const fetchLive = () =>
  runKubectl(["get", `${props.type}/${props.name}`, "-o", "yaml", ...contextArgs()]);

const getTemplate = (): Promise<string> =>
  import(`@/assets/spec-templates/${props.type}.ts`).then((m) => m.default);

const getDefaultTemplate = (): Promise<string> =>
  import("@/assets/spec-templates/default").then((m) => m.default);

/* ------------------------------------------------------------ editor -- */

const setText = (model: TextModel | null, text: string) => {
  if (!model || model.getValue() === text) return;
  // An edit operation (not setValue) keeps the change undoable.
  model.pushEditOperations(
    [],
    [{ range: model.getFullModelRange(), text }],
    () => null
  );
};

const motionOptions = () =>
  prefersReducedMotion()
    ? { smoothScrolling: false, cursorBlinking: "solid" as const }
    : {};

const initializeEditor = async () => {
  const runtime = await loadMonaco();
  // The tab may have been closed while Monaco was loading.
  if (unmounted || !editorElement.value) return;
  rt = runtime;
  const { monaco } = runtime;
  runtime.setColorMode(colorMode.value);

  editorModel = monaco.editor.createModel(
    editContents.value,
    "yaml",
    runtime.modelUri(`${props.context}-${objectLabel.value}`)
  );
  disposables.push(
    editorModel.onDidChangeContent(() => {
      editContents.value = editorModel!.getValue();
      scheduleSchemaUpdate();
    }),
    monaco.editor.onDidChangeMarkers((uris) => {
      if (!editorModel || !uris.some((u) => u.toString() === editorModel!.uri.toString())) return;
      const markers = monaco.editor.getModelMarkers({ resource: editorModel.uri });
      markerCounts.server = markers.filter((m) => m.owner === "dry-run").length;
      markerCounts.schema = markers.filter(
        (m) => m.owner !== "dry-run" && m.severity >= monaco.MarkerSeverity.Warning
      ).length;
    })
  );

  editorInstance = monaco.editor.create(editorElement.value, {
    ...editorOptions,
    ...motionOptions(),
    model: editorModel,
    automaticLayout: true,
    minimap: { enabled: false },
    fixedOverflowWidgets: true,
  });
  bindShortcuts(editorInstance);
  editorInstance.focus();
  updateSchema();
};

/* Per-editor actions (addCommand is global across editors in Monaco). */
const bindShortcuts = (target: CodeEditor, withEscape = false) => {
  if (!rt) return;
  const { KeyMod, KeyCode } = rt.monaco;
  disposables.push(
    target.addAction({
      id: "jet.review",
      label: "Review changes",
      keybindings: [KeyMod.CtrlCmd | KeyCode.KeyS],
      run: () => onSaveShortcut(),
    }),
    target.addAction({
      id: "jet.apply",
      label: "Apply changes",
      keybindings: [KeyMod.CtrlCmd | KeyCode.Enter],
      run: () => onApplyShortcut(),
    })
  );
  if (withEscape) {
    disposables.push(
      target.addAction({
        id: "jet.backToEditor",
        label: "Back to editor",
        keybindings: [KeyCode.Escape],
        keybindingContext:
          "!suggestWidgetVisible && !findWidgetVisible && !renameInputVisible && !parameterHintsVisible && !markersNavigationVisible",
        run: () => backToEdit(),
      })
    );
  }
};

const sideBySide = ref(true);
watch(sideBySide, (value) =>
  diffEditor?.updateOptions({ renderSideBySide: value })
);

const ensureDiffEditor = () => {
  if (diffEditor || !rt || !diffElement.value || !editorModel) return;
  const { monaco } = rt;
  baseModel = monaco.editor.createModel(baseText.value, "yaml");
  diffEditor = monaco.editor.createDiffEditor(diffElement.value, {
    ...editorOptions,
    ...motionOptions(),
    automaticLayout: true,
    minimap: { enabled: false },
    fixedOverflowWidgets: true,
    renderSideBySide: sideBySide.value,
    useInlineViewWhenSpaceIsLimited: true,
    originalEditable: false,
    readOnly: false,
    renderOverviewRuler: false,
    ignoreTrimWhitespace: false,
    hideUnchangedRegions: { enabled: !props.create, contextLineCount: 4, minimumLineCount: 6 },
  });
  diffEditor.setModel({ original: baseModel, modified: editorModel });
  bindShortcuts(diffEditor.getModifiedEditor(), true);
  disposables.push(
    diffEditor.onDidUpdateDiff(() => {
      if (!revealFirstChange || !diffEditor) return;
      // Ignore the diff against the still-empty base.
      if (!props.create && !baseModel?.getValueLength()) return;
      // Unchanged regions only collapse when the cursor isn't inside them.
      const [first] = diffEditor.getLineChanges() || [];
      if (!first) return;
      revealFirstChange = false;
      const line = Math.max(1, first.modifiedStartLineNumber);
      const modified = diffEditor.getModifiedEditor();
      modified.setPosition({ lineNumber: line, column: 1 });
      modified.revealLineInCenter(line);
    })
  );
};
let revealFirstChange = false;

const revealLine = (line: number) => {
  const target =
    mode.value === "review" ? diffEditor?.getModifiedEditor() : editorInstance;
  if (!target) return;
  target.revealLineInCenter(line);
  target.setPosition({
    lineNumber: line,
    column: editorModel?.getLineFirstNonWhitespaceColumn(line) || 1,
  });
  target.focus();
};

/* ------------------------------------------------------------ review -- */

const mode = ref<"edit" | "review">("edit");
const applying = ref(false);
const review = reactive<{
  fetching: boolean;
  liveText: string;
  liveError: string;
  conflict: null | { latestText: string; latestRv: string; rebase: RebaseResult };
  dryRun: "idle" | "running" | "passed" | "failed";
  dryRunText: string;
  dryRunOutput: string;
  problems: ApplyProblem[];
}>({
  fetching: false,
  liveText: "",
  liveError: "",
  conflict: null,
  dryRun: "idle",
  dryRunText: "",
  dryRunOutput: "",
  problems: [],
});

const baseText = computed(() =>
  props.create ? "" : review.liveText || originalContents.value
);
const dryRunStale = computed(
  () => review.dryRun !== "idle" && review.dryRun !== "running" && review.dryRunText !== editContents.value
);

/* Structural summary, recomputed (debounced) while reviewing. */
const summary = shallowRef<{ changes: Change[]; added: number; removed: number; parseError: string }>({
  changes: [],
  added: 0,
  removed: 0,
  parseError: "",
});
const computeSummary = () => {
  const before = baseText.value;
  const after = editContents.value;
  const { added, removed } = diffSummary(diffLines(before, after));
  try {
    const changes = props.create ? [] : diffObjects(parseYaml(before), parseYaml(after));
    summary.value = { changes, added, removed, parseError: "" };
  } catch (e) {
    summary.value = { changes: [], added, removed, parseError: errorMessage(e) };
  }
};
let summaryTimer: ReturnType<typeof setTimeout> | undefined;
watch([editContents, baseText], () => {
  if (mode.value !== "review") return;
  clearTimeout(summaryTimer);
  summaryTimer = setTimeout(computeSummary, 250);
});

const setServerMarkers = (problems: ApplyProblem[]) => {
  if (!rt || !editorModel) return;
  const model = editorModel;
  const lines = model.getLineCount();
  rt.monaco.editor.setModelMarkers(
    model,
    "dry-run",
    problems
      .filter((p) => p.line && p.line <= lines)
      .map((p) => ({
        severity: rt!.monaco.MarkerSeverity.Error,
        message: p.message,
        source: "API server",
        startLineNumber: p.line!,
        startColumn: model.getLineFirstNonWhitespaceColumn(p.line!) || 1,
        endLineNumber: p.line!,
        endColumn: model.getLineMaxColumn(p.line!),
      }))
  );
};

const resetReview = () => {
  Object.assign(review, {
    fetching: false,
    liveText: "",
    liveError: "",
    conflict: null,
    dryRun: "idle",
    dryRunText: "",
    dryRunOutput: "",
    problems: [],
  });
  setServerMarkers([]);
};

/* Fetches the live object; returns false when it moved on (conflict). */
const checkLive = async (): Promise<boolean> => {
  if (props.create) return true;
  review.fetching = true;
  review.liveError = "";
  try {
    const latest = await fetchLive();
    review.liveText = latest;
    baseModel?.setValue(latest);
    const latestRv = readResourceVersion(latest);
    const loadedRv = readResourceVersion(originalContents.value);
    const mineRv = readResourceVersion(editContents.value);
    if (latestRv && loadedRv && latestRv !== loadedRv && mineRv !== latestRv) {
      review.conflict = {
        latestText: latest,
        latestRv,
        rebase: rebaseEdits(originalContents.value, editContents.value, latest),
      };
      return false;
    }
    review.conflict = null;
    return true;
  } catch (e) {
    // Compare against what was loaded; the dry run will report e.g. a
    // deleted object.
    review.liveError = errorMessage(e);
    baseModel?.setValue(originalContents.value);
    return true;
  } finally {
    review.fetching = false;
  }
};

const applyMode = () => (props.create ? "apply" : "replace") as "apply" | "replace";

const runDryRun = async () => {
  const text = editContents.value;
  review.dryRun = "running";
  review.dryRunText = text;
  review.problems = [];
  setServerMarkers([]);
  try {
    const output = await Kubernetes.applyManifest(
      props.context,
      props.namespace,
      text,
      applyMode(),
      props.kubeConfig,
      true
    );
    if (review.dryRunText !== text) return;
    review.dryRunOutput = output.trim();
    review.dryRun = "passed";
  } catch (e) {
    if (review.dryRunText !== text) return;
    const message = errorMessage(e);
    if (classifyError(message) === "conflict" && !(await checkLive())) {
      review.dryRun = "idle";
      return;
    }
    review.problems = locateProblems(text, parseApplyErrors(message));
    setServerMarkers(review.problems);
    review.dryRun = "failed";
    const first = review.problems.find((p) => p.line);
    if (first?.line && mode.value === "review") revealLine(first.line);
  }
};

const openReview = async () => {
  if (loading.value || loadError.value || !rt) return;
  if (!props.create && !hasChanges.value) {
    toast({ title: "No changes to review", description: `${objectLabel.value} is unchanged.` });
    return;
  }
  resetReview();
  mode.value = "review";
  revealFirstChange = true;
  await nextTick();
  ensureDiffEditor();
  baseModel?.setValue(baseText.value);
  computeSummary();
  diffEditor?.getModifiedEditor().focus();
  if (await checkLive()) await runDryRun();
};

const backToEdit = async () => {
  if (applying.value) return;
  mode.value = "edit";
  await nextTick();
  editorInstance?.layout();
  editorInstance?.focus();
};

/* Cmd/Ctrl+S: open the review; inside the review, re-run the checks. */
const onSaveShortcut = () => {
  if (mode.value === "edit") return openReview();
  if (review.conflict || review.dryRun === "running") return;
  return checkLive().then((ok) => (ok ? runDryRun() : undefined));
};

/* Cmd/Ctrl+Enter: apply from the review (opens it first when editing). */
const onApplyShortcut = () => {
  if (mode.value === "edit") return openReview();
  return apply();
};

const rebase = () => {
  const conflict = review.conflict;
  if (!conflict) return;
  originalContents.value = conflict.latestText;
  revealFirstChange = true;
  setText(editorModel, conflict.rebase.text);
  review.conflict = null;
  runDryRun();
};

const overwrite = () => {
  const conflict = review.conflict;
  if (!conflict) return;
  originalContents.value = conflict.latestText;
  setText(editorModel, withResourceVersion(editContents.value, conflict.latestRv));
  review.conflict = null;
  runDryRun();
};

const discardAndReload = async (text?: string) => {
  const latest = text ?? (await fetchLive().catch(() => null));
  if (latest === null) return;
  originalContents.value = latest;
  setText(editorModel, latest);
  resetReview();
  backToEdit();
};

const revert = () => setText(editorModel, originalContents.value);

const reloadFromCluster = async () => {
  try {
    await discardAndReload(await fetchLive());
    schema.key = "";
    updateSchema();
  } catch (e) {
    toast({ title: "Failed to reload", description: errorMessage(e), variant: "destructive" });
  }
};

const apply = async (force = false) => {
  if (applying.value || review.conflict || review.fetching) return;
  if (review.dryRun === "running") return;
  if (!force && (review.dryRun !== "passed" || dryRunStale.value)) {
    if (dryRunStale.value || review.dryRun === "idle") await runDryRun();
    if (review.dryRun !== "passed") return;
  }

  applying.value = true;
  const text = editContents.value;
  try {
    if (props.create) {
      await applyManifest("apply", text);
    } else if (!props.useKubeCtl) {
      await Kubernetes.replaceObject(
        props.context,
        props.namespace,
        props.type,
        props.name,
        yaml.load(text),
        props.kubeConfig
      );
    } else {
      await applyManifest("replace", text);
    }

    toast({
      title: props.create ? "Created" : "Saved",
      description: props.create
        ? `${props.kind || props.type} created`
        : `${objectLabel.value} updated`,
      variant: "success",
    });

    // Nothing unsaved anymore: closing must not prompt.
    originalContents.value = editContents.value;
    emit("forceClose");
  } catch (e) {
    const message = errorMessage(e);
    error(`Error ${props.create ? "creating" : "updating"} ${objectLabel.value}: ${message}`);
    if (classifyError(message) === "conflict" || (e as any)?.code === 409) {
      await checkLive();
    } else {
      review.problems = locateProblems(text, parseApplyErrors(message));
      setServerMarkers(review.problems);
      review.dryRun = "failed";
      review.dryRunText = text;
    }
    toast({
      title: props.create ? "Failed to create" : "Failed to save changes",
      description: message,
      variant: "destructive",
    });
  } finally {
    applying.value = false;
  }
};

/*
 * kubectl apply / replace the editor contents. The manifest (Secrets!) is
 * piped to kubectl over stdin by the backend, so it never touches disk.
 */
const applyManifest = async (verb: "apply" | "replace", text: string) => {
  const output = await Kubernetes.applyManifest(
    props.context,
    props.namespace,
    text,
    verb,
    props.kubeConfig
  );
  trace(`kubectl ${verb} ${objectLabel.value}: ${output}`);
};

/* ------------------------------------------------- cross-context diff -- */

const otherContexts = computed(() =>
  [...contexts.value.keys()]
    .filter((c) => c !== props.context)
    .map((c) => ({ context: c, kubeConfig: contextKubeConfigMapping.value.get(c) || props.kubeConfig }))
);

const compareWith = (other: { context: string; kubeConfig: string }) => {
  addTab(
    ["diff", props.context, other.context, props.namespace, props.type, props.name].join("_"),
    `${props.name} ⇄ ${other.context}`,
    defineAsyncComponent(() => import("@/views/ObjectDiff.vue")),
    {
      type: props.type,
      name: props.name,
      namespace: props.namespace,
      left: { context: props.context, kubeConfig: props.kubeConfig },
      right: other,
    },
    "diff"
  );
};

/* -------------------------------------------------------- lifecycle -- */

const handleCloseEvent = (e: Event) => {
  const event = e as CustomEvent<TabClosedEvent>;
  if (instanceAttributes.tabId === event.detail.id && hasChanges.value) {
    event.preventDefault();
    showUnsavedChangedDialog.value = true;
  }
};

onMounted(async () => {
  window.addEventListener("TabOrchestrator_TabClosed", handleCloseEvent);
  // Start fetching the editor while the object loads.
  const runtime = loadMonaco();
  runtime.catch(() => undefined);

  try {
    if (props.create !== true) {
      const contents = await fetchLive();
      originalContents.value = contents;
      editContents.value = contents;
    } else {
      try {
        editContents.value = await getTemplate();
      } catch {
        editContents.value = (await getDefaultTemplate())
          .replace(/{{kind}}/g, props.kind)
          .replace(/{{name}}/g, props.type)
          .replace(/{{namespace}}/g, props.namespace || "default");
      }
    }
  } catch (e) {
    error(`Error fetching ${objectLabel.value}: ${e}`);
    loadError.value = errorMessage(e);
    loading.value = false;
    return;
  }

  loading.value = false;
  await nextTick();
  try {
    await initializeEditor();
  } catch (e) {
    error(`Failed to initialize the editor: ${e}`);
    loadError.value = `Failed to initialize the editor: ${e}`;
  }
});

/* Shortcuts while focus is outside Monaco (e.g. on a toolbar button). */
const onKeydown = (event: KeyboardEvent) => {
  if (event.defaultPrevented) return;
  const modKey = event.metaKey || event.ctrlKey;
  if (modKey && !event.altKey && event.key.toLowerCase() === "s") {
    event.preventDefault();
    onSaveShortcut();
  } else if (modKey && event.key === "Enter") {
    event.preventDefault();
    onApplyShortcut();
  } else if (
    event.key === "Escape" &&
    mode.value === "review" &&
    !(event.target as HTMLElement)?.closest?.(".monaco-editor")
  ) {
    event.preventDefault();
    backToEdit();
  }
};

onUnmounted(() => {
  unmounted = true;
  clearTimeout(schemaTimer);
  clearTimeout(summaryTimer);
  window.removeEventListener("TabOrchestrator_TabClosed", handleCloseEvent);
  if (rt && editorModel) rt.setModelSchema(editorModel, null, null);
  disposables.forEach((d) => d.dispose());
  diffEditor?.dispose();
  editorInstance?.dispose();
  editorModel?.dispose();
  baseModel?.dispose();
  diffEditor = null;
  editorInstance = null;
  editorModel = null;
  baseModel = null;
});

const changeLimit = 8;
const changeTone = (change: Change) =>
  change.type === "added"
    ? "text-success"
    : change.type === "removed"
      ? "text-destructive"
      : "text-warning";
</script>
<template>
  <div class="flex h-full w-full flex-col bg-background" @keydown="onKeydown">
    <Loading :label="`Loading ${objectLabel}…`" v-if="loading" />
    <div
      v-else-if="loadError"
      role="alert"
      class="flex h-full items-center justify-center p-4"
    >
      <EmptyState
        :icon="TriangleAlert"
        :title="`Failed to load ${objectLabel}`"
        class="max-w-xl"
      >
        <pre
          class="whitespace-pre-wrap break-words font-mono text-xs select-text"
          >{{ loadError }}</pre
        >
        <template #action>
          <Button variant="outline" size="sm" @click="emit('forceClose')">Close</Button>
        </template>
      </EmptyState>
    </div>

    <template v-else>
      <!-- Toolbar -->
      <div
        class="flex h-9 shrink-0 items-center gap-2 border-b border-border-subtle px-3"
        role="toolbar"
        :aria-label="`${objectLabel} editor`"
      >
        <template v-if="mode === 'edit'">
          <span class="truncate font-mono text-xs text-muted-foreground">
            {{ create ? `New ${kind || type}` : objectLabel }}
            <span v-if="namespace" class="text-muted-foreground/70">· {{ namespace }}</span>
          </span>
          <span
            class="inline-flex h-5 shrink-0 items-center gap-1 rounded-sm px-1.5 text-2xs font-medium"
            :class="
              schema.state === 'ready'
                ? 'bg-success/10 text-success'
                : 'bg-muted text-muted-foreground'
            "
            :title="schema.state === 'ready' ? `Validated against the cluster's OpenAPI schema for ${schema.label}` : schema.message"
            data-testid="schema-status"
          >
            <Loader2 v-if="schema.state === 'loading' || schema.state === 'idle'" class="h-3 w-3 animate-spin" />
            <ShieldCheck v-else-if="schema.state === 'ready'" class="h-3 w-3" />
            <ShieldOff v-else class="h-3 w-3" />
            {{
              schema.state === "ready"
                ? schema.label
                : schema.state === "loading" || schema.state === "idle"
                  ? "Loading schema…"
                  : "No schema"
            }}
          </span>
          <button
            v-if="problemCount > 0"
            type="button"
            class="inline-flex h-5 shrink-0 items-center gap-1 rounded-sm bg-warning/10 px-1.5 text-2xs font-medium text-warning focus-ring"
            title="Go to next problem (F8)"
            @click="nextProblem"
          >
            <TriangleAlert class="h-3 w-3" />
            {{ problemCount }} {{ problemCount === 1 ? "problem" : "problems" }}
          </button>

          <div class="ml-auto flex items-center gap-1">
            <DropdownMenu v-if="!create">
              <DropdownMenuTrigger as-child>
                <Button variant="ghost" size="xs" class="text-muted-foreground" title="Compare with another context">
                  <GitCompareArrows class="h-3.5 w-3.5" />
                  Compare
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" class="min-w-56">
                <DropdownMenuLabel class="text-xs">Compare {{ name }} with…</DropdownMenuLabel>
                <DropdownMenuItem
                  v-for="other in otherContexts"
                  :key="other.context"
                  @select="compareWith(other)"
                >
                  <span class="truncate">{{ other.context }}</span>
                </DropdownMenuItem>
                <DropdownMenuItem v-if="otherContexts.length === 0" disabled>
                  Activate another context to compare
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <Button
              v-if="!create && !hasChanges"
              variant="ghost"
              size="icon-xs"
              class="text-muted-foreground"
              title="Reload from cluster"
              aria-label="Reload from cluster"
              @click="reloadFromCluster"
            >
              <RefreshCw class="h-3.5 w-3.5" />
            </Button>
            <Button
              v-if="hasChanges && !create"
              variant="ghost"
              size="xs"
              title="Revert all changes"
              @click="revert"
            >
              <Undo2 class="h-3.5 w-3.5" />
              Revert
            </Button>
            <span v-if="hasChanges" class="mx-1 flex items-center gap-1.5 text-xs text-muted-foreground">
              <StatusDot tone="warning" />
              {{ create ? "Draft" : "Modified" }}
            </span>
            <Button
              size="xs"
              :variant="hasChanges || create ? 'default' : 'outline'"
              :disabled="!hasChanges && !create"
              :aria-keyshortcuts="isMac ? 'Meta+S' : 'Control+S'"
              @click="openReview"
            >
              {{ create ? "Review & create" : "Review changes" }}
              <Kbd variant="ghost" size="sm" class="ml-0.5">{{ mod }}S</Kbd>
            </Button>
          </div>
        </template>

        <template v-else>
          <Button variant="ghost" size="xs" :disabled="applying" @click="backToEdit">
            <ArrowLeft class="h-3.5 w-3.5" />
            Editor
            <Kbd variant="ghost" size="sm" class="ml-0.5">Esc</Kbd>
          </Button>
          <span class="truncate text-xs font-medium text-foreground">
            {{ create ? `Create ${kind || type}` : `Review changes to ${objectLabel}` }}
          </span>
          <span v-if="!create" class="truncate font-mono text-2xs text-muted-foreground">
            live ↔ edited
          </span>
          <div class="ml-auto flex items-center gap-1">
            <Button
              variant="ghost"
              size="icon-xs"
              class="text-muted-foreground"
              :title="sideBySide ? 'Inline diff' : 'Side-by-side diff'"
              :aria-label="sideBySide ? 'Inline diff' : 'Side-by-side diff'"
              @click="sideBySide = !sideBySide"
            >
              <Rows2 v-if="sideBySide" class="h-3.5 w-3.5" />
              <Columns2 v-else class="h-3.5 w-3.5" />
            </Button>
            <Button
              v-if="review.dryRun === 'failed' && !dryRunStale && !review.conflict"
              variant="outline"
              size="xs"
              :disabled="applying"
              title="Skip the dry run result and apply"
              @click="apply(true)"
            >
              Apply anyway
            </Button>
            <Button
              size="xs"
              :disabled="applying || !!review.conflict || review.fetching || review.dryRun === 'running' || (review.dryRun === 'failed' && !dryRunStale)"
              :aria-keyshortcuts="isMac ? 'Meta+Enter' : 'Control+Enter'"
              @click="apply()"
            >
              <Loader2 v-if="applying" class="h-3 w-3 animate-spin" />
              {{ applying ? (create ? "Creating…" : "Applying…") : create ? "Create" : "Apply" }}
              <Kbd v-if="!applying" variant="ghost" size="sm" class="ml-0.5">{{ mod }}↵</Kbd>
            </Button>
          </div>
        </template>
      </div>

      <!-- Review summary -->
      <div
        v-if="mode === 'review'"
        class="flex max-h-[45%] shrink-0 flex-col gap-2 overflow-y-auto border-b border-border-subtle bg-surface-1 px-3 py-2 text-xs"
        data-testid="review-panel"
      >
        <div class="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span class="font-medium text-foreground">
            <template v-if="create">New object</template>
            <template v-else-if="summary.parseError">YAML does not parse</template>
            <template v-else>
              {{ summary.changes.length }} {{ summary.changes.length === 1 ? "change" : "changes" }}
            </template>
          </span>
          <span class="tnum">
            <span class="text-success">+{{ summary.added }}</span>
            <span class="ml-1 text-destructive">−{{ summary.removed }}</span>
            <span class="ml-1 text-muted-foreground">lines</span>
          </span>
          <span
            class="ml-auto inline-flex items-center gap-1.5"
            role="status"
            aria-live="polite"
            data-testid="dry-run-status"
          >
            <template v-if="review.fetching">
              <Loader2 class="h-3.5 w-3.5 animate-spin text-muted-foreground" />
              <span class="text-muted-foreground">Checking the live object…</span>
            </template>
            <template v-else-if="review.conflict">
              <TriangleAlert class="h-3.5 w-3.5 text-warning" />
              <span class="text-warning">Changed on the cluster</span>
            </template>
            <template v-else-if="review.dryRun === 'running'">
              <Loader2 class="h-3.5 w-3.5 animate-spin text-muted-foreground" />
              <span class="text-muted-foreground">Server-side dry run…</span>
            </template>
            <template v-else-if="dryRunStale">
              <TriangleAlert class="h-3.5 w-3.5 text-warning" />
              <span class="text-warning">Edited since the dry run · {{ mod }}S to re-check</span>
            </template>
            <template v-else-if="review.dryRun === 'passed'">
              <CircleCheck class="h-3.5 w-3.5 text-success" />
              <span class="text-success" :title="review.dryRunOutput">Server dry run passed</span>
            </template>
            <template v-else-if="review.dryRun === 'failed'">
              <CircleX class="h-3.5 w-3.5 text-destructive" />
              <span class="text-destructive">
                Rejected by the server · {{ review.problems.length }}
                {{ review.problems.length === 1 ? "problem" : "problems" }}
              </span>
            </template>
          </span>
        </div>

        <ul
          v-if="!create && summary.changes.length"
          class="flex flex-wrap gap-1.5"
          aria-label="Changed fields"
        >
          <li
            v-for="change in summary.changes.slice(0, changeLimit)"
            :key="formatPath(change.path)"
            class="inline-flex max-w-full items-center gap-1 rounded-sm border border-border-subtle bg-background px-1.5 py-0.5 font-mono text-2xs"
          >
            <span :class="changeTone(change)">{{
              change.type === "added" ? "+" : change.type === "removed" ? "−" : "~"
            }}</span>
            <span class="truncate text-foreground">{{ formatPath(change.path) }}</span>
            <span v-if="change.type === 'changed'" class="truncate text-muted-foreground">
              {{ previewValue(change.before, 24) }} → {{ previewValue(change.after, 24) }}
            </span>
          </li>
          <li
            v-if="summary.changes.length > changeLimit"
            class="px-1 py-0.5 text-2xs text-muted-foreground"
          >
            +{{ summary.changes.length - changeLimit }} more
          </li>
        </ul>

        <div
          v-if="review.conflict"
          role="alert"
          class="rounded-md border border-warning/25 bg-warning/[0.06] px-3 py-2"
          data-testid="conflict"
        >
          <p class="font-medium text-warning">
            {{ objectLabel }} changed on the cluster since you opened it
            <span class="font-mono font-normal text-muted-foreground">
              (resourceVersion {{ readResourceVersion(originalContents) }} →
              {{ review.conflict.latestRv }})</span
            >
          </p>
          <p class="mt-0.5 text-muted-foreground">
            The diff now shows the live object.
            <template v-if="review.conflict.rebase.conflicts.length">
              {{ review.conflict.rebase.conflicts.length }} of your changes touch fields that also
              changed:
              <span class="font-mono text-foreground">{{
                review.conflict.rebase.conflicts.map(formatPath).join(", ")
              }}</span>
              (yours win when rebasing).
            </template>
            <template v-else>Your edits don't overlap with the remote changes.</template>
          </p>
          <div class="mt-2 flex flex-wrap gap-1.5">
            <Button size="xs" @click="rebase">Rebase my edits</Button>
            <Button size="xs" variant="outline" @click="overwrite">Overwrite with mine</Button>
            <Button size="xs" variant="ghost" @click="discardAndReload(review.conflict.latestText)">
              Discard mine &amp; reload
            </Button>
          </div>
        </div>

        <div
          v-if="review.liveError && !review.conflict"
          class="text-muted-foreground"
        >
          Couldn't fetch the live object ({{ review.liveError }}); comparing with the
          version you opened.
        </div>

        <ul
          v-if="review.problems.length"
          class="flex flex-col gap-1"
          aria-label="Server problems"
          data-testid="problems"
        >
          <li
            v-for="(problem, index) in review.problems"
            :key="index"
            class="flex items-start gap-2 rounded-md border border-destructive/25 bg-destructive/[0.06] px-2 py-1.5"
          >
            <CircleX class="mt-0.5 h-3.5 w-3.5 shrink-0 text-destructive" />
            <span class="min-w-0 flex-1 whitespace-pre-wrap break-words font-mono text-2xs leading-4 text-foreground select-text">{{ problem.message }}</span>
            <button
              v-if="problem.line"
              type="button"
              class="shrink-0 rounded-sm bg-background px-1.5 py-0.5 font-mono text-2xs text-muted-foreground hover:text-foreground focus-ring"
              @click="revealLine(problem.line)"
            >
              Line {{ problem.line }}
            </button>
          </li>
        </ul>
      </div>

      <div class="relative min-h-0 flex-1">
        <div
          v-show="mode === 'edit'"
          ref="editorElement"
          class="absolute inset-0"
          data-testid="yaml-editor"
        ></div>
        <div
          v-show="mode === 'review'"
          ref="diffElement"
          class="absolute inset-0"
          data-testid="diff-editor"
        ></div>
      </div>
    </template>

    <AlertDialog
      :open="showUnsavedChangedDialog"
      @update:open="showUnsavedChangedDialog = false"
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Discard unsaved changes?</AlertDialogTitle>
          <AlertDialogDescription>
            You have unsaved changes to {{ objectLabel }}. Closing this tab
            will discard them.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Keep editing</AlertDialogCancel>
          <AlertDialogAction @click="emit('forceClose')">Discard</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </div>
</template>

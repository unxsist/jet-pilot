<script setup lang="ts">
/*
 * An action file in Monaco (Settings › Actions › Edit as YAML): completion,
 * hovers and validation from the action JSON schema, plus the app's own
 * checks (templates, inputs, label selectors) as a marker on the line they
 * are about. Saving writes the file as is: a broken action is listed with
 * its problem and never affects anything else.
 */
import { onBeforeRouteLeave, useRoute, useRouter } from "vue-router";
import type * as Monaco from "monaco-editor";
import { ArrowLeft, Loader2, RotateCcw, TriangleAlert } from "lucide-vue-next";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import {
  editorOptions,
  loadMonaco,
  prefersReducedMotion,
  useMonacoTheme,
  type MonacoRuntime,
} from "@/components/monaco";
import { useEditorPreferences } from "@/components/monaco/preferences";
import { useCustomActions } from "@/lib/customActions/store";
import { parseActionFile } from "@/lib/customActions/schema";
import { ACTION_JSON_SCHEMA, ACTION_SCHEMA_ID } from "@/lib/customActions/jsonSchema";
import { writeActionFile } from "@/components/settings/actions/shared";

const route = useRoute();
const router = useRouter();
const { toast } = useToast();
const applyMonaco = useMonacoTheme();
const preferences = useEditorPreferences();
const { files, ready: filesReady } = useCustomActions();

const fileName = computed(() => String(route.params.file ?? ""));
const file = computed(() => files.value.find((f) => f.file === fileName.value) ?? null);

const savedText = ref("");
const text = ref("");
const dirty = computed(() => text.value !== savedText.value);
const editorError = ref<string | null>(null);
const ready = ref(false);
/* Problems from the schema (monaco-yaml) and from the app's checks. */
const schemaMarkers = ref<{ message: string; line: number }[]>([]);
const problem = computed(() => parseActionFile(fileName.value, text.value).error);
const problems = computed(() => {
  const own = problem.value ? [{ message: problem.value.message, line: problem.value.line ?? 1 }] : [];
  return [...own, ...schemaMarkers.value.filter((m) => !own.some((o) => o.line === m.line))];
});

const element = ref<HTMLElement | null>(null);
let rt: MonacoRuntime | null = null;
let editor: Monaco.editor.IStandaloneCodeEditor | null = null;
let model: Monaco.editor.ITextModel | null = null;
const disposables: { dispose(): void }[] = [];
let unmounted = false;

const OWNER = "jet-actions";
const publishMarker = () => {
  if (!rt || !model) return;
  const error = problem.value;
  const line = Math.min(error?.line ?? 1, model.getLineCount());
  rt.monaco.editor.setModelMarkers(
    model,
    OWNER,
    error
      ? [
          {
            severity: rt.monaco.MarkerSeverity.Error,
            message: error.message,
            startLineNumber: line,
            endLineNumber: line,
            startColumn: model.getLineFirstNonWhitespaceColumn(line) || 1,
            endColumn: model.getLineMaxColumn(line),
          },
        ]
      : []
  );
};

const mount = async () => {
  if (!file.value || editor) return;
  savedText.value = file.value.text;
  text.value = file.value.text;
  try {
    rt = await loadMonaco();
  } catch (e) {
    editorError.value = `Failed to load the editor: ${e}`;
    return;
  }
  if (unmounted || !element.value) return;
  await applyMonaco(rt);
  if (unmounted || !element.value) return;
  const { monaco } = rt;
  model = monaco.editor.createModel(text.value, "yaml", rt.modelUri(fileName.value.replace(/\.ya?ml$/i, "")));
  rt.setModelSchema(model, ACTION_SCHEMA_ID, ACTION_JSON_SCHEMA);
  editor = monaco.editor.create(element.value, {
    ...editorOptions,
    ...preferences.options.value,
    ...(prefersReducedMotion() ? { smoothScrolling: false, cursorBlinking: "solid" as const } : {}),
    model,
    automaticLayout: true,
    fixedOverflowWidgets: true,
    quickSuggestions: { strings: true, other: true, comments: false },
  });
  preferences.track(editor);
  disposables.push(
    model.onDidChangeContent(() => {
      text.value = model!.getValue();
      publishMarker();
    }),
    monaco.editor.onDidChangeMarkers((uris) => {
      if (!model || !uris.some((uri) => uri.toString() === model!.uri.toString())) return;
      schemaMarkers.value = monaco.editor
        .getModelMarkers({ resource: model.uri })
        .filter((marker) => marker.owner !== OWNER && marker.severity >= monaco.MarkerSeverity.Warning)
        .map((marker) => ({ message: marker.message, line: marker.startLineNumber }));
    }),
    editor.addAction({
      id: "jet.saveAction",
      label: "Save action",
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS],
      run: () => save(),
    })
  );
  publishMarker();
  ready.value = true;
  const line = problem.value?.line;
  if (line) {
    editor.setPosition({ lineNumber: line, column: model.getLineFirstNonWhitespaceColumn(line) || 1 });
    editor.revealLineInCenter(line);
  }
  editor.focus();
};

watch([file, element], () => void mount(), { immediate: true });

/* Changed on disk (another editor) while unchanged here: follow it. */
watch(
  () => file.value?.text,
  (next) => {
    if (next === undefined || dirty.value || next === savedText.value || !model) return;
    savedText.value = next;
    model.pushEditOperations([], [{ range: model.getFullModelRange(), text: next }], () => null);
  }
);

onBeforeUnmount(() => {
  unmounted = true;
  disposables.forEach((d) => d.dispose());
  if (rt && model) rt.setModelSchema(model, null, null);
  editor?.dispose();
  model?.dispose();
});

const save = async () => {
  const content = text.value;
  if (!(await writeActionFile(fileName.value, content))) return;
  savedText.value = content;
  const error = parseActionFile(fileName.value, content).error;
  toast(
    error
      ? { title: `Saved ${fileName.value}, with a problem`, description: `Line ${error.line ?? 1}: ${error.message}`, variant: "warning" }
      : { title: `Saved ${fileName.value}`, variant: "success", autoDismiss: true }
  );
};

const revert = () => {
  if (!model) return;
  model.pushEditOperations([], [{ range: model.getFullModelRange(), text: savedText.value }], () => null);
};

const goBack = () => router.push({ name: "SettingsCategory", params: { category: "actions" } });

const reveal = (line: number) => {
  if (!editor) return;
  editor.setPosition({ lineNumber: line, column: 1 });
  editor.revealLineInCenter(line);
  editor.focus();
};

onBeforeRouteLeave(() => {
  if (!dirty.value) return true;
  return window.confirm(`Discard your unsaved changes to ${fileName.value}?`);
});
</script>

<template>
  <div class="flex h-full flex-col">
    <header class="flex h-11 shrink-0 items-center gap-2 border-b bg-sidebar px-3">
      <Button variant="ghost" size="sm" class="text-muted-foreground" aria-label="Back to actions" @click="goBack">
        <ArrowLeft class="h-3.5 w-3.5" />
        Actions
      </Button>
      <span class="h-4 w-px bg-border" aria-hidden="true"></span>
      <div class="flex min-w-0 flex-1 items-baseline gap-3">
        <h1 class="shrink-0 font-mono text-sm font-medium text-foreground">{{ fileName }}</h1>
        <p class="truncate text-xs text-muted-foreground">
          One action per file. Hover a key for help; Ctrl+Space completes.
        </p>
      </div>
      <span v-if="dirty && !problems.length" class="flex items-center gap-1.5 text-xs text-muted-foreground">
        <span class="h-1.5 w-1.5 rounded-full bg-warning" />
        Unsaved
      </span>
      <Button variant="ghost" size="sm" class="text-muted-foreground" :disabled="!dirty" @click="revert">
        <RotateCcw class="h-3.5 w-3.5" />
        Revert
      </Button>
      <Button size="sm" :disabled="!dirty" @click="save">Save</Button>
    </header>
    <!-- The first problem, in words, with its line: click to go there. -->
    <button
      v-if="ready && problems.length"
      type="button"
      class="flex h-9 shrink-0 items-center gap-2 border-b border-destructive/20 bg-destructive/[0.06] px-4 text-left text-xs focus-ring"
      :title="problems.map((p) => `Line ${p.line}: ${p.message}`).join('\n')"
      @click="reveal(problems[0]!.line)"
    >
      <TriangleAlert class="h-3.5 w-3.5 shrink-0 text-destructive" />
      <span class="shrink-0 font-medium tabular-nums text-foreground">Line {{ problems[0]!.line }}</span>
      <span class="min-w-0 truncate text-muted-foreground">{{ problems[0]!.message }}</span>
      <span v-if="problems.length > 1" class="ml-auto shrink-0 tabular-nums text-muted-foreground">
        +{{ problems.length - 1 }} more
      </span>
    </button>
    <div class="relative min-h-0 flex-1">
      <div ref="element" class="absolute inset-0" />
      <div v-if="!ready && !editorError && (file || !filesReady)" class="absolute inset-0 flex items-center justify-center text-muted-foreground">
        <Loader2 class="h-5 w-5 animate-spin" />
      </div>
      <p v-if="filesReady && !file" class="p-6 text-sm text-muted-foreground">
        {{ fileName }} isn't in the actions folder anymore.
      </p>
      <p v-if="editorError" class="p-6 text-sm text-destructive">{{ editorError }}</p>
    </div>
  </div>
</template>

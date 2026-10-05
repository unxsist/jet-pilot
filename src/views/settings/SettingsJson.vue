<script setup lang="ts">
/*
 * settings.json in Monaco (Settings › Open settings.json): validation,
 * completion and hovers from the registry's JSON schema. Saving applies the
 * document: missing keys mean "default", invalid values are skipped and
 * reported. `?key=terminal.fontSize` puts the cursor on that setting.
 */
import { onBeforeRouteLeave, useRoute, useRouter } from "vue-router";
import { findNodeAtLocation, parseTree, modify, applyEdits } from "jsonc-parser";
import type * as Monaco from "monaco-editor";
import { AlertCircle, ArrowLeft, CheckCircle2, Loader2, RotateCcw } from "lucide-vue-next";
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
import { SettingsFileApiKey } from "@/providers/SettingsContextProvider";
import { injectStrict } from "@/lib/utils";
import { SETTINGS_BY_KEY } from "@/lib/settings/registry";
import { buildSettingsSchema, SETTINGS_SCHEMA_URI } from "@/lib/settings/schema";

const route = useRoute();
const router = useRouter();
const api = injectStrict(SettingsFileApiKey);
const { toast } = useToast();
const applyMonaco = useMonacoTheme();
const preferences = useEditorPreferences();

const savedText = ref(api.preferencesText());
const text = ref(savedText.value);
const dirty = computed(() => text.value !== savedText.value);
const markers = ref<{ message: string; line: number }[]>([]);
const editorError = ref<string | null>(null);
const ready = ref(false);

const element = ref<HTMLElement | null>(null);
let rt: MonacoRuntime | null = null;
let editor: Monaco.editor.IStandaloneCodeEditor | null = null;
let model: Monaco.editor.ITextModel | null = null;
const disposables: { dispose(): void }[] = [];
let unmounted = false;

/* Puts the cursor on a setting's value, adding it (with its current value) when absent. */
const revealKey = (key: string) => {
  if (!editor || !model) return;
  const path = key.split(".");
  let current = model.getValue();
  let node = (() => {
    const tree = parseTree(current);
    return tree && findNodeAtLocation(tree, path);
  })();
  if (!node) {
    // Not in the file: it has its default value.
    const def = SETTINGS_BY_KEY.get(key);
    if (!def) return;
    const edits = modify(current, path, def.default, {
      formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" },
    });
    if (!edits.length) return;
    current = applyEdits(current, edits);
    model.pushEditOperations([], [{ range: model.getFullModelRange(), text: current }], () => null);
    const tree = parseTree(current);
    node = tree && findNodeAtLocation(tree, path);
    if (!node) return;
  }
  const start = model.getPositionAt(node.offset);
  const end = model.getPositionAt(node.offset + node.length);
  editor.setSelection({
    startLineNumber: start.lineNumber,
    startColumn: start.column,
    endLineNumber: end.lineNumber,
    endColumn: end.column,
  });
  editor.revealRangeInCenter(editor.getSelection()!);
  editor.focus();
};

onMounted(async () => {
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
  model = monaco.editor.createModel(text.value, "json", rt.jsonModelUri("settings"));
  rt.setJsonSchema(model, SETTINGS_SCHEMA_URI, buildSettingsSchema());
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
    model.onDidChangeContent(() => (text.value = model!.getValue())),
    monaco.editor.onDidChangeMarkers((uris) => {
      if (!model || !uris.some((uri) => uri.toString() === model!.uri.toString())) return;
      markers.value = monaco.editor
        .getModelMarkers({ resource: model.uri })
        .filter((marker) => marker.severity >= monaco.MarkerSeverity.Warning)
        .map((marker) => ({ message: marker.message, line: marker.startLineNumber }));
    }),
    editor.addAction({
      id: "jet.saveSettings",
      label: "Save settings",
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS],
      run: () => save(),
    })
  );
  ready.value = true;
  if (typeof route.query.key === "string") revealKey(route.query.key);
  else editor.focus();
});

onBeforeUnmount(() => {
  unmounted = true;
  disposables.forEach((d) => d.dispose());
  if (rt && model) rt.setJsonSchema(model, SETTINGS_SCHEMA_URI, null);
  editor?.dispose();
  model?.dispose();
});

const setText = (value: string) => {
  if (!model) return;
  model.pushEditOperations([], [{ range: model.getFullModelRange(), text: value }], () => null);
};

const save = () => {
  let document: unknown;
  try {
    document = JSON.parse(text.value);
  } catch (e) {
    toast({ title: "settings.json isn't valid JSON", description: String(e), variant: "destructive" });
    return;
  }
  const issues = api.applyPreferences(document);
  savedText.value = api.preferencesText();
  // Show the file as stored (defaults and invalid values dropped).
  setText(savedText.value);
  toast(
    issues.length
      ? {
          title: `Saved, ${issues.length} ${issues.length === 1 ? "value" : "values"} skipped`,
          description: issues.map((issue) => `${issue.key}: ${issue.message}`).join("\n"),
          variant: "destructive",
        }
      : { title: "Settings saved", variant: "success" }
  );
};

const revert = () => setText(savedText.value);

/* Edits made elsewhere (the settings page) while this is open and unchanged. */
watch(
  () => api.preferencesText(),
  (next) => {
    if (!dirty.value && next !== savedText.value) {
      savedText.value = next;
      setText(next);
    }
  }
);

const goBack = () => router.push({ name: "SettingsCategory", params: { category: "general" } });

onBeforeRouteLeave(() => {
  if (!dirty.value) return true;
  return window.confirm("Discard your unsaved changes to settings.json?");
});
</script>

<template>
  <div class="flex h-full flex-col">
    <header class="flex h-12 shrink-0 items-center gap-3 border-b px-3">
      <Button variant="ghost" size="icon-sm" aria-label="Back to settings" @click="goBack">
        <ArrowLeft class="h-4 w-4" />
      </Button>
      <div class="min-w-0 flex-1">
        <h1 class="truncate text-sm font-semibold">settings.json</h1>
        <p class="truncate text-2xs text-muted-foreground">
          Only values that differ from the default are stored. Remove a line to reset it.
        </p>
      </div>
      <span
        v-if="markers.length"
        class="flex items-center gap-1.5 text-xs text-destructive"
        :title="markers.map((m) => `Line ${m.line}: ${m.message}`).join('\n')"
      >
        <AlertCircle class="h-3.5 w-3.5" />
        {{ markers.length }} {{ markers.length === 1 ? "problem" : "problems" }}
      </span>
      <span v-else-if="ready" class="flex items-center gap-1.5 text-xs text-muted-foreground">
        <CheckCircle2 class="h-3.5 w-3.5 text-success" />
        Valid
      </span>
      <Button variant="ghost" size="sm" :disabled="!dirty" @click="revert">
        <RotateCcw class="h-3.5 w-3.5" />
        Revert
      </Button>
      <Button size="sm" :disabled="!dirty" @click="save">Save</Button>
    </header>
    <div class="relative min-h-0 flex-1">
      <div ref="element" class="absolute inset-0" />
      <div v-if="!ready && !editorError" class="absolute inset-0 flex items-center justify-center text-muted-foreground">
        <Loader2 class="h-5 w-5 animate-spin" />
      </div>
      <p v-if="editorError" class="p-6 text-sm text-destructive">{{ editorError }}</p>
    </div>
  </div>
</template>

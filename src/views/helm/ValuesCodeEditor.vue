<script setup lang="ts">
/*
 * Editable Helm values in Monaco: YAML with the chart's values.schema.json
 * (when it has one) for validation, completion and hovers. Falls back to
 * the plain values editor when Monaco can't load.
 */
import type * as Monaco from "monaco-editor";
import Loading from "@/components/Loading.vue";
import ValuesEditor from "@/components/workloads/ValuesEditor.vue";
import {
  editorOptions,
  loadMonaco,
  prefersReducedMotion,
  useMonacoTheme,
  type MonacoRuntime,
} from "@/components/monaco";
import { useEditorPreferences } from "@/components/monaco/preferences";

const props = defineProps<{
  modelValue: string;
  schema?: Record<string, unknown> | null;
  /** Identifies the schema (a URI; hover source), e.g. `helm://redis/19.6.4/values.schema.json`. */
  schemaId?: string;
  label?: string;
}>();

const emit = defineEmits<{
  "update:modelValue": [value: string];
  /** Schema / syntax problems (warnings and errors). */
  problems: [problems: { message: string; line: number }[]];
}>();

const element = ref<HTMLElement | null>(null);
const ready = ref(false);
const failed = ref(false);
const applyTheme = useMonacoTheme();
const preferences = useEditorPreferences();

let rt: MonacoRuntime | null = null;
let editor: Monaco.editor.IStandaloneCodeEditor | null = null;
let model: Monaco.editor.ITextModel | null = null;
const disposables: Monaco.IDisposable[] = [];
let unmounted = false;

const applySchema = () => {
  if (!rt || !model) return;
  rt.setModelSchema(model, props.schema ? props.schemaId ?? "helm://chart/values.schema.json" : null, props.schema ?? null);
};

onMounted(async () => {
  try {
    rt = await loadMonaco();
  } catch {
    failed.value = true;
    return;
  }
  if (unmounted || !element.value) return;
  await applyTheme(rt);
  if (unmounted || !element.value) return;
  const { monaco } = rt;
  model = monaco.editor.createModel(props.modelValue, "yaml", rt.modelUri("values"));
  applySchema();
  editor = monaco.editor.create(element.value, {
    ...editorOptions,
    ...preferences.options.value,
    ...(prefersReducedMotion() ? { smoothScrolling: false, cursorBlinking: "solid" as const } : {}),
    model,
    automaticLayout: true,
    fixedOverflowWidgets: true,
    ariaLabel: props.label ?? "Values (YAML)",
    quickSuggestions: { strings: true, other: true, comments: false },
  });
  preferences.track(editor);
  disposables.push(
    model.onDidChangeContent(() => {
      const value = model!.getValue();
      if (value !== props.modelValue) emit("update:modelValue", value);
    }),
    monaco.editor.onDidChangeMarkers((uris) => {
      if (!model || !uris.some((uri) => uri.toString() === model!.uri.toString())) return;
      emit(
        "problems",
        monaco.editor
          .getModelMarkers({ resource: model.uri })
          .filter((marker) => marker.severity >= monaco.MarkerSeverity.Warning)
          .map((marker) => ({ message: marker.message, line: marker.startLineNumber }))
      );
    })
  );
  ready.value = true;
});

watch(
  () => props.modelValue,
  (value) => {
    if (model && model.getValue() !== value) {
      // An undoable edit, so a reset can be taken back.
      model.pushEditOperations([], [{ range: model.getFullModelRange(), text: value }], () => null);
    }
  }
);
watch(() => props.schema, applySchema);

/** Moves the cursor to a line (problem list). */
const reveal = (line: number) => {
  editor?.setPosition({ lineNumber: line, column: 1 });
  editor?.revealLineInCenter(line);
  editor?.focus();
};
defineExpose({ reveal });

onBeforeUnmount(() => {
  unmounted = true;
  disposables.forEach((d) => d.dispose());
  if (rt && model) rt.setModelSchema(model, null, null);
  editor?.dispose();
  model?.dispose();
});
</script>

<template>
  <ValuesEditor
    v-if="failed"
    :model-value="modelValue"
    :label="label"
    @update:model-value="emit('update:modelValue', $event)"
  />
  <div v-else class="relative h-full w-full">
    <Loading v-if="!ready" label="Loading editor…" />
    <div ref="element" class="absolute inset-0" :class="{ invisible: !ready }"></div>
  </div>
</template>

<script setup lang="ts">
/*
 * Read-only Monaco surface (YAML by default), or a read-only diff when
 * `original` is given. Monaco is loaded lazily on mount.
 */
import type * as Monaco from "monaco-editor";
import { useColorMode } from "@vueuse/core";
import Loading from "@/components/Loading.vue";
import {
  editorOptions,
  loadMonaco,
  prefersReducedMotion,
  type MonacoRuntime,
} from "@/components/monaco";

const props = withDefaults(
  defineProps<{
    value: string;
    /** Left side; renders a diff editor when set. */
    original?: string | null;
    language?: string;
    sideBySide?: boolean;
    hideUnchanged?: boolean;
  }>(),
  { original: null, language: "yaml", sideBySide: true, hideUnchanged: false }
);

const emit = defineEmits<{ (e: "ready"): void }>();

const element = ref<HTMLElement | null>(null);
const ready = ref(false);
const loadError = ref("");
const colorMode = useColorMode();

let rt: MonacoRuntime | null = null;
let editor: Monaco.editor.IStandaloneCodeEditor | null = null;
let diff: Monaco.editor.IStandaloneDiffEditor | null = null;
let model: Monaco.editor.ITextModel | null = null;
let originalModel: Monaco.editor.ITextModel | null = null;
let unmounted = false;

const baseOptions = () => ({
  ...editorOptions,
  ...(prefersReducedMotion()
    ? { smoothScrolling: false, cursorBlinking: "solid" as const }
    : {}),
  readOnly: true,
  domReadOnly: true,
  automaticLayout: true,
  minimap: { enabled: false },
  fixedOverflowWidgets: true,
});

onMounted(async () => {
  try {
    rt = await loadMonaco();
  } catch (e) {
    loadError.value = `Failed to load the editor: ${e}`;
    return;
  }
  if (unmounted || !element.value) return;
  const { monaco } = rt;
  rt.setColorMode(colorMode.value);
  model = monaco.editor.createModel(props.value, props.language);

  if (props.original !== null) {
    originalModel = monaco.editor.createModel(props.original, props.language);
    diff = monaco.editor.createDiffEditor(element.value, {
      ...baseOptions(),
      originalEditable: false,
      renderSideBySide: props.sideBySide,
      useInlineViewWhenSpaceIsLimited: true,
      renderOverviewRuler: false,
      ignoreTrimWhitespace: false,
      hideUnchangedRegions: {
        enabled: props.hideUnchanged,
        contextLineCount: 3,
        minimumLineCount: 6,
      },
    });
    diff.setModel({ original: originalModel, modified: model });
    // Unchanged regions only collapse when the cursor isn't inside them.
    const once = diff.onDidUpdateDiff(() => {
      const [first] = diff?.getLineChanges() || [];
      if (!first || !diff) return;
      once.dispose();
      const line = Math.max(1, first.modifiedStartLineNumber);
      diff.getModifiedEditor().setPosition({ lineNumber: line, column: 1 });
      diff.getModifiedEditor().revealLineInCenter(line);
    });
  } else {
    editor = monaco.editor.create(element.value, { ...baseOptions(), model });
  }
  ready.value = true;
  emit("ready");
});

watch(colorMode, (mode) => rt?.setColorMode(mode));
watch(
  () => props.value,
  (value) => model && model.getValue() !== value && model.setValue(value)
);
watch(
  () => props.original,
  (value) =>
    originalModel && value !== null && originalModel.getValue() !== value && originalModel.setValue(value)
);
watch(
  () => props.sideBySide,
  (value) => diff?.updateOptions({ renderSideBySide: value })
);
watch(
  () => props.hideUnchanged,
  (value) => diff?.updateOptions({ hideUnchangedRegions: { enabled: value } })
);

/** Focuses the editor and opens its find widget. */
const find = () => {
  const target = diff?.getModifiedEditor() ?? editor;
  target?.focus();
  target?.trigger("keyboard", "actions.find", null);
};

defineExpose({ find });

onUnmounted(() => {
  unmounted = true;
  diff?.dispose();
  editor?.dispose();
  model?.dispose();
  originalModel?.dispose();
});
</script>

<template>
  <div class="relative h-full w-full">
    <Loading v-if="!ready && !loadError" label="Loading editor…" />
    <p v-if="loadError" role="alert" class="p-4 text-sm text-destructive">
      {{ loadError }}
    </p>
    <div ref="element" class="absolute inset-0" :class="{ invisible: !ready }"></div>
  </div>
</template>

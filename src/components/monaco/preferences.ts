/*
 * Editor preferences (Settings › Terminal & Editor › Editor) for Monaco
 * surfaces: spread `options` into create() and `track()` the editor so
 * later changes apply live.
 */
import { computed, onScopeDispose, watch } from "vue";
import type * as Monaco from "monaco-editor";
import { injectStrict } from "@/lib/utils";
import { SettingsContextStateKey } from "@/providers/SettingsContextProvider";

type Tracked = Monaco.editor.IStandaloneCodeEditor | Monaco.editor.IStandaloneDiffEditor;

const modelsOf = (editor: Tracked): (Monaco.editor.ITextModel | null)[] => {
  if ("getModifiedEditor" in editor) {
    const model = editor.getModel();
    return model ? [model.original, model.modified] : [];
  }
  return [editor.getModel()];
};

export function useEditorPreferences() {
  const { settings } = injectStrict(SettingsContextStateKey);
  const prefs = computed(() => settings.value.editor);

  const options = computed(() => ({
    fontSize: prefs.value.fontSize,
    lineHeight: Math.round(prefs.value.fontSize * 1.6),
    wordWrap: prefs.value.wordWrap ? ("on" as const) : ("off" as const),
    minimap: { enabled: prefs.value.minimap },
    lineNumbers: prefs.value.lineNumbers ? ("on" as const) : ("off" as const),
    tabSize: prefs.value.tabSize,
  }));

  const editors = new Set<Tracked>();
  watch(options, (next) => {
    const { tabSize, ...editorOptions } = next;
    for (const editor of editors) {
      editor.updateOptions(editorOptions);
      for (const model of modelsOf(editor)) model?.updateOptions({ tabSize });
    }
  });
  onScopeDispose(() => editors.clear());

  return {
    /** Spread into monaco.editor.create() / createDiffEditor(). */
    options,
    /** The preferred diff layout. */
    sideBySide: computed(() => prefs.value.diffMode === "sideBySide"),
    /** Applies later preference changes to `editor`. */
    track(editor: Tracked) {
      editors.add(editor);
      const { tabSize } = options.value;
      for (const model of modelsOf(editor)) model?.updateOptions({ tabSize });
      return () => editors.delete(editor);
    },
  };
}

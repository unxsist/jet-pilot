<script setup lang="ts">
import { getCurrentInstance } from "vue";
import Loading from "@/components/Loading.vue";
import { Command } from "@tauri-apps/plugin-shell";
import { type as getOsType } from "@tauri-apps/plugin-os";
import loader, { Monaco } from "@monaco-editor/loader";
import LightTheme from "@/components/monaco/themes/GithubLight";
import DarkTheme from "@/components/monaco/themes/BrillianceBlack";
import { Button } from "@/components/ui/button";
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
import { Kubernetes } from "@/services/Kubernetes";
import yaml from "js-yaml";
import { useToast } from "@/components/ui/toast";
import { useColorMode } from "@vueuse/core";
import { error, trace } from "@/lib/logger";
import type { TabClosedEvent } from "@/providers/PanelProvider";

const colorMode = useColorMode();
watch(colorMode, (value) => {
  monacoInstance?.editor.setTheme(value);
});

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

type CodeEditor = ReturnType<Monaco["editor"]["create"]>;
type TextModel = ReturnType<Monaco["editor"]["createModel"]>;

let monacoInstance: Monaco | null = null;
let editorInstance: CodeEditor | null = null;
let editorModel: TextModel | null = null;
let unmounted = false;

const editorElement = ref<HTMLElement | null>(null);
const originalContents = ref<string>("");
const editContents = ref<string>("");
const loading = ref(true);
const loadError = ref<string | null>(null);
const saving = ref(false);
const showUnsavedChangedDialog = ref<boolean>(false);
const instanceAttributes = getCurrentInstance()?.attrs || {};
const emit = defineEmits(["forceClose"]);
const saveShortcut = getOsType() === "macos" ? "⌘S" : "Ctrl+S";

const { toast } = useToast();

const hasChanges = computed(() => {
  return originalContents.value !== editContents.value;
});

const objectLabel = computed(() =>
  props.name ? `${props.type}/${props.name}` : props.kind || props.type
);

const handleCloseEvent = (e: Event) => {
  const event = e as CustomEvent<TabClosedEvent>;
  if (instanceAttributes.tabId === event.detail.id) {
    if (originalContents.value !== editContents.value) {
      event.preventDefault();
      showUnsavedChangedDialog.value = true;
    }
  }
};

const contextArgs = () => {
  const args = ["--context", props.context, "--kubeconfig", props.kubeConfig];
  if (props.namespace) {
    args.push("--namespace", props.namespace);
  }
  return args;
};

/*
 * Runs kubectl to completion. Only the exit code decides success: kubectl
 * also writes warnings (e.g. API deprecations) to stderr.
 */
const runKubectl = async (args: string[]): Promise<string> => {
  const { code, stdout, stderr } = await Command.create(
    "kubectl",
    args
  ).execute();

  if (stderr.trim()) {
    trace(`kubectl ${args[0]} stderr: ${stderr}`);
  }

  if (code !== 0) {
    throw new Error(stderr.trim() || `kubectl exited with code ${code}`);
  }

  return stdout;
};

const fetchObject = async () => {
  const contents = await runKubectl([
    "get",
    `${props.type}/${props.name}`,
    "-o",
    "yaml",
    ...contextArgs(),
  ]);

  originalContents.value = contents;
  editContents.value = contents;
};

const getTemplate = (): Promise<string> => {
  return import(`@/assets/spec-templates/${props.type}.ts`).then((module) => {
    return module.default;
  });
};

const getDefaultTemplate = (): Promise<string> => {
  return import("@/assets/spec-templates/default").then((module) => {
    return module.default;
  });
};

const initializeEditor = async () => {
  const monaco = await loader.init();

  // The tab may have been closed while Monaco was loading.
  if (unmounted || !editorElement.value) {
    return;
  }

  monacoInstance = monaco;
  editorModel = monaco.editor.createModel(editContents.value, "yaml");
  editorModel.onDidChangeContent(() => {
    editContents.value = editorModel!.getValue();
  });

  monaco.editor.defineTheme("light", LightTheme);
  monaco.editor.defineTheme("dark", DarkTheme);
  editorInstance = monaco.editor.create(editorElement.value, {
    model: editorModel,
    theme: colorMode.value,
    automaticLayout: true,
    minimap: {
      enabled: false,
    },
  });

  // Cmd/Ctrl+S inside the editor.
  editorInstance.addCommand(
    monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS,
    () => onSave()
  );
};

onMounted(async () => {
  window.addEventListener("TabOrchestrator_TabClosed", handleCloseEvent);

  try {
    if (props.create !== true) {
      await fetchObject();
    } else {
      try {
        editContents.value = await getTemplate();
      } catch (e) {
        editContents.value = (await getDefaultTemplate())
          .replace(/{{kind}}/g, props.kind)
          .replace(/{{name}}/g, props.type)
          .replace(/{{namespace}}/g, props.namespace || "default");
      }
    }
  } catch (e) {
    error(`Error fetching ${objectLabel.value}: ${e}`);
    loadError.value = e instanceof Error ? e.message : String(e);
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

const onClose = () => {
  emit("forceClose");
};

/* Cmd/Ctrl+S anywhere in the tab (e.g. while a button has focus). */
const onKeydown = (event: KeyboardEvent) => {
  if (
    (event.metaKey || event.ctrlKey) &&
    !event.altKey &&
    event.key.toLowerCase() === "s"
  ) {
    event.preventDefault();
    onSave();
  }
};

const onSave = async () => {
  if (saving.value || loading.value || loadError.value) {
    return;
  }
  if (!props.create && !hasChanges.value) {
    return;
  }

  saving.value = true;
  try {
    if (props.create) {
      await applyManifest("apply");
    } else if (!props.useKubeCtl) {
      await Kubernetes.replaceObject(
        props.context,
        props.namespace,
        props.type,
        props.name,
        yaml.load(editContents.value),
        props.kubeConfig
      );
    } else {
      await applyManifest("replace");
    }

    toast({
      title: props.create ? "Created" : "Saved",
      description: props.create
        ? `${props.kind || props.type} created`
        : `${objectLabel.value} updated`,
    });

    // Nothing unsaved anymore: closing must not prompt.
    originalContents.value = editContents.value;
    onClose();
  } catch (e: any) {
    const message = e?.message ?? String(e);
    error(
      `Error ${props.create ? "creating" : "updating"} ${objectLabel.value}: ${message}`
    );
    toast({
      title: props.create ? "Failed to create" : "Failed to save changes",
      description: message,
      variant: "destructive",
    });
  } finally {
    saving.value = false;
  }
};

/*
 * kubectl apply / replace the editor contents. The manifest (Secrets!) is
 * piped to kubectl over stdin by the backend, so it never touches disk.
 */
const applyManifest = async (verb: "apply" | "replace") => {
  const output = await Kubernetes.applyManifest(
    props.context,
    props.namespace,
    editContents.value,
    verb,
    props.kubeConfig
  );
  trace(`kubectl ${verb} ${objectLabel.value}: ${output}`);
};

onUnmounted(() => {
  unmounted = true;
  window.removeEventListener("TabOrchestrator_TabClosed", handleCloseEvent);
  editorInstance?.dispose();
  editorModel?.dispose();
  editorInstance = null;
  editorModel = null;
});
</script>
<template>
  <div class="group relative w-full h-full" @keydown="onKeydown">
    <Loading label="loading..." v-if="loading" />
    <div
      v-else-if="loadError"
      role="alert"
      class="flex flex-col items-center justify-center h-full gap-3 p-4 text-center"
    >
      <span class="font-semibold text-destructive">
        Failed to load {{ objectLabel }}
      </span>
      <pre
        class="max-w-full whitespace-pre-wrap break-words text-xs text-muted-foreground select-text"
        >{{ loadError }}</pre
      >
      <Button variant="secondary" size="xs" @click="onClose">Close</Button>
    </div>
    <div
      v-if="hasChanges && !loadError"
      class="z-50 absolute bottom-5 right-5 flex justify-end space-x-1"
    >
      <Button
        variant="default"
        size="xs"
        :disabled="saving"
        :title="`${create ? 'Create' : 'Save'} (${saveShortcut})`"
        :aria-keyshortcuts="saveShortcut === '⌘S' ? 'Meta+S' : 'Control+S'"
        @click="onSave"
        >{{
          saving
            ? create
              ? "Creating..."
              : "Saving..."
            : create
            ? "Create"
            : "Save Changes"
        }}</Button
      >
      <Button variant="secondary" size="xs" :disabled="saving" @click="onClose">{{
        create ? "Cancel" : "Discard changes"
      }}</Button>
    </div>
    <div
      v-show="!loading && !loadError"
      ref="editorElement"
      class="w-full h-full"
    ></div>
    <AlertDialog
      :open="showUnsavedChangedDialog"
      @update:open="showUnsavedChangedDialog = false"
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Unsaved changes</AlertDialogTitle>
          <AlertDialogDescription>
            You have unsaved changes, closing this tab will discard them.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction @click="onClose">Close</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </div>
</template>

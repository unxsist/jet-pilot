<script setup lang="ts">
import { getCurrentInstance } from "vue";
import Loading from "@/components/Loading.vue";
import { Command } from "@tauri-apps/plugin-shell";
import { writeTextFile, remove, BaseDirectory } from "@tauri-apps/plugin-fs";
import { tempDir } from "@tauri-apps/api/path";
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

const colorMode = useColorMode();
watch(colorMode, (value) => {
  monacoEditor?.editor.setTheme(value);
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

let monacoEditor: Monaco | null = null;
const editorElement = ref<HTMLElement | null>(null);
const originalContents = ref<string>("");
const editContents = ref<string>("");
const showUnsavedChangedDialog = ref<boolean>(false);
const instanceAttributes = getCurrentInstance()?.attrs || {};
const emit = defineEmits(["forceClose"]);

const { toast } = useToast();

const hasChanges = computed(() => {
  return originalContents.value !== editContents.value;
});

const handleCloseEvent = (e: Event) => {
  if (instanceAttributes.tabId === e.detail.id) {
    if (originalContents.value !== editContents.value) {
      e.preventDefault();
      showUnsavedChangedDialog.value = true;
    }
  }
};

const fetchObject = () => {
  return new Promise<void>((resolve, reject) => {
    const args = [
      "get",
      `${props.type}/${props.name}`,
      "--context",
      props.context,
      "-o",
      "yaml",
      "--kubeconfig",
      props.kubeConfig,
    ];

    if (props.namespace) {
      args.push("--namespace", props.namespace);
    }

    const command = Command.create("kubectl", args);

    let stdOutData = "";
    command.stdout.on("data", (data) => {
      stdOutData += data;
    });

    command.stderr.on("data", (e) => {
      error(`Error fetching ${props.type}/${props.name}: ${e}`);
      reject();
    });

    command.on("close", ({ code }) => {
      if (code === 0) {
        originalContents.value = stdOutData;
        editContents.value = stdOutData;
        resolve();
      }
    });

    command.spawn();
  });
};

const getTemplate = (): Promise<string> => {
  return import(`@/assets/spec-templates/${props.type}.ts`).then((module) => {
    return module.default;
  });
};

const getDefaultTemplate = (): Promise<string> => {
  return import(`@/assets/spec-templates/default.ts`).then((module) => {
    return module.default;
  });
};

const initializeEditor = () => {
  loader.init().then((monaco) => {
    monacoEditor = monaco;
    const model = monaco.editor.createModel(editContents.value, "yaml");
    model.onDidChangeContent(() => {
      editContents.value = model.getValue();
    });

    monaco.editor.defineTheme("light", LightTheme);
    monaco.editor.defineTheme("dark", DarkTheme);
    monaco.editor.create(editorElement.value!, {
      model,
      theme: colorMode.value,
      automaticLayout: true,
      minimap: {
        enabled: false,
      },
    });
  });
};

onMounted(async () => {
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

  initializeEditor();
  window.addEventListener("TabOrchestrator_TabClosed", handleCloseEvent);
});

const onClose = () => {
  emit("forceClose");
};

const onSave = () => {
  props.create ? onCreate() : onUpdate();
};

const onUpdate = () => {
  if (!props.useKubeCtl) {
    Kubernetes.replaceObject(
      props.context,
      props.namespace,
      props.type,
      props.name,
      yaml.load(editContents.value)
    )
      .then((result) => {
        onClose();
      })
      .catch((error) => {
        toast({
          title: "An error occured",
          description: error.message,
          variant: "destructive",
        });
      });
  } else {
    const filename = `${props.name}-${crypto.randomUUID()}.yaml`;
    writeTextFile(filename, editContents.value, {
      baseDir: BaseDirectory.Temp,
    }).then(async () => {
      const tempDirectory = await tempDir();

      const command = Command.create("kubectl", [
        "replace",
        "--context",
        props.context,
        "--namespace",
        props.namespace,
        "-f",
        `${tempDirectory}/${filename}`,
        "--kubeconfig",
        props.kubeConfig,
      ]);

      command.stdout.on("data", (data) => {
        trace(`Updated ${props.type}/${props.name}: ${data}`);
      });

      command.stderr.on("data", (e) => {
        error(`Error updating ${props.type}/${props.name}: ${e}`);
      });

      command.on("close", ({ code }) => {
        if (code === 0) {
          remove(filename, { baseDir: BaseDirectory.Temp });
          onClose();
        }
      });

      command.spawn();
    });
  }
};

const onCreate = () => {
  const filename = `${props.name}-${crypto.randomUUID()}.yaml`;
  writeTextFile(filename, editContents.value, {
    baseDir: BaseDirectory.Temp,
  }).then(async () => {
    const tempDirectory = await tempDir();

    const command = Command.create("kubectl", [
      "apply",
      "--context",
      props.context,
      "--namespace",
      props.namespace,
      "-f",
      `${tempDirectory}/${filename}`,
      "--kubeconfig",
      props.kubeConfig,
    ]);

    command.stdout.on("data", (data) => {
      trace(`Created ${props.type}/${props.name}: ${data}`);
    });

    command.stderr.on("data", (e) => {
      error(`Error creating ${props.type}/${props.name}: ${e}`);
    });

    command.on("close", ({ code }) => {
      if (code === 0) {
        remove(filename, { baseDir: BaseDirectory.Temp });
        onClose();
      }
    });

    command.spawn();
  });
};

onUnmounted(() => {
  window.removeEventListener("TabOrchestrator_TabClosed", handleCloseEvent);
});
</script>
<template>
  <div class="group relative w-full h-full">
    <Loading label="loading..." v-if="editContents.length === 0" />
    <div
      v-if="hasChanges"
      class="z-50 absolute bottom-5 right-5 flex justify-end space-x-1 transition-opacity opacity-25 group-hover:opacity-100"
    >
      <Button variant="default" size="xs" @click="onSave">{{
        create ? "Create" : "Save Changes"
      }}</Button>
      <Button variant="secondary" size="xs" @click="onClose">{{
        create ? "Cancel" : "Discard changes"
      }}</Button>
    </div>
    <div ref="editorElement" class="w-full h-full"></div>
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

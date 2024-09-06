<script setup lang="ts">
import { getCurrentInstance } from "vue";
import Loading from "@/components/Loading.vue";
import { Command } from "@tauri-apps/api/shell";
import { writeFile, removeFile, BaseDirectory } from "@tauri-apps/api/fs";
import { tempdir } from "@tauri-apps/api/os";
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

const colorMode = useColorMode();
watch(colorMode, (value) => {
  monacoEditor?.editor.setTheme(value);
});

const props = defineProps<{
  context: string;
  namespace?: string;
  kubeConfig: string;
  type: string;
  name: string;
  useKubeCtl: boolean;
}>();

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

onMounted(() => {
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

  const command = new Command("kubectl", args);

  let stdOutData = "";
  command.stdout.on("data", (data) => {
    stdOutData += data;
  });

  command.on("close", ({ code }) => {
    if (code === 0) {
      originalContents.value = stdOutData;
      editContents.value = stdOutData;

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
    }
  });

  command.spawn();

  window.addEventListener("TabOrchestrator_TabClosed", handleCloseEvent);
});

const onClose = () => {
  emit("forceClose");
};

const onSave = () => {
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
        console.log(error);
        toast({
          title: "An error occured",
          description: error.message,
          variant: "destructive",
        });
      });
  } else {
    const filename = `${props.name}-${crypto.randomUUID()}.yaml`;
    writeFile(filename, editContents.value, { dir: BaseDirectory.Temp }).then(
      async () => {
        const tempDir = await tempdir();

        const command = new Command("kubectl", [
          "replace",
          "--context",
          props.context,
          "--namespace",
          props.namespace,
          "-f",
          `${tempDir}${filename}`,
          "--kubeconfig",
          props.kubeConfig,
        ]);

        command.stdout.on("data", (data) => {
          console.log(data);
        });

        command.stderr.on("data", (error) => {
          console.log(error);
        });

        command.on("close", ({ code }) => {
          if (code === 0) {
            removeFile(filename, { dir: BaseDirectory.Temp });
            onClose();
          }
        });

        command.spawn();
      }
    );
  }
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
      <Button variant="default" size="xs" @click="onSave">Save Changes</Button>
      <Button variant="secondary" size="xs" @click="onClose"
        >Discard changes</Button
      >
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

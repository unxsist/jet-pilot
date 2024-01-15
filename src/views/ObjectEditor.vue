<script setup lang="ts">
import { getCurrentInstance } from "vue";
import Loading from "@/components/Loading.vue";
import { Command } from "@tauri-apps/api/shell";
import loader from "@monaco-editor/loader";
import Theme from "@/components/monaco/themes/BrillianceBlack";
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

const props = defineProps<{
  context: string;
  namespace: string;
  type: string;
  name: string;
}>();

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
  const command = new Command("kubectl", [
    "get",
    `${props.type}/${props.name}`,
    "--context",
    props.context,
    "--namespace",
    props.namespace,
    "-o",
    "yaml",
  ]);

  let stdOutData = "";
  command.stdout.on("data", (data) => {
    stdOutData += data;
  });

  command.on("close", ({ code }) => {
    if (code === 0) {
      originalContents.value = stdOutData;
      editContents.value = stdOutData;

      loader.init().then((monaco) => {
        const model = monaco.editor.createModel(editContents.value, "yaml");
        model.onDidChangeContent(() => {
          editContents.value = model.getValue();
        });

        monaco.editor.defineTheme("BrillianceBlack", Theme);
        monaco.editor.create(editorElement.value!, {
          model,
          theme: "BrillianceBlack",
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

<script setup lang="ts">
import { homeDir, join } from "@tauri-apps/api/path";
import { open } from "@tauri-apps/plugin-dialog";
import { Button } from "@/components/ui/button";
import FolderIcon from "@/assets/icons/folder.svg";
import BinIcon from "@/assets/icons/bin.svg";
import PlusIcon from "@/assets/icons/plus.svg";

const files = defineModel({
  type: Array<string>,
  default: () => [],
});

const selectFile = async (index: number) => {
  const defaultKubePath = await join(await homeDir(), ".kube", "config");

  const selectedFiles = await open({
    multiple: true,
    title: "Select kubeconfig file(s)",
    defaultPath: defaultKubePath,
  });

  if (selectedFiles === null) {
    return;
  }

  if (typeof selectedFiles === "string") {
    if (!files.value.includes(selectedFiles)) {
      files.value[index] = selectedFiles;
    }
    return;
  }

  if (selectedFiles.length > 0) {
    files.value[index] = selectedFiles[0];

    for (let i = 1; i < selectedFiles.length; i++) {
      if (!files.value.includes(selectedFiles[i])) {
        files.value.push(selectedFiles[i]);
      }
    }
  }
};

const removeFile = (index: number) => {
  files.value.splice(index, 1);
};
</script>
<template>
  <div class="border">
    <div
      v-for="(file, index) in files"
      :key="index"
      class="group w-full relative flex items-center border-b last:border-b-0"
    >
      <input
        v-model="files[index]"
        type="text"
        placeholder="Path to kubeconfig file"
        :aria-label="`Kubeconfig file ${index + 1}`"
        class="bg-transparent p-2 py-3 w-full text-xs focus:outline-none"
      />
      <!-- Visible on hover and whenever the row has keyboard focus. -->
      <div
        class="absolute pl-2 space-x-2 right-0.5 bg-background opacity-0 group-hover:opacity-100 group-focus-within:opacity-100"
      >
        <Button
          variant="ghost"
          size="sm"
          :aria-label="`Remove ${file || 'kubeconfig file'}`"
          title="Remove"
          @click="removeFile(index)"
        >
          <BinIcon class="h-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="sm"
          aria-label="Browse for a kubeconfig file"
          title="Browse..."
          @click="selectFile(index)"
        >
          <FolderIcon class="h-3.5" />
        </Button>
      </div>
    </div>
  </div>
  <div class="flex justify-end">
    <Button
      variant="outline"
      size="sm"
      class="mt-2"
      aria-label="Add a kubeconfig file"
      title="Add kubeconfig file"
      @click="files.push('')"
    >
      <PlusIcon class="h-4" />
    </Button>
  </div>
</template>

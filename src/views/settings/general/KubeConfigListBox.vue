<script setup lang="ts">
import { homeDir, join } from "@tauri-apps/api/path";
import { open } from "@tauri-apps/plugin-dialog";
import { Button } from "@/components/ui/button";
import { FileKey2, FolderOpen, Plus, Trash2 } from "lucide-vue-next";

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
  <div class="overflow-hidden rounded-md border">
    <div
      v-for="(file, index) in files"
      :key="index"
      class="group relative flex h-10 w-full items-center gap-2.5 border-b border-border-subtle bg-background pl-3 pr-1 last:border-b-0 focus-within:bg-accent/40"
    >
      <FileKey2 class="h-4 w-4 shrink-0 text-muted-foreground" />
      <input
        v-model="files[index]"
        type="text"
        placeholder="Path to kubeconfig file"
        :aria-label="`Kubeconfig file ${index + 1}`"
        class="h-full w-full bg-transparent font-mono text-xs text-foreground placeholder:text-muted-foreground/80 focus:outline-none"
      />
      <!-- Visible on hover and whenever the row has keyboard focus. -->
      <div
        class="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity duration-fast group-hover:opacity-100 group-focus-within:opacity-100"
      >
        <Button
          variant="ghost"
          size="icon-sm"
          class="text-muted-foreground"
          aria-label="Browse for a kubeconfig file"
          title="Browse..."
          @click="selectFile(index)"
        >
          <FolderOpen class="h-3.5 w-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          class="text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
          :aria-label="`Remove ${file || 'kubeconfig file'}`"
          title="Remove"
          @click="removeFile(index)"
        >
          <Trash2 class="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  </div>
  <div class="flex justify-end">
    <Button
      variant="outline"
      size="sm"
      aria-label="Add a kubeconfig file"
      title="Add kubeconfig file"
      @click="files.push('')"
    >
      <Plus class="h-3.5 w-3.5" />
      Add kubeconfig
    </Button>
  </div>
</template>

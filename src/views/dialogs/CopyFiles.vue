<script setup lang="ts">
import { V1Pod } from "@kubernetes/client-node";
import { open, save } from "@tauri-apps/plugin-dialog";
import { ArrowDownToLine, ArrowUpFromLine, FolderOpen, Loader2 } from "lucide-vue-next";
import { AlertDialogFooter } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "@/components/ui/toast";
import { runCli, cliSucceeded, cliErrorMessage } from "@/actions/command";
import { baseName, kubectlCopyArgs } from "@/lib/workloads";
import { error } from "@/lib/logger";

/*
 * kubectl cp between a container and a local path picked with the native
 * file dialogs. Directories work too (kubectl cp copies recursively).
 */
const props = defineProps<{
  context: string;
  namespace: string;
  kubeConfig: string;
  pod: V1Pod;
}>();
const emit = defineEmits(["closeDialog"]);

const direction = ref<"download" | "upload">("download");
const containers = computed(() => (props.pod.spec?.containers ?? []).map((c) => c.name));
const container = ref(containers.value[0] ?? "");
const remotePath = ref("");
const localPath = ref("");
const copying = ref(false);

watch(direction, () => {
  localPath.value = "";
});

const pickLocal = async () => {
  if (direction.value === "download") {
    const path = await save({
      title: "Save as",
      defaultPath: remotePath.value ? baseName(remotePath.value) : undefined,
    });
    if (path) localPath.value = path;
  } else {
    const path = await open({ title: "File to upload", multiple: false, directory: false });
    if (typeof path === "string") {
      localPath.value = path;
      if (!remotePath.value) remotePath.value = `/tmp/${baseName(path)}`;
    }
  }
};

const valid = computed(
  () => !!remotePath.value.trim() && !!localPath.value.trim() && !copying.value
);

const copy = async () => {
  if (!valid.value) return;
  copying.value = true;
  const args = kubectlCopyArgs({
    direction: direction.value,
    pod: props.pod.metadata?.name ?? "",
    namespace: props.namespace,
    container: container.value || undefined,
    remotePath: remotePath.value.trim(),
    localPath: localPath.value.trim(),
    cluster: props,
  });
  const result = await runCli("kubectl", args);
  copying.value = false;

  if (cliSucceeded(result)) {
    toast({
      title: direction.value === "download" ? "Downloaded" : "Uploaded",
      description:
        direction.value === "download"
          ? `${remotePath.value} → ${localPath.value}`
          : `${localPath.value} → ${props.pod.metadata?.name}:${remotePath.value}`,
      variant: "success",
      autoDismiss: true,
    });
    emit("closeDialog");
    return;
  }

  const message = cliErrorMessage(result);
  error(`kubectl cp failed: ${message}`);
  toast({
    title: "Copy failed",
    description: /tar/.test(message)
      ? `${message}\nkubectl cp needs tar in the container.`
      : message,
    variant: "destructive",
    duration: 15000,
  });
};
</script>

<template>
  <form class="grid gap-4" @submit.prevent="copy">
    <div class="inline-flex h-8 items-center justify-self-start rounded-lg bg-muted p-0.5" role="group" aria-label="Direction">
      <button
        v-for="option in (['download', 'upload'] as const)"
        :key="option"
        type="button"
        class="inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium transition-colors duration-fast focus-ring"
        :class="direction === option ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'"
        :aria-pressed="direction === option"
        @click="direction = option"
      >
        <ArrowDownToLine v-if="option === 'download'" class="h-3.5 w-3.5" />
        <ArrowUpFromLine v-else class="h-3.5 w-3.5" />
        {{ option === "download" ? "From container" : "To container" }}
      </button>
    </div>

    <div class="grid grid-cols-[10rem_1fr] gap-3">
      <div class="grid gap-1.5">
        <Label for="copy-container">Container</Label>
        <Select v-model="container">
          <SelectTrigger id="copy-container" class="font-mono text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem v-for="name in containers" :key="name" :value="name" class="font-mono text-xs">{{ name }}</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div class="grid gap-1.5">
        <Label for="copy-remote">Path in the container</Label>
        <Input id="copy-remote" v-model="remotePath" class="font-mono text-xs" placeholder="/var/log/app.log" />
      </div>
    </div>

    <div class="grid gap-1.5">
      <Label for="copy-local">{{ direction === "download" ? "Save to" : "Local file" }}</Label>
      <div class="flex gap-2">
        <Input id="copy-local" v-model="localPath" class="font-mono text-xs" :placeholder="direction === 'download' ? 'Choose where to save…' : 'Choose a file…'" />
        <Button type="button" variant="outline" @click="pickLocal">
          <FolderOpen class="h-3.5 w-3.5" />
          Browse…
        </Button>
      </div>
    </div>

    <AlertDialogFooter>
      <Button type="button" variant="ghost" @click="emit('closeDialog')">Cancel</Button>
      <Button type="submit" :disabled="!valid">
        <Loader2 v-if="copying" class="h-3.5 w-3.5 animate-spin" />
        <ArrowDownToLine v-else-if="direction === 'download'" class="h-3.5 w-3.5" />
        <ArrowUpFromLine v-else class="h-3.5 w-3.5" />
        {{ direction === "download" ? "Download" : "Upload" }}
      </Button>
    </AlertDialogFooter>
  </form>
</template>

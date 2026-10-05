<script setup lang="ts">
/**
 * Export clusters added in JET Pilot: into your own kubeconfig
 * (~/.kube/config, after a backup), or as a separate kubeconfig file, with
 * the credentials either fetched through JET Pilot's helper or included.
 */
import { save } from "@tauri-apps/plugin-dialog";
import { AlertTriangle, Loader2 } from "lucide-vue-next";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { errorMessage, exportManaged, exportToKubeConfig, withVault } from "@/lib/clusters/managed";

const props = defineProps<{ contexts: string[] }>();
const open = defineModel<boolean>("open", { required: true });
const { toast } = useToast();

const target = ref<"kubeconfig" | "file">("kubeconfig");
const mode = ref<"helper" | "inline">("helper");
const busy = ref(false);
const error = ref<string | null>(null);
watch(open, (isOpen) => {
  if (isOpen) {
    target.value = "kubeconfig";
    mode.value = "helper";
    error.value = null;
  }
});

const run = async () => {
  busy.value = true;
  error.value = null;
  try {
    if (target.value === "kubeconfig") {
      const report = await exportToKubeConfig(props.contexts);
      toast({
        title: `Added ${report.written} ${report.written === 1 ? "cluster" : "clusters"} to ~/.kube/config`,
        description: report.skipped.length
          ? `Skipped (name already used): ${report.skipped.join(", ")}. Backup: ${report.backup}`
          : `Backup: ${report.backup}`,
        variant: "success",
      });
    } else {
      const dest = await save({
        title: "Export kubeconfig",
        defaultPath: props.contexts.length === 1 ? `${props.contexts[0]}.yaml` : "clusters.yaml",
        filters: [{ name: "Kubeconfig", extensions: ["yaml", "yml"] }],
      });
      if (!dest) return;
      await withVault(() => exportManaged(props.contexts, mode.value, dest));
      toast({ title: "Kubeconfig exported", description: dest, variant: "success" });
    }
    open.value = false;
  } catch (e) {
    error.value = errorMessage(e);
  } finally {
    busy.value = false;
  }
};
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent class="max-w-md">
      <DialogHeader>
        <DialogTitle>Export {{ contexts.length === 1 ? contexts[0] : `${contexts.length} clusters` }}</DialogTitle>
        <DialogDescription>Use clusters you added in JET Pilot with other tools.</DialogDescription>
      </DialogHeader>
      <div class="space-y-2">
        <label class="flex items-start gap-2 rounded-lg border p-3 text-sm" :class="target === 'kubeconfig' ? 'border-primary/50 bg-primary/5' : ''">
          <input v-model="target" type="radio" value="kubeconfig" class="mt-1 accent-[hsl(var(--primary))]" />
          <span>
            <span class="block font-medium">Add to ~/.kube/config</span>
            <span class="block text-xs text-muted-foreground">
              kubectl, k9s and other tools see them right away. Credentials stay in your keychain; a backup of the
              file is made first.
            </span>
          </span>
        </label>
        <label class="flex items-start gap-2 rounded-lg border p-3 text-sm" :class="target === 'file' ? 'border-primary/50 bg-primary/5' : ''">
          <input v-model="target" type="radio" value="file" class="mt-1 accent-[hsl(var(--primary))]" />
          <span class="space-y-2">
            <span class="block font-medium">Save as a kubeconfig file</span>
            <span v-if="target === 'file'" class="block space-y-1.5">
              <label class="flex items-center gap-2 text-xs">
                <input v-model="mode" type="radio" value="helper" class="accent-[hsl(var(--primary))]" />
                Credentials through JET Pilot (works on this computer)
              </label>
              <label class="flex items-center gap-2 text-xs">
                <input v-model="mode" type="radio" value="inline" class="accent-[hsl(var(--primary))]" />
                Include the credentials (works anywhere)
              </label>
              <span v-if="mode === 'inline'" class="flex items-start gap-1.5 text-xs text-warning">
                <AlertTriangle class="mt-px h-3.5 w-3.5 shrink-0" />
                Anyone with the file can use these clusters. Keep it somewhere safe.
              </span>
            </span>
          </span>
        </label>
      </div>
      <p v-if="error" class="text-xs text-destructive" role="alert">{{ error }}</p>
      <DialogFooter>
        <Button variant="ghost" @click="open = false">Cancel</Button>
        <Button :disabled="busy" @click="run">
          <Loader2 v-if="busy" class="h-3.5 w-3.5 animate-spin" />
          {{ target === "kubeconfig" ? "Add to ~/.kube/config" : "Save…" }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>

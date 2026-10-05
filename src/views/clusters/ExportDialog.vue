<script setup lang="ts">
/**
 * Export clusters added in JET Pilot: into your own kubeconfig
 * (~/.kube/config, after a backup), or as a separate kubeconfig file, with
 * the credentials either fetched through JET Pilot's helper or included.
 */
import { save } from "@tauri-apps/plugin-dialog";
import { RadioGroupRoot } from "radix-vue";
import { AlertTriangle, CircleAlert, FileOutput, Loader2 } from "lucide-vue-next";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import ChoiceRow from "@/components/wizard/ChoiceRow.vue";
import WizardHeader from "@/components/wizard/WizardHeader.vue";
import WizardFooter from "@/components/wizard/WizardFooter.vue";
import { WIZARD_BODY, WIZARD_DIALOG, WIZARD_ERROR, WIZARD_LIST } from "@/components/wizard/wizard";
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
    <DialogContent :class="[WIZARD_DIALOG, 'max-w-[30rem]']">
      <WizardHeader
        :title="`Export ${contexts.length === 1 ? contexts[0] : `${contexts.length} clusters`}`"
        description="Use clusters you added in JET Pilot with other tools."
      >
        <template #icon><FileOutput class="h-[18px] w-[18px]" /></template>
      </WizardHeader>

      <div :class="WIZARD_BODY">
        <RadioGroupRoot v-model="target" :class="[WIZARD_LIST, 'space-y-px']" aria-label="Export to">
          <ChoiceRow
            value="kubeconfig"
            title="Add to ~/.kube/config"
            description="kubectl, k9s and other tools see them right away. The file is backed up first."
          />
          <ChoiceRow value="file" title="Save as a kubeconfig file" description="A separate file to keep or share." />
        </RadioGroupRoot>

        <div v-if="target === 'file'" class="mt-4 space-y-2 pl-7">
          <Tabs v-model="mode">
            <TabsList aria-label="Credentials" class="w-full">
              <TabsTrigger value="helper" class="flex-1">Through JET Pilot</TabsTrigger>
              <TabsTrigger value="inline" class="flex-1">Include credentials</TabsTrigger>
            </TabsList>
          </Tabs>
          <p v-if="mode === 'helper'" class="text-xs text-muted-foreground">
            Credentials stay in your keychain; the file works on this computer.
          </p>
          <p v-else class="flex items-start gap-1.5 text-xs text-warning">
            <AlertTriangle class="mt-px h-3.5 w-3.5 shrink-0" />
            Works anywhere, and anyone with the file can use these clusters. Keep it somewhere safe.
          </p>
        </div>

        <p v-if="error" :class="[WIZARD_ERROR, 'mt-4']" role="alert">
          <CircleAlert class="mt-px h-3.5 w-3.5 shrink-0" /> {{ error }}
        </p>
      </div>

      <WizardFooter>
        <Button variant="ghost" @click="open = false">Cancel</Button>
        <Button :disabled="busy" @click="run">
          <Loader2 v-if="busy" class="h-3.5 w-3.5 animate-spin" />
          {{ target === "kubeconfig" ? "Add to ~/.kube/config" : "Save…" }}
        </Button>
      </WizardFooter>
    </DialogContent>
  </Dialog>
</template>

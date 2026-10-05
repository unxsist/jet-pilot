<script setup lang="ts">
import { V1Pod } from "@kubernetes/client-node";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Loader2, Trash2 } from "lucide-vue-next";
import { AlertDialogFooter } from "@/components/ui/alert-dialog";
import { useToast } from "@/components/ui/toast";
import { Kubernetes } from "@/services/Kubernetes";
import { error } from "@/lib/logger";
import { guard, rowTargets } from "@/lib/guardrails/guard";

const props = defineProps<{
  pod: V1Pod & { metadata: { context: string; kubeConfig: string } };
}>();

const emit = defineEmits(["closeDialog"]);
const { toast } = useToast();

const force = ref(false);
const deleting = ref(false);

/* The pod's own grace period (Kubernetes defaults to 30s). */
const gracePeriod = computed(
  () => props.pod.spec?.terminationGracePeriodSeconds ?? 30
);

const deletePod = async () => {
  const name = props.pod.metadata?.name ?? "";
  if (!(await guard("delete", rowTargets([props.pod], "Pod")))) return;
  deleting.value = true;

  try {
    await Kubernetes.deletePod(
      props.pod.metadata.context,
      props.pod.metadata?.namespace ?? "",
      name,
      force.value ? 0 : gracePeriod.value,
      props.pod.metadata.kubeConfig,
      { guarded: true }
    );

    toast({
      title: "Pod deleted",
      description: force.value
        ? `Pod ${name} was force deleted`
        : `Pod ${name} is terminating`,
      autoDismiss: true,
    });
    emit("closeDialog");
  } catch (e: any) {
    error(`Failed to delete pod ${name}: ${e?.message ?? e}`);
    toast({
      title: `Failed to delete pod ${name}`,
      description: e?.message ?? String(e),
      variant: "destructive",
    });
  } finally {
    deleting.value = false;
  }
};
</script>
<template>
  <div class="space-y-3 text-sm">
    <p class="text-muted-foreground">
      The pod gets {{ gracePeriod }}s to shut down gracefully. Pods managed by a
      controller are recreated.
    </p>
    <label
      for="force-delete-pod"
      class="flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors duration-fast hover:bg-accent/50"
      :class="{ 'border-destructive/30 bg-destructive/[0.06]': force }"
    >
      <Checkbox
        id="force-delete-pod"
        class="mt-0.5"
        :checked="force"
        @update:checked="force = $event === true"
      />
      <span class="grid gap-0.5">
        <span class="font-medium">Force (skip graceful shutdown)</span>
        <span class="text-xs text-muted-foreground">
          Kills the containers immediately (grace period 0).
        </span>
      </span>
    </label>
  </div>
  <AlertDialogFooter>
    <Button variant="ghost" :disabled="deleting" @click="emit('closeDialog')">
      Cancel
    </Button>
    <Button variant="destructive" :disabled="deleting" @click="deletePod">
      <Loader2 v-if="deleting" class="h-3.5 w-3.5 animate-spin" />
      <Trash2 v-else class="h-3.5 w-3.5" />
      {{ force ? "Force delete" : "Delete" }}
    </Button>
  </AlertDialogFooter>
</template>

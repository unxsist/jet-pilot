<script setup lang="ts">
import { V1Pod } from "@kubernetes/client-node";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { AlertDialogFooter } from "@/components/ui/alert-dialog";
import { useToast } from "@/components/ui/toast";
import { Kubernetes } from "@/services/Kubernetes";
import { error } from "@/lib/logger";

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
  deleting.value = true;

  try {
    await Kubernetes.deletePod(
      props.pod.metadata.context,
      props.pod.metadata?.namespace ?? "",
      name,
      force.value ? 0 : gracePeriod.value,
      props.pod.metadata.kubeConfig
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
  <div class="text-sm space-y-3">
    <p class="text-muted-foreground">
      The pod gets {{ gracePeriod }}s to shut down gracefully. Pods managed by a
      controller are recreated.
    </p>
    <div class="flex items-start gap-2">
      <Checkbox
        id="force-delete-pod"
        :checked="force"
        @update:checked="force = $event === true"
      />
      <div class="grid gap-1">
        <Label for="force-delete-pod">Force (skip graceful shutdown)</Label>
        <span class="text-xs text-muted-foreground">
          Kills the containers immediately (grace period 0).
        </span>
      </div>
    </div>
  </div>
  <AlertDialogFooter>
    <Button variant="ghost" :disabled="deleting" @click="emit('closeDialog')">
      Cancel
    </Button>
    <Button variant="destructive" :disabled="deleting" @click="deletePod">
      {{ force ? "Force delete" : "Delete" }}
    </Button>
  </AlertDialogFooter>
</template>

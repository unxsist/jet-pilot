<script setup lang="ts">
import { Button } from "@/components/ui/button";
import { AlertDialogFooter } from "@/components/ui/alert-dialog";
import { runCliForEach } from "@/actions/command";
import { getResourceTabTitle } from "@/components/tables/identity";
import {
  V1Deployment,
  V1ReplicaSet,
  V1ReplicationController,
  V1StatefulSet,
} from "@kubernetes/client-node";

import {
  NumberField,
  NumberFieldContent,
  NumberFieldDecrement,
  NumberFieldIncrement,
  NumberFieldInput,
} from "@/components/ui/number-field";
import { Label } from "@/components/ui/label";
import { Scaling } from "lucide-vue-next";

type ScalableObject = (
  | V1Deployment
  | V1StatefulSet
  | V1ReplicaSet
  | V1ReplicationController
) & { metadata: { context: string; kubeConfig: string } };

const props = defineProps<{
  objects:
    | (V1Deployment & { metadata: { context: string; kubeConfig: string } })[]
    | (V1StatefulSet & { metadata: { context: string; kubeConfig: string } })[]
    | (V1ReplicaSet & { metadata: { context: string; kubeConfig: string } })[]
    | (V1ReplicationController & {
        metadata: { context: string; kubeConfig: string };
      })[];
}>();

const replicas = ref(0);

const emit = defineEmits(["closeDialog"]);

const scale = async () => {
  emit("closeDialog");
  await runCliForEach("kubectl", props.objects as ScalableObject[], {
    args: (object) => {
      const args = [
        "scale",
        `--replicas=${replicas.value}`,
        `${object.kind}/${object.metadata?.name}`,
        "--context",
        object.metadata.context,
      ];
      if (object.metadata?.namespace) {
        args.push("--namespace", object.metadata.namespace);
      }
      if (object.metadata.kubeConfig) {
        args.push("--kubeconfig", object.metadata.kubeConfig);
      }
      return args;
    },
    label: (object) => getResourceTabTitle(object),
    successVerb: "Scaled",
    failureVerb: "scale",
  });
};

onMounted(() => {
  replicas.value =
    props.objects.length === 1 ? props.objects[0].spec?.replicas ?? 0 : 0;
});
</script>
<template>
  <NumberField
    v-model="replicas"
    class="flex items-center justify-between rounded-lg border bg-surface-1 px-3 py-2.5"
  >
    <Label class="grid gap-0.5">
      <span>Replicas</span>
      <span class="text-xs font-normal text-muted-foreground"
        >{{ objects.length === 1 ? "Desired pod count" : `Applied to ${objects.length} objects` }}</span
      >
    </Label>
    <NumberFieldContent>
      <NumberFieldDecrement />
      <NumberFieldInput />
      <NumberFieldIncrement />
    </NumberFieldContent>
  </NumberField>
  <AlertDialogFooter>
    <Button variant="ghost" @click="emit('closeDialog')">Cancel</Button>
    <Button variant="default" @click="scale">
      <Scaling class="h-3.5 w-3.5" />
      Scale
    </Button>
  </AlertDialogFooter>
</template>

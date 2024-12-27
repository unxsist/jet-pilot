<script setup lang="ts">
import { Button } from "@/components/ui/button";
import { AlertDialogFooter } from "@/components/ui/alert-dialog";
import { Command } from "@tauri-apps/plugin-shell";

import { useToast } from "@/components/ui/toast";
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

const { toast } = useToast();

const props = defineProps<{
  context: string;
  namespace: string;
  kubeConfig: string;
  object: V1Deployment | V1StatefulSet | V1ReplicaSet | V1ReplicationController;
}>();

const replicas = ref(0);

const emit = defineEmits(["closeDialog"]);

const scale = () => {
  const args = [
    "scale",
    `--replicas=${replicas.value}`,
    `${props.object.kind}/${props.object.metadata?.name}`,
    "--context",
    props.context,
    "--namespace",
    props.object.metadata?.namespace || "",
    "--kubeconfig",
    props.kubeConfig,
  ];

  console.log(args);

  const command = Command.create("kubectl", args);
  command.stdout.on("data", (data) => {
    // toast({
    //   title: "Rollback successful",
    //   description: `Rollback of ${props.release.name} to revision ${rollbackRevision.value} was successful`,
    //   autoDismiss: true,
    // });
    emit("closeDialog");
  });

  command.stderr.on("data", (data) => {
    toast({
      title: "Error",
      description: data,
      variant: "destructive",
    });
  });

  command.spawn();
};

onMounted(() => {
  replicas.value = props.object.spec?.replicas || 0;
});
</script>
<template>
  <NumberField v-model="replicas" class="flex items-center justify-between">
    <Label>Replicas</Label>
    <NumberFieldContent>
      <NumberFieldDecrement />
      <NumberFieldInput />
      <NumberFieldIncrement />
    </NumberFieldContent>
  </NumberField>
  <AlertDialogFooter>
    <Button variant="default" @click="emit('closeDialog')">Cancel</Button>
    <Button variant="default" @click="scale">Scale</Button>
  </AlertDialogFooter>
</template>

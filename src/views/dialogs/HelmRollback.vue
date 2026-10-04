<script setup lang="ts">
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectGroup,
  SelectLabel,
  SelectItem,
} from "@/components/ui/select";

import { AlertDialogFooter } from "@/components/ui/alert-dialog";
import { runCli, cliSucceeded, cliErrorMessage } from "@/actions/command";

import { useToast } from "@/components/ui/toast";
const { toast } = useToast();

import { parseJSON } from "date-fns";
import { formatDateTime } from "@/lib/utils";
import { error } from "@/lib/logger";

const rollbackRevision = ref<string>("");
const revisions = ref<any[]>([]);

const sortedRevisions = computed(() => {
  // Sort the revisions in descending order
  return revisions.value.slice().sort((a, b) => b.revision - a.revision);
});

const props = defineProps<{
  context: string;
  namespace: string;
  kubeConfig: string;
  release: any;
}>();

const emit = defineEmits(["closeDialog"]);

const rollingBack = ref(false);

const rollback = async () => {
  if (!rollbackRevision.value) {
    return;
  }

  const args = [
    "rollback",
    props.release.name,
    rollbackRevision.value.toString(),
    "--kube-context",
    props.context,
    "--namespace",
    props.release.namespace,
  ];
  if (props.kubeConfig) {
    args.push("--kubeconfig", props.kubeConfig);
  }

  rollingBack.value = true;
  const result = await runCli("helm", args);
  rollingBack.value = false;

  if (cliSucceeded(result)) {
    toast({
      title: "Rollback successful",
      description: `Rolled back ${props.release.name} to revision ${rollbackRevision.value}`,
      autoDismiss: true,
    });
    emit("closeDialog");
    return;
  }

  const message = cliErrorMessage(result);
  error(
    `Error rolling back release ${props.release.name} to revision ${rollbackRevision.value}: ${message}`
  );
  toast({
    title: `Rollback of ${props.release.name} failed`,
    description: message,
    variant: "destructive",
    duration: 15000,
  });
};

const fetchRevisions = async () => {
  const args = [
    "history",
    props.release.name,
    "--kubeconfig",
    props.kubeConfig,
    "--output",
    "json",
    "--kube-context",
    props.context,
    "--namespace",
    props.release.namespace,
  ];

  const result = await runCli("helm", args);
  if (!cliSucceeded(result)) {
    error(`Error fetching Helm release history: ${cliErrorMessage(result)}`);
    return;
  }

  try {
    revisions.value = JSON.parse(result.stdout);
  } catch (e) {
    error(`Error parsing Helm release history: ${e}`);
  }
};

onMounted(() => {
  fetchRevisions();
});
</script>
<template>
  <Select v-model="rollbackRevision">
    <SelectTrigger>
      <SelectValue />
    </SelectTrigger>
    <SelectContent>
      <SelectGroup>
        <SelectLabel>Revisions</SelectLabel>
        <template v-for="revision in sortedRevisions" :key="revision.revision">
          <SelectItem :value="revision.revision">
            {{ revision.revision }} - {{ revision.chart }} -
            {{ revision.app_version }} -
            {{ formatDateTime(parseJSON(revision.updated)) }}
          </SelectItem>
        </template>
      </SelectGroup>
    </SelectContent>
  </Select>
  <AlertDialogFooter>
    <Button variant="ghost" @click="emit('closeDialog')">Cancel</Button>
    <Button
      variant="default"
      :disabled="!rollbackRevision || rollingBack"
      @click="rollback"
      >Rollback</Button
    >
  </AlertDialogFooter>
</template>

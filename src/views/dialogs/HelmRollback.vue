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
import { Label } from "@/components/ui/label";
import { Loader2, Undo2 } from "lucide-vue-next";
import { runCli, cliSucceeded, cliErrorMessage } from "@/actions/command";

import { useToast } from "@/components/ui/toast";
const { toast } = useToast();

import { formatAge } from "@/components/tables/age";
import { errorText } from "@/lib/auth/classify";
import { releaseHistory } from "@/lib/helmApi";
import type { HelmRevision } from "@/lib/helm";
import { error } from "@/lib/logger";
import { guard } from "@/lib/guardrails/guard";

const rollbackRevision = ref<string>("");
const revisions = ref<HelmRevision[]>([]);

/* Every revision but the current one, newest first. */
const sortedRevisions = computed(() =>
  revisions.value
    .filter((r) => r.revision !== Number(props.release.revision))
    .sort((a, b) => b.revision - a.revision)
);

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
    rollbackRevision.value,
    "--kube-context",
    props.context,
    "--namespace",
    props.release.namespace,
  ];
  if (props.kubeConfig) {
    args.push("--kubeconfig", props.kubeConfig);
  }

  const confirmed = await guard("helm-rollback", [
    {
      context: props.context,
      kubeConfig: props.kubeConfig,
      name: props.release.name,
      kind: "release",
      namespace: props.release.namespace,
    },
  ]);
  if (!confirmed) return;

  rollingBack.value = true;
  const result = await runCli("helm", args, { guarded: true });
  rollingBack.value = false;

  if (cliSucceeded(result)) {
    toast({
      title: `Rolled back ${props.release.name}`,
      description: `Now running revision ${rollbackRevision.value} again, as a new revision`,
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
    title: `Couldn't roll back ${props.release.name}`,
    description: message,
    variant: "destructive",
    duration: 15000,
  });
};

const fetchRevisions = async () => {
  try {
    revisions.value = await releaseHistory(
      { context: props.context, kubeConfig: props.kubeConfig },
      props.release.namespace,
      props.release.name
    );
  } catch (e) {
    error(`Error reading the Helm release history: ${errorText(e)}`);
  }
};

onMounted(() => {
  fetchRevisions();
});
</script>
<template>
  <div class="grid gap-1.5">
    <Label for="helm-rollback-revision" class="text-muted-foreground">Revision</Label>
    <Select v-model="rollbackRevision">
      <SelectTrigger id="helm-rollback-revision">
        <SelectValue placeholder="Pick a revision" />
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          <SelectLabel>Revisions</SelectLabel>
          <template v-for="revision in sortedRevisions" :key="revision.revision">
            <SelectItem :value="String(revision.revision)">
              <span class="tabular-nums">#{{ revision.revision }}</span>
              · {{ revision.chartVersion }}
              <span class="text-muted-foreground">
                · {{ revision.description }} · {{ formatAge(revision.updated) }} ago</span
              >
            </SelectItem>
          </template>
        </SelectGroup>
      </SelectContent>
    </Select>
  </div>
  <AlertDialogFooter>
    <Button variant="ghost" @click="emit('closeDialog')">Cancel</Button>
    <Button
      variant="default"
      :disabled="!rollbackRevision || rollingBack"
      @click="rollback"
    >
      <Loader2 v-if="rollingBack" class="h-3.5 w-3.5 animate-spin" />
      <Undo2 v-else class="h-3.5 w-3.5" />
      Roll back
    </Button>
  </AlertDialogFooter>
</template>

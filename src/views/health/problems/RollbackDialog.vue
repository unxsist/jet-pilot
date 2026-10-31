<script setup lang="ts">
/**
 * Roll a workload back to its previous revision (`kubectl rollout undo`),
 * showing what changes in its pod template. When GitOps or Helm manages it,
 * copying the change for Git comes first and rolling back here takes a
 * second, explicit step: the next sync would roll it forward again.
 */
import yaml from "js-yaml";
import { Check, Copy, Loader2 } from "lucide-vue-next";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { AlertDialogFooter } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/components/ui/toast";
import { runCliForEach } from "@/actions/command";
import { guard } from "@/lib/guardrails/guard";
import { clusterArgs } from "@/lib/workloads";
import { rolloutArgs, type Revision } from "@/lib/rollout";
import { ago } from "@/lib/resources/format";
import { fetchRevisions, fetchSubject, previousRevision } from "@/lib/health/problems/evidence";
import { revertPatch } from "@/lib/health/problems/fixes";
import { managerOf, type Manager } from "@/lib/health/problems/managed";
import type { Problem } from "@/lib/health/problems/model";
import ManagedNotice from "./ManagedNotice.vue";
import SpecDiff from "./SpecDiff.vue";

const props = defineProps<{ problem: Problem }>();
const emit = defineEmits(["closeDialog"]);

const loaded = ref(false);
const loadError = ref("");
const manager = shallowRef<Manager | null>(null);
const current = shallowRef<Revision | null>(null);
const target = shallowRef<Revision | null>(null);
const running = ref(false);
const anyway = ref(false);
const copied = ref(false);

onMounted(async () => {
  try {
    const workload = await fetchSubject(props.problem);
    if (!workload) throw new Error(`${props.problem.subject.kind} ${props.problem.subject.name} doesn't exist anymore.`);
    manager.value = managerOf(workload);
    const revisions = await fetchRevisions(props.problem, workload);
    current.value = revisions.find((r) => r.current) ?? null;
    target.value = previousRevision(revisions);
  } catch (e) {
    loadError.value = (e as { message?: string })?.message ?? String(e);
  } finally {
    loaded.value = true;
  }
});

const dump = (value: unknown) => yaml.dump(value ?? {}, { sortKeys: true, lineWidth: 120, noRefs: true });
const patch = computed(() =>
  target.value ? revertPatch(props.problem.subject.kind, current.value?.template, target.value.template) : null
);

const copyPatch = async () => {
  if (!patch.value) return;
  try {
    await writeText(dump(patch.value));
    copied.value = true;
    setTimeout(() => (copied.value = false), 1500);
  } catch (e) {
    toast({ title: "Couldn't copy the change", description: String(e), variant: "destructive" });
  }
};

const rollBack = async () => {
  const revision = target.value;
  if (!revision) return;
  const { subject, context, kubeConfig, namespace } = props.problem;
  if (!(await guard("rollback", [{ context, kubeConfig, name: subject.name, kind: subject.kind, namespace }]))) return;
  running.value = true;
  const { succeeded } = await runCliForEach("kubectl", [revision], {
    args: (r) => [
      ...rolloutArgs("undo", subject.kind, subject.name, [`--to-revision=${r.revision}`]),
      ...clusterArgs({ context, kubeConfig, namespace: namespace ?? "" }),
    ],
    label: (r) => `${subject.name} to revision ${r.revision}`,
    successVerb: "Rolled back",
    failureVerb: "roll back",
    guarded: true,
  });
  running.value = false;
  if (succeeded.length) emit("closeDialog");
};
</script>

<template>
  <div class="space-y-4">
    <div v-if="!loaded" class="space-y-2" aria-label="Loading revisions">
      <Skeleton class="h-4 w-2/3" />
      <Skeleton class="h-20 w-full" />
    </div>
    <p v-else-if="loadError" class="text-sm text-destructive">{{ loadError }}</p>
    <p v-else-if="!target" class="text-sm text-muted-foreground">There's no earlier revision to roll back to.</p>
    <template v-else>
      <ManagedNotice v-if="manager" :manager="manager" />
      <p class="text-sm">
        Back to revision {{ target.revision }}<span v-if="target.created" class="text-muted-foreground">, from {{ ago(target.created) }}</span>:
      </p>
      <SpecDiff :before="dump(current?.template?.spec)" :after="dump(target.template?.spec)" />
      <p v-if="manager && anyway" class="text-xs text-warning">The next {{ manager.tool === "helm" ? "upgrade" : "sync" }} rolls it forward again. Roll back here anyway?</p>
    </template>
  </div>
  <AlertDialogFooter>
    <Button variant="ghost" @click="emit('closeDialog')">{{ target ? "Cancel" : "Close" }}</Button>
    <template v-if="target && manager">
      <Button v-if="!anyway" variant="outline" @click="anyway = true">Roll back here…</Button>
      <Button v-else variant="outline" :disabled="running" @click="rollBack">
        <Loader2 v-if="running" class="h-3.5 w-3.5 animate-spin" />
        Roll back anyway
      </Button>
      <Button :disabled="!patch" @click="copyPatch">
        <Check v-if="copied" class="h-3.5 w-3.5" />
        <Copy v-else class="h-3.5 w-3.5" />
        {{ copied ? "Copied" : "Copy the change" }}
      </Button>
    </template>
    <Button v-else-if="target" :disabled="running" @click="rollBack">
      <Loader2 v-if="running" class="h-3.5 w-3.5 animate-spin" />
      Roll back to revision {{ target.revision }}
    </Button>
  </AlertDialogFooter>
</template>

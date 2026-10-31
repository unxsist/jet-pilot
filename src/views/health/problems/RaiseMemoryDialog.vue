<script setup lang="ts">
/**
 * Raise the memory limit of the container that ran out of it: half as much
 * again by default, previewed with a server-side dry run (the diff is what
 * the API server would store). When GitOps or Helm manages the workload,
 * copying the patch for Git comes first and applying here takes a second,
 * explicit step.
 */
import yaml from "js-yaml";
import { useDebounceFn } from "@vueuse/core";
import { Check, Copy, Loader2 } from "lucide-vue-next";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { AlertDialogFooter } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/components/ui/toast";
import { guard } from "@/lib/guardrails/guard";
import { kubePatch } from "@/lib/kubeApi";
import { pathOf } from "@/lib/resources/open";
import { fetchSubject, kubeTarget } from "@/lib/health/problems/evidence";
import { memoryLimitOf, memoryPatch, memoryTarget, suggestMemoryLimit, templateOf, validMemory } from "@/lib/health/problems/fixes";
import { managerOf, type Manager } from "@/lib/health/problems/managed";
import type { Problem } from "@/lib/health/problems/model";
import ManagedNotice from "./ManagedNotice.vue";
import SpecDiff from "./SpecDiff.vue";

const props = defineProps<{ problem: Problem }>();
const emit = defineEmits(["closeDialog"]);

const target = memoryTarget(props.problem);
const workload = shallowRef<any>(null);
const manager = shallowRef<Manager | null>(null);
const current = ref("");
const limit = ref("");
const loadError = ref("");

const preview = shallowRef<{ limit: string; after: string } | null>(null);
const previewError = ref("");
const previewing = ref(false);
const applying = ref(false);
/* Managed workloads: applying here is a second, explicit step. */
const applyAnyway = ref(false);
const copied = ref(false);

const specYaml = (object: any) => yaml.dump(templateOf(object)?.spec ?? {}, { sortKeys: true, lineWidth: 120, noRefs: true });
const before = computed(() => (workload.value ? specYaml(workload.value) : ""));
const patch = computed(() => (target && validMemory(limit.value) ? memoryPatch(props.problem.subject.kind, target, limit.value) : null));
const patchYaml = computed(() => (patch.value ? yaml.dump(patch.value, { lineWidth: 120, noRefs: true }) : ""));
const valid = computed(() => validMemory(limit.value));

const pathOfWorkload = () => pathOf({ context: props.problem.context, kubeConfig: props.problem.kubeConfig }, props.problem.subject);

/* The server's answer to the patch, without storing it. */
const runPreview = async () => {
  const value = limit.value.trim();
  if (!patch.value || !workload.value) return;
  previewing.value = true;
  previewError.value = "";
  try {
    const path = await pathOfWorkload();
    if (!path) throw new Error(`${props.problem.subject.kind} isn't served by this cluster.`);
    const result = await kubePatch(kubeTarget(props.problem), `${path}?dryRun=All`, patch.value, "strategic");
    if (value === limit.value.trim()) preview.value = { limit: value, after: specYaml(result) };
  } catch (e) {
    preview.value = null;
    previewError.value = (e as { message?: string })?.message ?? String(e);
  } finally {
    previewing.value = false;
  }
};
const previewSoon = useDebounceFn(runPreview, 350);
watch(limit, () => {
  preview.value = null;
  if (valid.value) previewSoon();
});

onMounted(async () => {
  try {
    const object = await fetchSubject(props.problem);
    if (!object) throw new Error(`${props.problem.subject.kind} ${props.problem.subject.name} doesn't exist anymore.`);
    workload.value = object;
    manager.value = managerOf(object);
    current.value = (target && memoryLimitOf(object, target)) || "";
    limit.value = current.value ? suggestMemoryLimit(current.value) : "";
  } catch (e) {
    loadError.value = (e as { message?: string })?.message ?? String(e);
  }
});

const ready = computed(() => !!preview.value && preview.value.limit === limit.value.trim() && !previewing.value);

const copyPatch = async () => {
  try {
    await writeText(patchYaml.value);
    copied.value = true;
    setTimeout(() => (copied.value = false), 1500);
  } catch (e) {
    toast({ title: "Couldn't copy the patch", description: String(e), variant: "destructive" });
  }
};

const apply = async () => {
  if (!ready.value || !patch.value) return;
  const { subject, context, kubeConfig, namespace } = props.problem;
  const allowed = await guard("set-resources", [{ context, kubeConfig, name: subject.name, kind: subject.kind, namespace }], {
    title: (name) => `Raise the memory limit of ${name}?`,
  });
  if (!allowed) return;
  applying.value = true;
  try {
    const path = await pathOfWorkload();
    await kubePatch(kubeTarget(props.problem), path!, patch.value, "strategic");
    toast({
      title: `Raised the memory limit of ${subject.name}`,
      description: `${target?.container} may now use ${limit.value.trim()}. Its pods are replaced with the new limit.`,
      variant: "success",
      autoDismiss: true,
    });
    emit("closeDialog");
  } catch (e) {
    toast({ title: `Couldn't change ${subject.name}`, description: (e as { message?: string })?.message ?? String(e), variant: "destructive" });
  } finally {
    applying.value = false;
  }
};
</script>

<template>
  <div class="space-y-4">
    <p v-if="loadError" class="text-sm text-destructive">{{ loadError }}</p>
    <div v-else-if="!workload" class="space-y-2" aria-label="Loading">
      <Skeleton class="h-9 w-full" />
      <Skeleton class="h-24 w-full" />
    </div>
    <template v-else>
      <ManagedNotice v-if="manager" :manager="manager" />

      <label class="grid gap-1.5">
        <span class="text-sm font-medium">New limit for {{ target?.container }}</span>
        <div class="flex items-center gap-3">
          <Input v-model="limit" class="w-32 font-mono" spellcheck="false" aria-label="Memory limit" />
          <span class="text-xs text-muted-foreground">Now {{ current || "none" }}</span>
          <Loader2 v-if="previewing" class="h-3.5 w-3.5 animate-spin text-muted-foreground" aria-label="Checking with the cluster" />
        </div>
        <span v-if="limit && !valid" class="text-xs text-destructive">A quantity like 768Mi or 2Gi.</span>
      </label>

      <div v-if="preview || previewError" class="space-y-1.5">
        <p class="text-xs text-muted-foreground">{{ previewError ? "The cluster refused it:" : "What the cluster would store (a dry run):" }}</p>
        <p v-if="previewError" class="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">{{ previewError }}</p>
        <SpecDiff v-else :before="before" :after="preview!.after" />
      </div>

      <p v-if="manager && applyAnyway" class="text-xs text-warning">It's undone the next time {{ manager.tool === "helm" ? "the release is upgraded" : "it syncs" }}. Apply it here anyway?</p>
    </template>
  </div>
  <AlertDialogFooter>
    <Button variant="ghost" @click="emit('closeDialog')">Cancel</Button>
    <template v-if="manager">
      <Button v-if="!applyAnyway" variant="outline" :disabled="!ready" @click="applyAnyway = true">Apply here…</Button>
      <Button v-else variant="outline" :disabled="!ready || applying" @click="apply">
        <Loader2 v-if="applying" class="h-3.5 w-3.5 animate-spin" />
        Apply anyway
      </Button>
      <Button :disabled="!patch" @click="copyPatch">
        <Check v-if="copied" class="h-3.5 w-3.5" />
        <Copy v-else class="h-3.5 w-3.5" />
        {{ copied ? "Copied" : "Copy patch" }}
      </Button>
    </template>
    <template v-else>
      <Button variant="outline" :disabled="!patch" @click="copyPatch">
        <Check v-if="copied" class="h-3.5 w-3.5" />
        <Copy v-else class="h-3.5 w-3.5" />
        {{ copied ? "Copied" : "Copy patch" }}
      </Button>
      <Button :disabled="!ready || applying" @click="apply">
        <Loader2 v-if="applying" class="h-3.5 w-3.5 animate-spin" />
        Raise to {{ valid ? limit.trim() : "…" }}
      </Button>
    </template>
  </AlertDialogFooter>
</template>

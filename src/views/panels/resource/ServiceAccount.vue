<script setup lang="ts">
/**
 * Side panel sections of a ServiceAccount: how it gets access (the
 * bindings that apply, also through its implicit groups) with a way into
 * the full review, and the workloads that run as it.
 */
import { Boxes, ChevronRight, ShieldCheck } from "lucide-vue-next";
import PanelSection from "@/components/generic/PanelSection.vue";
import GrantChain from "@/components/rbac/GrantChain.vue";
import { useRbacLinks } from "@/components/rbac/useRbacLinks";
import { errorMessage, podsOfServiceAccount, useRbacData, workloadsOf, type WorkloadRef } from "@/lib/accessReview";
import { effectivePermissions, identityOf, indexRbac, isFullAccess, joinWords, type RbacSubject } from "@/lib/rbac";

const props = defineProps<{
  resource: { metadata?: { name?: string; namespace?: string; context?: string; kubeConfig?: string } };
}>();
const { openSubject } = useRbacLinks();

const target = computed(() =>
  props.resource.metadata?.context
    ? { context: props.resource.metadata.context, kubeConfig: props.resource.metadata.kubeConfig ?? "" }
    : null
);
const subject = computed<RbacSubject>(() => ({
  kind: "ServiceAccount",
  name: props.resource.metadata?.name ?? "",
  namespace: props.resource.metadata?.namespace ?? "",
}));

const { data } = useRbacData(target);
const unknown = computed(() => (data.value?.unavailable.length ?? 0) > 0);
const permissions = computed(() =>
  data.value ? effectivePermissions(indexRbac(data.value.snapshot), identityOf(subject.value)) : null
);
/* What every signed-in user has says nothing about this account: left out. */
const grants = computed(() =>
  (permissions.value?.grants ?? []).filter((g) => g.viaGroup !== "system:authenticated")
);
const fullAccess = computed(() =>
  grants.value.some((g) => g.namespace === null && g.role?.rules?.some(isFullAccess))
);
const summary = computed(() => {
  if (!permissions.value) return "";
  if (fullAccess.value) return "Has full access to the cluster, like cluster-admin.";
  const everywhere = grants.value.some((g) => g.namespace === null && g.role);
  const namespaces = [...new Set(grants.value.filter((g) => g.namespace !== null && g.role).map((g) => g.namespace))];
  if (everywhere && namespaces.length) return `Has permissions everywhere, and more in ${joinWords(namespaces as string[])}.`;
  if (everywhere) return "Has permissions everywhere.";
  if (namespaces.length) return `Has permissions in ${joinWords(namespaces as string[])}.`;
  return "Nothing beyond what every signed-in user has.";
});

const workloads = ref<WorkloadRef[] | null>(null);
const workloadsError = ref<string | null>(null);
watch(
  [target, subject],
  async ([now, account]) => {
    workloads.value = null;
    workloadsError.value = null;
    if (!now || !account.namespace) return;
    try {
      const pods = await podsOfServiceAccount(now, account.namespace, account.name);
      if (target.value === now) workloads.value = workloadsOf(pods);
    } catch (error) {
      if (target.value === now) workloadsError.value = errorMessage(error);
    }
  },
  { immediate: true }
);
</script>

<template>
  <PanelSection value="access" title="Access" :icon="ShieldCheck" :count="permissions ? grants.length : undefined">
    <div class="space-y-3">
      <p v-if="!data" class="text-sm text-muted-foreground">Looking for bindings…</p>
      <p v-else-if="unknown && !grants.length" class="text-sm text-muted-foreground">
        You can't list this cluster's roles and bindings, so what it may do isn't known here.
      </p>
      <template v-else>
        <p class="text-sm" :class="fullAccess ? 'text-warning' : 'text-foreground'">{{ summary }}</p>
        <ul v-if="grants.length" class="space-y-2">
          <li v-for="grant in grants" :key="`${grant.binding.kind}/${grant.binding.metadata.namespace}/${grant.binding.metadata.name}`" class="min-w-0">
            <GrantChain :binding="grant.binding" :role="grant.role" :via-group="grant.viaGroup" />
            <p class="text-xs text-muted-foreground">{{ grant.namespace === null ? "Everywhere" : `In ${grant.namespace}` }}</p>
          </li>
        </ul>
      </template>
      <button
        type="button"
        class="inline-flex items-center gap-0.5 rounded text-sm font-medium text-link hover:underline focus-ring"
        @click="openSubject(subject, resource.metadata?.context)"
      >
        Review its permissions <ChevronRight class="h-3.5 w-3.5" />
      </button>
    </div>
  </PanelSection>

  <PanelSection value="runs" title="Runs as it" :icon="Boxes" :count="workloads?.length">
    <p v-if="workloadsError" class="text-sm text-muted-foreground">Couldn't list its pods: {{ workloadsError }}</p>
    <p v-else-if="!workloads" class="text-sm text-muted-foreground">Looking for pods…</p>
    <p v-else-if="!workloads.length" class="text-sm text-muted-foreground">No pods run as this service account right now.</p>
    <ul v-else class="space-y-1.5">
      <li v-for="workload in workloads" :key="`${workload.kind}/${workload.name}`" class="flex items-baseline justify-between gap-3 text-sm">
        <span class="min-w-0 truncate"><span class="text-muted-foreground">{{ workload.kind }}</span> {{ workload.name }}</span>
        <span class="shrink-0 text-xs text-muted-foreground">{{ workload.pods }} {{ workload.pods === 1 ? "pod" : "pods" }}</span>
      </li>
    </ul>
  </PanelSection>
</template>

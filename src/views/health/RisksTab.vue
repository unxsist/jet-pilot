<script setup lang="ts">
/*
 * Risks: what isn't broken yet but will hurt. Checked on demand, per
 * cluster, the first time the tab opens (and on "Check again"), then kept
 * for the session. Grouped by rule, most urgent first, in five sections:
 * expiring certificates, drain safety, reliability, security and what's
 * possibly unused.
 */
import { CircleAlert, ShieldCheck } from "lucide-vue-next";
import yaml from "js-yaml";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import CheckedLine from "./upkeep/CheckedLine.vue";
import RiskRule from "./upkeep/RiskRule.vue";
import { injectStrict } from "@/lib/utils";
import { listWords } from "@/lib/resources/format";
import { PanelProviderAddTabKey, PanelProviderSetSidePanelComponentKey } from "@/providers/PanelProvider";
import { SettingsContextStateKey } from "@/providers/SettingsContextProvider";
import { resolveCluster } from "@/lib/clusters/meta";
import { contextKey } from "@/lib/contextKey";
import { followRef } from "@/lib/resources/open";
import { allowed } from "@/lib/guardrails/guard";
import { renewCertificate } from "@/lib/operators/actions";
import { riskChecks } from "@/lib/health/checks/session";
import { checkRisks } from "@/lib/health/checks/collect";
import { groupRisks, type RiskItem } from "@/lib/health/checks/rules";
import { disruptionBudgetFor } from "@/lib/health/checks/workloads";
import type { HealthTarget } from "@/lib/health/tabs";

const props = defineProps<{ targets: HealthTarget[] }>();

const setSidePanel = injectStrict(PanelProviderSetSidePanelComponentKey);
const addTab = injectStrict(PanelProviderAddTabKey);
const { settings } = injectStrict(SettingsContextStateKey);

const clusterOf = (t: { context: string; kubeConfig: string }) =>
  resolveCluster(settings.value.clusters, t.context, t.kubeConfig);
const keyOf = (t: HealthTarget) => `${contextKey(t.context, t.kubeConfig)}|${t.namespaces.join(",")}`;

function check(force = false) {
  for (const target of props.targets) {
    const key = keyOf(target);
    if (force || !riskChecks.get(key)) {
      void riskChecks.run(key, () => checkRisks(target, clusterOf(target).env === "prod"));
    }
  }
}
watch(() => props.targets.map(keyOf).join("\n"), () => check(), { immediate: true });

const states = computed(() => props.targets.map((target) => ({ target, state: riskChecks.get(keyOf(target)) })));
const items = computed(() => states.value.flatMap(({ state }) => state?.result?.items ?? []));
const sections = computed(() => groupRisks(items.value));
const running = computed(() => states.value.some(({ state }) => state?.running));
const firstCheck = computed(() => states.value.some(({ state }) => !state || (state.running && !state.result && !state.error)));
const checkedAt = computed(() => {
  const times = states.value.map(({ state }) => state?.at).filter((at): at is number => !!at);
  return times.length ? Math.min(...times) : null;
});
const errors = computed(() =>
  states.value
    .filter(({ state }) => state?.error)
    .map(({ target, state }) => ({ name: clusterOf(target).displayName, message: state!.error! }))
);
const skipped = computed(() =>
  states.value
    .filter(({ state }) => state?.result?.skipped.length)
    .map(({ target, state }) => {
      const what = listWords(state!.result!.skipped);
      return props.targets.length > 1
        ? `Couldn't read ${what} in ${clusterOf(target).displayName}, so their rules are left out.`
        : `Couldn't read ${what}, so their rules are left out.`;
    })
);

const multiple = computed(() => props.targets.length > 1);
const itemCluster = (item: RiskItem) => clusterOf(item).displayName;

/* Rules expand one by one; a fresh check keeps what's open. */
const expanded = reactive(new Set<string>());
const toggle = (id: string) => (expanded.has(id) ? expanded.delete(id) : expanded.add(id));

const open = (item: RiskItem) =>
  followRef(setSidePanel, null, { context: item.context, kubeConfig: item.kubeConfig }, item.object);

const ObjectEditor = defineAsyncComponent(() => import("@/views/ObjectEditor.vue"));

function act(item: RiskItem) {
  const { context, kubeConfig, object } = item;
  if (item.action === "renew") {
    void renewCertificate({
      ...item.raw,
      apiVersion: object.apiVersion,
      kind: object.kind,
      metadata: { ...item.raw?.metadata, context, kubeConfig },
    });
  } else if (item.action === "add-pdb") {
    if (!allowed("create", [{ context, kubeConfig, kind: "PodDisruptionBudget", namespace: object.namespace }])) return;
    addTab(
      `create_pdb_${context}_${object.namespace}_${object.name}`,
      "New PodDisruptionBudget",
      ObjectEditor,
      {
        context,
        kubeConfig,
        namespace: object.namespace,
        create: true,
        type: "poddisruptionbudget",
        kind: "PodDisruptionBudget",
        useKubeCtl: false,
        manifest: yaml.dump(disruptionBudgetFor(object, item.raw), { lineWidth: -1 }),
      },
      "edit"
    );
  }
}
</script>

<template>
  <EmptyState
    v-if="!targets.length"
    :icon="ShieldCheck"
    title="No active clusters"
    description="Connect to a cluster to check it for risks."
  />

  <div v-else class="space-y-6">
    <CheckedLine class="px-3" :at="checkedAt" :running="running" @again="check(true)" />

    <div
      v-for="error in errors"
      :key="error.name"
      class="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive"
      role="alert"
    >
      <CircleAlert class="mt-px h-3.5 w-3.5 shrink-0" />
      <span>Couldn't check {{ error.name }}: {{ error.message }}</span>
    </div>

    <div v-if="firstCheck && !sections.length" class="space-y-px" aria-label="Checking for risks">
      <div v-for="index in 5" :key="index" class="flex h-14 items-center gap-3 px-3">
        <Skeleton class="h-2 w-2 rounded-full" />
        <div class="flex-1 space-y-1.5">
          <Skeleton class="h-3.5 w-64" />
          <Skeleton class="h-3 w-80" />
        </div>
      </div>
    </div>

    <EmptyState
      v-else-if="!sections.length && !errors.length"
      :icon="ShieldCheck"
      title="Nothing to worry about"
      description="No certificates about to expire, nothing that blocks a node drain, and the workloads follow good practice."
    />

    <template v-else>
      <section v-for="section in sections" :key="section.id" :aria-label="section.title">
        <h2 class="mb-1 flex h-7 items-center gap-2 px-3 text-xs font-medium text-muted-foreground">
          <span class="text-foreground/80">{{ section.title }}</span>
        </h2>
        <div class="space-y-px">
          <RiskRule
            v-for="group in section.groups"
            :key="group.rule.id"
            :group="group"
            :expanded="expanded.has(group.rule.id)"
            :cluster-of="multiple ? itemCluster : undefined"
            @toggle="toggle(group.rule.id)"
            @open="open"
            @act="act"
          />
        </div>
      </section>
    </template>

    <div v-if="sections.length || skipped.length" class="space-y-1 px-3 text-xs text-muted-foreground/80">
      <p v-for="line in skipped" :key="line">{{ line }}</p>
      <p v-if="sections.length">Click a rule for what to fix · kube-system is left out of the workload rules</p>
    </div>
  </div>
</template>

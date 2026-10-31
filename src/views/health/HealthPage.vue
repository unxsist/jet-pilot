<script setup lang="ts">
/*
 * Health: what needs attention on the active clusters, in four tabs.
 *
 *   Problems  what is broken now, grouped by the workload it belongs to,
 *             with the evidence and a fix.
 *   Risks     what isn't broken yet but will hurt (checks run on demand).
 *   Upgrades  what stands between a cluster and its next version, and what
 *             is out of support.
 *   Changes   what changed recently, newest first.
 *
 * `?tab=` opens a tab. Every tab works on all active contexts and their
 * selected namespaces (`targets`).
 */
import { useRoute, useRouter } from "vue-router";
import PageHeader from "@/components/page/PageHeader.vue";
import PageTabs from "@/components/page/PageTabs.vue";
import { KubeContextStateKey } from "@/providers/KubeContextProvider";
import { SettingsContextStateKey } from "@/providers/SettingsContextProvider";
import { injectStrict } from "@/lib/utils";
import { activeTargets } from "@/lib/multicontext";
import { resolveCluster } from "@/lib/clusters/meta";
import { HEALTH_TABS, type HealthTab } from "@/lib/health/tabs";
import { useProblemCount } from "@/lib/health/problems/feed";

/* Each tab loads on its first visit. */
const ProblemsTab = defineAsyncComponent(() => import("./ProblemsTab.vue"));
const RisksTab = defineAsyncComponent(() => import("./RisksTab.vue"));
const UpgradesTab = defineAsyncComponent(() => import("./UpgradesTab.vue"));
const ChangesTab = defineAsyncComponent(() => import("./ChangesTab.vue"));

const route = useRoute();
const router = useRouter();
const { contexts, contextKubeConfigMapping } = injectStrict(KubeContextStateKey);
const { settings } = injectStrict(SettingsContextStateKey);

const targets = computed(() => activeTargets(contexts.value, contextKubeConfigMapping.value));

const subtitle = computed(() => {
  const names = targets.value.map(
    (t) => resolveCluster(settings.value.clusters, t.context, t.kubeConfig).displayName
  );
  if (!names.length) return undefined;
  return names.length > 3
    ? `Across ${names.length} clusters`
    : `Across ${new Intl.ListFormat("en", { style: "long", type: "conjunction" }).format(names)}`;
});

/* Problems are counted on their tab, wherever the page is. */
const problems = useProblemCount(() => targets.value);
const tabs = computed(() => HEALTH_TABS.map((t) => (t.id === "problems" ? { ...t, count: problems.count.value || null } : t)));

const tab = ref<HealthTab>("problems");
watch(
  () => route.query.tab,
  (value) => {
    if (route.name !== "Health") return;
    tab.value = HEALTH_TABS.some((t) => t.id === value) ? (value as HealthTab) : "problems";
  },
  { immediate: true }
);
watch(tab, (value) => {
  if (route.name !== "Health") return;
  if ((route.query.tab ?? "problems") !== value) {
    router.replace({ query: { ...route.query, tab: value === "problems" ? undefined : value } });
  }
});
</script>

<template>
  <div class="h-full overflow-auto bg-background">
    <div class="mx-auto max-w-5xl space-y-6 px-10 pb-16 pt-10">
      <PageHeader title="Health" :description="subtitle">
        <template #tabs>
          <PageTabs v-model="tab" label="Health" :tabs="tabs" />
        </template>
      </PageHeader>

      <ProblemsTab v-if="tab === 'problems'" :targets="targets" />
      <RisksTab v-else-if="tab === 'risks'" :targets="targets" />
      <UpgradesTab v-else-if="tab === 'upgrades'" :targets="targets" />
      <ChangesTab v-else :targets="targets" />
    </div>
  </div>
</template>

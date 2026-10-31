<script setup lang="ts">
/*
 * Upgrades: one card per active cluster with its support status and what
 * stands between it and the next Kubernetes minor. Checked on demand the
 * first time the tab opens (and on "Check again"), kept for the session.
 * Clusters that need something come first.
 */
import { ArrowUpCircle } from "lucide-vue-next";
import { EmptyState } from "@/components/ui/empty-state";
import CheckedLine from "./upkeep/CheckedLine.vue";
import UpgradeCard from "./upkeep/UpgradeCard.vue";
import { injectStrict } from "@/lib/utils";
import { SettingsContextStateKey } from "@/providers/SettingsContextProvider";
import { resolveCluster } from "@/lib/clusters/meta";
import { contextKey } from "@/lib/contextKey";
import { inventory } from "@/lib/clusters/inventory";
import { upgradeChecks } from "@/lib/health/checks/session";
import { checkUpgrades, type UpgradeReport } from "@/lib/upgrades/check";
import { addonsSummary, apisSummary } from "@/lib/upgrades/words";
import type { HealthTarget } from "@/lib/health/tabs";

const props = defineProps<{ targets: HealthTarget[] }>();
const { settings } = injectStrict(SettingsContextStateKey);

/* Upgrades are about the whole cluster: one check per context, whatever namespaces are selected. */
const keyOf = (t: HealthTarget) => contextKey(t.context, t.kubeConfig);
const providerOf = (t: HealthTarget) =>
  inventory.value?.find((e) => e.context === t.context && e.kubeConfig === t.kubeConfig)?.provider.id ?? null;

function check(force = false) {
  for (const target of props.targets) {
    const key = keyOf(target);
    if (force || !upgradeChecks.get(key)) void upgradeChecks.run(key, () => checkUpgrades(target, providerOf(target)));
  }
}
watch(() => props.targets.map(keyOf).join("\n"), () => check(), { immediate: true });

const RANK: Record<string, number> = { destructive: 0, warning: 1 };
const urgency = (r: UpgradeReport | null | undefined) => {
  if (!r) return 5;
  const tones = [r.support?.tone, apisSummary(r.apis).tone, addonsSummary(r.addons).tone];
  return Math.min(...tones.map((t) => RANK[t ?? ""] ?? 3));
};

const cards = computed(() =>
  props.targets
    .map((target) => ({
      target,
      key: keyOf(target),
      name: resolveCluster(settings.value.clusters, target.context, target.kubeConfig).displayName,
      state: upgradeChecks.get(keyOf(target)),
    }))
    .sort((a, b) => urgency(a.state?.result) - urgency(b.state?.result))
);
const running = computed(() => cards.value.some((c) => c.state?.running));
const checkedAt = computed(() => {
  const times = cards.value.map((c) => c.state?.at).filter((at): at is number => !!at);
  return times.length ? Math.min(...times) : null;
});
</script>

<template>
  <EmptyState
    v-if="!targets.length"
    :icon="ArrowUpCircle"
    title="No active clusters"
    description="Connect to a cluster to see what its next upgrade needs."
  />
  <div v-else class="space-y-4">
    <CheckedLine class="px-3" :at="checkedAt" :running="running" @again="check(true)" />
    <UpgradeCard v-for="card in cards" :key="card.key" :target="card.target" :name="card.name" :state="card.state" />
    <p class="px-3 text-xs text-muted-foreground/80">Support dates and API removals ship with JET Pilot and come from endoflife.date and Pluto.</p>
  </div>
</template>

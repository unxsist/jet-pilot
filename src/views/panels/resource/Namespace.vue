<script setup lang="ts">
/**
 * A namespace: what runs in it (counts, with the pods that need attention),
 * how much of its quota is used, and the defaults and bounds its limit
 * ranges set.
 */
import { Gauge, LayoutGrid, Ruler } from "lucide-vue-next";
import PanelSection from "@/components/generic/PanelSection.vue";
import FactList from "@/components/generic/FactList.vue";
import Fact from "@/components/generic/Fact.vue";
import CapacityBar from "@/components/generic/CapacityBar.vue";
import { useNow, usePanelTarget, useRelatedList } from "@/composables/usePanelObject";
import { podState } from "@/lib/resources/pod";
import { limitRangeLines, quotaLines } from "@/lib/resources/quota";

const props = defineProps<{ resource: any }>();
const target = usePanelTarget(() => props.resource);
const now = useNow();

const name = () => (props.resource.metadata?.name ? [props.resource.metadata.name as string] : null);
const list = (kind: string) => useRelatedList(() => kind, () => target.value, name);

const pods = list("Pod");
const deployments = list("Deployment");
const statefulSets = list("StatefulSet");
const daemonSets = list("DaemonSet");
const cronJobs = list("CronJob");
const services = list("Service");
const quotas = list("ResourceQuota");
const limitRanges = list("LimitRange");

const troubledPods = computed(
  () => pods.items.value.filter((pod: any) => ["destructive", "warning"].includes(podState(pod, now.value).tone)).length
);

const counts = computed(() => [
  { label: "Pods", value: pods.items.value.length, note: troubledPods.value ? `${troubledPods.value} need attention` : "" },
  { label: "Deployments", value: deployments.items.value.length },
  { label: "StatefulSets", value: statefulSets.items.value.length },
  { label: "DaemonSets", value: daemonSets.items.value.length },
  { label: "CronJobs", value: cronJobs.items.value.length },
  { label: "Services", value: services.items.value.length },
]);
const loading = computed(() => pods.loading.value && !pods.items.value.length);
</script>

<template>
  <PanelSection value="overview" title="What runs here" :icon="LayoutGrid">
    <div class="grid grid-cols-3 overflow-hidden rounded-lg border" :class="loading ? 'opacity-60' : ''">
      <div
        v-for="(count, index) in counts"
        :key="count.label"
        class="bg-surface-1/60 px-3 py-2"
        :class="[index % 3 ? 'border-l' : '', index >= 3 ? 'border-t' : '']"
      >
        <div class="text-lg font-semibold tabular-nums" :class="count.value ? 'text-foreground' : 'text-muted-foreground'">
          {{ count.value }}
        </div>
        <div class="text-xs font-medium text-muted-foreground">{{ count.label }}</div>
        <div v-if="count.note" class="text-xs text-warning">{{ count.note }}</div>
      </div>
    </div>
  </PanelSection>

  <PanelSection
    v-if="quotas.items.value.length"
    value="quota"
    title="Quota"
    :icon="Gauge"
    :count="quotas.items.value.length"
  >
    <div class="space-y-5">
      <div v-for="quota in quotas.items.value" :key="quota.metadata?.uid">
        <div v-if="quotas.items.value.length > 1" class="mb-2 text-xs font-medium text-foreground/80">
          {{ quota.metadata?.name }}
        </div>
        <div class="space-y-3">
          <CapacityBar
            v-for="line in quotaLines(quota)"
            :key="line.key"
            :label="line.label"
            :used="line.used"
            :total="line.hard"
            :used-text="line.usedText"
            :total-text="line.hardText"
            strict
          />
        </div>
      </div>
    </div>
  </PanelSection>

  <PanelSection
    v-if="limitRanges.items.value.length"
    value="limits"
    title="Limit ranges"
    :icon="Ruler"
    :count="limitRanges.items.value.length"
  >
    <div class="space-y-4">
      <div v-for="range in limitRanges.items.value" :key="range.metadata?.uid" class="space-y-3">
        <div v-for="entry in limitRangeLines(range)" :key="entry.type">
          <div class="mb-1.5 text-xs font-medium text-foreground/80">{{ entry.type }}</div>
          <FactList>
            <Fact v-for="line in entry.lines" :key="line.label" :label="line.label" :value="line.value" />
          </FactList>
        </div>
      </div>
    </div>
  </PanelSection>
</template>

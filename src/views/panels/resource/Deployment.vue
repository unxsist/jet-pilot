<script setup lang="ts">
/** A Deployment: its replicas, how it rolls out, and its pods. */
import { Activity } from "lucide-vue-next";
import { V1Deployment } from "@kubernetes/client-node";
import PanelSection from "@/components/generic/PanelSection.vue";
import FactList from "@/components/generic/FactList.vue";
import Fact from "@/components/generic/Fact.vue";
import ReplicaStats from "@/components/generic/ReplicaStats.vue";
import WorkloadPods from "@/views/panels/resource/workload/WorkloadPods.vue";

const props = defineProps<{ resource: V1Deployment }>();

const desired = computed(() => props.resource.spec?.replicas ?? 0);
const ready = computed(() => props.resource.status?.readyReplicas ?? 0);

const stats = computed(() => [
  { label: "Ready", value: ready.value, warn: ready.value < desired.value },
  { label: "Desired", value: desired.value },
  { label: "Updated", value: props.resource.status?.updatedReplicas ?? 0 },
  {
    label: "Unavailable",
    value: props.resource.status?.unavailableReplicas ?? 0,
    warn: (props.resource.status?.unavailableReplicas ?? 0) > 0,
  },
]);

const strategy = computed(() => {
  const s = props.resource.spec?.strategy;
  if (s?.type === "Recreate") return { name: "Recreate", words: "Old pods stop before new ones start" };
  const rolling = s?.rollingUpdate;
  return {
    name: "Rolling update",
    words: `At most ${rolling?.maxUnavailable ?? "25%"} unavailable and ${rolling?.maxSurge ?? "25%"} extra during a rollout`,
  };
});
const revision = computed(() => props.resource.metadata?.annotations?.["deployment.kubernetes.io/revision"]);
</script>
<template>
  <PanelSection value="status" title="Status & replicas" :icon="Activity">
    <div class="space-y-4">
      <ReplicaStats :stats="stats" :ready="ready" :desired="desired" />
      <FactList>
        <Fact label="Strategy">
          {{ strategy.name }}
          <span class="block text-xs text-muted-foreground">{{ strategy.words }}</span>
        </Fact>
        <Fact v-if="revision" label="Revision" :value="revision" />
        <Fact v-if="resource.spec?.paused" label="Rollouts" value="Paused" />
      </FactList>
    </div>
  </PanelSection>
  <WorkloadPods :workload="resource" />
</template>

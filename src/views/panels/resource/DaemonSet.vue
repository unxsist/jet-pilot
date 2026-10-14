<script setup lang="ts">
/** A DaemonSet: one pod per matching node, how many run and are ready, which nodes it targets, and its pods. */
import { Activity } from "lucide-vue-next";
import PanelSection from "@/components/generic/PanelSection.vue";
import FactList from "@/components/generic/FactList.vue";
import Fact from "@/components/generic/Fact.vue";
import ReplicaStats from "@/components/generic/ReplicaStats.vue";
import WorkloadPods from "@/views/panels/resource/workload/WorkloadPods.vue";
import { schedulingWords } from "@/lib/resources/pod";

const props = defineProps<{ resource: any }>();

const status = computed(() => props.resource.status ?? {});
const desired = computed(() => status.value.desiredNumberScheduled ?? 0);
const ready = computed(() => status.value.numberReady ?? 0);

const stats = computed(() => [
  { label: "Ready", value: ready.value, warn: ready.value < desired.value },
  { label: "Nodes", value: desired.value },
  { label: "Updated", value: status.value.updatedNumberScheduled ?? desired.value },
  { label: "Misplaced", value: status.value.numberMisscheduled ?? 0, warn: (status.value.numberMisscheduled ?? 0) > 0 },
]);

const scheduling = computed(() => schedulingWords(props.resource.spec?.template?.spec));
const nodes = computed(() => scheduling.value.rules.filter((rule) => /nodes? /.test(rule))[0] ?? "Every node it tolerates");
const updates = computed(() => {
  const strategy = props.resource.spec?.updateStrategy;
  if (strategy?.type === "OnDelete") return "Only when you delete a pod";
  return `Rolling, at most ${strategy?.rollingUpdate?.maxUnavailable ?? 1} node at a time`;
});
</script>
<template>
  <PanelSection value="status" title="Status & nodes" :icon="Activity">
    <div class="space-y-4">
      <ReplicaStats :stats="stats" :ready="ready" :desired="desired" />
      <FactList>
        <Fact label="Runs on" :value="nodes" />
        <Fact v-if="scheduling.tolerations.length" label="Tolerates">
          <span v-for="toleration in scheduling.tolerations" :key="toleration" class="block">{{
            toleration.replace(/^Tolerates /, "")
          }}</span>
        </Fact>
        <Fact label="Updates" :value="updates" />
      </FactList>
    </div>
  </PanelSection>
  <WorkloadPods :workload="resource" />
</template>

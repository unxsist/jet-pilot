<script setup lang="ts">
/**
 * A StatefulSet: its replicas, its governing Service, how pods start and
 * update, the claims each replica keeps, and its pods.
 */
import { Activity, HardDrive } from "lucide-vue-next";
import PanelSection from "@/components/generic/PanelSection.vue";
import FactList from "@/components/generic/FactList.vue";
import Fact from "@/components/generic/Fact.vue";
import ObjectLink from "@/components/generic/ObjectLink.vue";
import ReplicaStats from "@/components/generic/ReplicaStats.vue";
import WorkloadPods from "@/views/panels/resource/workload/WorkloadPods.vue";
import { usePanelTarget } from "@/composables/usePanelObject";

const props = defineProps<{ resource: any }>();
const target = usePanelTarget(() => props.resource);

const spec = computed(() => props.resource.spec ?? {});
const status = computed(() => props.resource.status ?? {});
const namespace = computed(() => props.resource.metadata?.namespace as string);
const desired = computed(() => spec.value.replicas ?? 1);
const ready = computed(() => status.value.readyReplicas ?? 0);

const stats = computed(() => [
  { label: "Ready", value: ready.value, warn: ready.value < desired.value },
  { label: "Desired", value: desired.value },
  { label: "Current", value: status.value.currentReplicas ?? 0 },
  { label: "Updated", value: status.value.updatedReplicas ?? status.value.currentReplicas ?? 0 },
]);

const ordering = computed(() =>
  spec.value.podManagementPolicy === "Parallel"
    ? "All at once"
    : "One at a time, in order (0, 1, 2…)"
);
const updates = computed(() => {
  const strategy = spec.value.updateStrategy;
  if (strategy?.type === "OnDelete") return "Only when you delete a pod";
  const partition = strategy?.rollingUpdate?.partition;
  return partition ? `Rolling, replicas ${partition} and up only` : "Rolling, highest replica first";
});

/* Each replica's claims: <template>-<name>-<ordinal>. */
const claims = computed(() =>
  (spec.value.volumeClaimTemplates ?? []).flatMap((template: any) =>
    Array.from({ length: desired.value }, (_, ordinal) => `${template.metadata?.name}-${props.resource.metadata?.name}-${ordinal}`)
  )
);
</script>
<template>
  <PanelSection value="status" title="Status & replicas" :icon="Activity">
    <div class="space-y-4">
      <ReplicaStats :stats="stats" :ready="ready" :desired="desired" />
      <FactList>
        <Fact v-if="spec.serviceName" label="Service">
          <ObjectLink :object-ref="{ kind: 'Service', name: spec.serviceName, namespace }" :target="target" />
        </Fact>
        <Fact label="Starts pods" :value="ordering" />
        <Fact label="Updates" :value="updates" />
      </FactList>
    </div>
  </PanelSection>

  <PanelSection v-if="claims.length" value="claims" title="Volume claims" :icon="HardDrive" :count="claims.length">
    <ul class="space-y-1.5">
      <li v-for="claim in claims" :key="claim" class="text-sm">
        <ObjectLink :object-ref="{ kind: 'PersistentVolumeClaim', name: claim, namespace }" :target="target" icon />
      </li>
    </ul>
    <p class="mt-2 text-xs text-muted-foreground">Each replica keeps its own claims, also when it is deleted or scaled down.</p>
  </PanelSection>

  <WorkloadPods :workload="resource" />
</template>

<script setup lang="ts">
/** A ReplicaSet: its replicas, the Deployment (and revision) it belongs to, and its pods. */
import { Activity } from "lucide-vue-next";
import PanelSection from "@/components/generic/PanelSection.vue";
import FactList from "@/components/generic/FactList.vue";
import Fact from "@/components/generic/Fact.vue";
import OwnerChain from "@/components/generic/OwnerChain.vue";
import ReplicaStats from "@/components/generic/ReplicaStats.vue";
import WorkloadPods from "@/views/panels/resource/workload/WorkloadPods.vue";
import { usePanelTarget } from "@/composables/usePanelObject";

const props = defineProps<{ resource: any }>();
const target = usePanelTarget(() => props.resource);

const status = computed(() => props.resource.status ?? {});
const desired = computed(() => props.resource.spec?.replicas ?? 0);
const ready = computed(() => status.value.readyReplicas ?? 0);

const stats = computed(() => [
  { label: "Ready", value: ready.value, warn: ready.value < desired.value },
  { label: "Desired", value: desired.value },
  { label: "Available", value: status.value.availableReplicas ?? 0 },
]);
const revision = computed(() => props.resource.metadata?.annotations?.["deployment.kubernetes.io/revision"]);
const owned = computed(() => (props.resource.metadata?.ownerReferences ?? []).length > 0);
</script>
<template>
  <PanelSection value="status" title="Status & replicas" :icon="Activity">
    <div class="space-y-4">
      <ReplicaStats :stats="stats" :ready="ready" :desired="desired" />
      <FactList>
        <Fact label="Controlled by">
          <OwnerChain v-if="owned" :object="resource" :target="target" />
          <span v-else class="text-muted-foreground">Nothing: it stands on its own</span>
        </Fact>
        <Fact v-if="revision" label="Revision">
          {{ revision }}
          <span v-if="desired === 0" class="text-xs text-muted-foreground"> · an older version, kept for rollbacks</span>
        </Fact>
      </FactList>
    </div>
  </PanelSection>
  <WorkloadPods v-if="desired > 0 || ready > 0" :workload="resource" />
</template>

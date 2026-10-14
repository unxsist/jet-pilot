<script setup lang="ts">
/**
 * A node: its roles and where it runs, whether it takes new pods (Cordon /
 * Uncordon right there), how much of it the pods have requested, its
 * taints (editable), its pods and, folded, the system it runs.
 */
import { useRouter } from "vue-router";
import { Box, Cpu, Info, Pencil, ShieldAlert, SlidersHorizontal } from "lucide-vue-next";
import { Button } from "@/components/ui/button";
import PanelSection from "@/components/generic/PanelSection.vue";
import FactList from "@/components/generic/FactList.vue";
import Fact from "@/components/generic/Fact.vue";
import CapacityBar from "@/components/generic/CapacityBar.vue";
import PodList from "@/components/generic/PodList.vue";
import Taints from "@/views/panels/resource/node/Taints.vue";
import { PanelSectionsKey } from "@/components/generic/panelSections";
import { useNow, usePanelTarget, useRelatedList } from "@/composables/usePanelObject";
import { injectStrict } from "@/lib/utils";
import { PanelProviderAddTabKey, PanelProviderSetSidePanelComponentKey } from "@/providers/PanelProvider";
import { DialogProviderSpawnDialogKey } from "@/providers/DialogProvider";
import { allowed, rowTargets } from "@/lib/guardrails/guard";
import { guardedCluster } from "@/lib/guardrails/backstop";
import { readOnlyReason } from "@/lib/guardrails/policy";
import { formatBytes, formatCores } from "@/lib/metrics/units";
import { listWords } from "@/lib/resources/format";
import { isActivePod, nodeAllocation, nodeHealth, nodePlacement, nodeRoles } from "@/lib/resources/node";
import { podState } from "@/lib/resources/pod";
import { actions as nodeActions } from "@/actions/nodes";

const props = defineProps<{ resource: any }>();
const target = usePanelTarget(() => props.resource);
const now = useNow();

const labels = computed(() => props.resource.metadata?.labels ?? {});
const roles = computed(() => nodeRoles(labels.value));
const placement = computed(() => nodePlacement(labels.value));
const health = computed(() => nodeHealth(props.resource));
const info = computed(() => props.resource.status?.nodeInfo ?? {});
const addresses = computed<{ type: string; address: string }[]>(() => props.resource.status?.addresses ?? []);
const internalIp = computed(() => addresses.value.find((a) => a.type === "InternalIP")?.address);
const externalIp = computed(() => addresses.value.find((a) => a.type === "ExternalIP")?.address);

/* The pods on this node, from the all-namespaces pod watch (shared with the Pods table). */
const { items: allPods } = useRelatedList(() => "Pod", () => target.value, () => ["all"]);
const pods = computed(() =>
  allPods.value.filter((pod: any) => pod.spec?.nodeName === props.resource.metadata?.name && isActivePod(pod))
);
const troubled = computed(
  () => pods.value.filter((pod: any) => ["destructive", "warning"].includes(podState(pod, now.value).tone)).length
);
const allocation = computed(() => nodeAllocation(props.resource, pods.value));

/* ------------------------------------------------------- cordon -- */

const cordoned = computed(() => props.resource.spec?.unschedulable === true);
const readOnly = computed(() => {
  const cluster = guardedCluster(target.value.context, target.value.kubeConfig);
  return cluster.readOnly ? readOnlyReason(cluster) : "";
});
const cordonAction = nodeActions(
  injectStrict(PanelProviderAddTabKey),
  injectStrict(DialogProviderSpawnDialogKey),
  injectStrict(PanelProviderSetSidePanelComponentKey),
  useRouter()
).find((action) => typeof action.label === "function");
const toggleCordon = () => (cordonAction as { handler: (row: any) => void } | undefined)?.handler(props.resource);

/* -------------------------------------------------------- taints -- */

const sections = inject(PanelSectionsKey, null);
const editingTaints = ref(false);
const editTaints = () => {
  if (!allowed("edit-taints", rowTargets([props.resource], "Node"))) return;
  sections?.open("taints");
  editingTaints.value = true;
};
watch(
  () => props.resource.metadata?.uid,
  () => (editingTaints.value = false)
);

const systemHint = computed(() =>
  [info.value.kubeletVersion, info.value.containerRuntimeVersion?.replace("://", " ")].filter(Boolean).join(" · ")
);
const instance = computed(() =>
  [placement.value.instanceType, placement.value.capacityType].filter(Boolean).join(" · ")
);
const where = computed(() =>
  [placement.value.zone, placement.value.region && placement.value.zone?.startsWith(placement.value.region) ? "" : placement.value.region]
    .filter(Boolean)
    .join(" · ")
);
</script>

<template>
  <PanelSection value="overview" title="Overview" :icon="Info">
      <FactList>
        <Fact label="Scheduling">
          <span class="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
            <span :class="cordoned ? 'text-warning' : ''">{{
              cordoned ? "Cordoned: no new pods" : "Takes new pods"
            }}</span>
            <Button
              variant="outline"
              size="xs"
              :disabled="!!readOnly || !cordonAction"
              :title="readOnly || (cordoned ? 'Let new pods be scheduled here again' : 'Stop scheduling new pods here; running pods stay')"
              @click="toggleCordon"
            >
              {{ cordoned ? "Uncordon" : "Cordon" }}
            </Button>
          </span>
        </Fact>
        <Fact label="Health">
          <span v-if="!health.problems.length && health.ready === 'True'" class="text-muted-foreground"
            >No memory, disk or process pressure</span
          >
          <span v-else-if="health.problems.length" class="text-warning">{{
            listWords(health.problems.map((p) => p.label.toLowerCase())).replace(/^./, (c) => c.toUpperCase())
          }}</span>
          <span v-else class="text-destructive">Not ready</span>
        </Fact>
        <Fact v-if="roles.length" label="Roles" :value="roles.join(', ')" />
        <Fact v-if="where" label="Zone" :value="where" />
        <Fact v-if="instance" label="Instance" :value="instance" />
        <Fact v-if="placement.pool" label="Pool" :value="placement.pool" />
        <Fact v-if="internalIp" label="Internal IP" mono :value="internalIp" />
        <Fact v-if="externalIp" label="External IP" mono :value="externalIp" />
      </FactList>
  </PanelSection>

  <PanelSection value="capacity" title="Requested" :icon="Cpu">
    <div class="space-y-3.5">
      <CapacityBar
        label="CPU"
        :used="allocation.cpu.requested"
        :total="allocation.cpu.allocatable"
        :used-text="formatCores(allocation.cpu.requested)"
        :total-text="formatCores(allocation.cpu.allocatable)"
      />
      <CapacityBar
        label="Memory"
        :used="allocation.memory.requested"
        :total="allocation.memory.allocatable"
        :used-text="formatBytes(allocation.memory.requested)"
        :total-text="formatBytes(allocation.memory.allocatable)"
      />
      <CapacityBar
        label="Pods"
        :used="allocation.pods.requested"
        :total="allocation.pods.allocatable"
        :used-text="String(allocation.pods.requested)"
        :total-text="String(allocation.pods.allocatable)"
        strict
      />
      <p class="text-xs leading-relaxed text-muted-foreground">
        What the pods here asked for, of what the node offers them. It has
        {{ formatCores(allocation.cpu.capacity) }} and {{ formatBytes(allocation.memory.capacity) }} in
        total; the rest is kept for the system.
      </p>
    </div>
  </PanelSection>

  <PanelSection value="taints" title="Taints" :icon="ShieldAlert" :count="resource.spec?.taints?.length ?? 0">
    <template v-if="!editingTaints" #actions>
      <Button variant="ghost" size="xs" class="h-6 text-muted-foreground" aria-label="Edit taints" @click="editTaints">
        <Pencil class="h-3 w-3" /> Edit
      </Button>
    </template>
    <Taints v-model:editing="editingTaints" :node="resource" :target="target" />
  </PanelSection>

  <PanelSection
    value="node-pods"
    title="Pods"
    :icon="Box"
    :count="pods.length"
    :hint="troubled ? `${troubled} need attention` : undefined"
  >
    <PodList v-if="pods.length" :pods="pods" :now="now" :limit="8" :detail="(pod) => pod.metadata?.namespace" />
    <p v-else class="text-xs text-muted-foreground">No pods run here.</p>
  </PanelSection>

  <PanelSection value="system" title="System" :icon="SlidersHorizontal" :hint="systemHint">
    <FactList>
      <Fact label="OS" :value="info.osImage" />
      <Fact label="Platform" :value="[info.operatingSystem, info.architecture].filter(Boolean).join(' / ') || null" />
      <Fact v-if="info.kernelVersion" label="Kernel" mono :value="info.kernelVersion" />
      <Fact label="Runtime" mono :value="info.containerRuntimeVersion" />
      <Fact label="Kubelet" mono :value="info.kubeletVersion" />
      <Fact v-if="resource.spec?.providerID" label="Provider ID" mono :value="resource.spec.providerID" />
      <Fact v-if="resource.spec?.podCIDR" label="Pod CIDR" mono :value="resource.spec.podCIDR" />
    </FactList>
  </PanelSection>
</template>

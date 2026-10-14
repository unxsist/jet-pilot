<script setup lang="ts">
/**
 * A pod: where it runs and who owns it, what it uses (config, secrets,
 * claims, each a link), and, folded, where it may be scheduled and how it
 * is probed, in sentences.
 */
import { Compass, FileCog, HeartPulse, Info } from "lucide-vue-next";
import KindIcon from "@/components/KindIcon.vue";
import PanelSection from "@/components/generic/PanelSection.vue";
import FactList from "@/components/generic/FactList.vue";
import Fact from "@/components/generic/Fact.vue";
import ObjectLink from "@/components/generic/ObjectLink.vue";
import OwnerChain from "@/components/generic/OwnerChain.vue";
import ContainersSection from "@/components/generic/ContainersSection.vue";
import { usePanelTarget } from "@/composables/usePanelObject";
import { formatResourceKind } from "@/lib/utils";
import { plural } from "@/lib/resources/format";
import { QOS_WORDS, containerProbes, podUses, schedulingWords } from "@/lib/resources/pod";

const props = defineProps<{ resource: any }>();
const target = usePanelTarget(() => props.resource);

const spec = computed(() => props.resource.spec ?? {});
const status = computed(() => props.resource.status ?? {});
const namespace = computed(() => props.resource.metadata?.namespace);

const ips = computed(() => {
  const list: string[] = (status.value.podIPs ?? []).map((ip: any) => ip.ip).filter(Boolean);
  return list.length ? list : status.value.podIP ? [status.value.podIP] : [];
});

const uses = computed(() => podUses(props.resource));
const scheduling = computed(() => schedulingWords(spec.value));
const schedulingHint = computed(() => {
  const { rules, tolerations } = scheduling.value;
  if (!rules.length && !tolerations.length) return "Any node";
  return [rules.length && plural(rules.length, "rule"), tolerations.length && plural(tolerations.length, "toleration")]
    .filter(Boolean)
    .join(" · ");
});

const probes = computed(() =>
  (spec.value.containers ?? [])
    .map((container: any) => ({ name: container.name, probes: containerProbes(container) }))
    .filter((entry: { probes: unknown[] }) => entry.probes.length)
);
const probeCount = computed(() => probes.value.reduce((sum: number, entry: any) => sum + entry.probes.length, 0));
const manyContainers = computed(() => (spec.value.containers?.length ?? 0) > 1);
</script>

<template>
  <PanelSection value="overview" title="Overview" :icon="Info">
    <FactList>
      <Fact label="Node">
        <ObjectLink
          v-if="spec.nodeName"
          :object-ref="{ kind: 'Node', name: spec.nodeName }"
          :target="target"
          icon
        />
        <span v-else class="text-muted-foreground">Not scheduled yet</span>
      </Fact>
      <Fact v-if="ips.length" label="IP" mono>{{ ips.join(", ") }}</Fact>
      <Fact label="Controlled by">
        <OwnerChain :object="resource" :target="target" />
      </Fact>
      <Fact v-if="spec.serviceAccountName" label="Service account">
        <ObjectLink
          :object-ref="{ kind: 'ServiceAccount', name: spec.serviceAccountName, namespace }"
          :target="target"
        />
      </Fact>
      <Fact v-if="status.qosClass" label="QoS class">
        {{ status.qosClass === "BestEffort" ? "Best effort" : status.qosClass }}
        <span class="block text-xs text-muted-foreground">{{ QOS_WORDS[status.qosClass] }}</span>
      </Fact>
    </FactList>
  </PanelSection>

  <ContainersSection :object="resource" />

  <PanelSection v-if="uses.length" value="uses" title="Config & storage" :icon="FileCog" :count="uses.length">
    <ul class="space-y-2.5">
      <li v-for="use in uses" :key="`${use.kind}/${use.title}`" class="flex min-w-0 gap-2.5">
        <KindIcon
          :name="use.ref ? formatResourceKind(use.kind).toLowerCase() : 'persistentvolumes'"
          class="mt-0.5 h-3.5 w-3.5 text-muted-foreground"
        />
        <div class="min-w-0 flex-1">
          <div class="flex min-w-0 items-baseline gap-1.5 text-sm">
            <ObjectLink v-if="use.ref" :object-ref="use.ref" :target="target" />
            <span v-else class="truncate">{{ use.title }}</span>
            <span v-if="use.ref" class="shrink-0 text-xs text-muted-foreground">{{
              use.kind === "PersistentVolumeClaim" ? "Claim" : use.kind
            }}</span>
            <span v-if="use.optional" class="shrink-0 text-xs text-muted-foreground">· optional</span>
          </div>
          <p v-for="how in use.how" :key="how" class="truncate text-xs text-muted-foreground" :title="how">{{ how }}</p>
        </div>
      </li>
    </ul>
  </PanelSection>

  <PanelSection value="scheduling" title="Scheduling" :icon="Compass" :hint="schedulingHint">
    <div class="space-y-3 text-sm">
      <p v-if="!scheduling.rules.length && !scheduling.tolerations.length" class="text-muted-foreground">
        No constraints: it can run on any node with room for it.
      </p>
      <ul v-if="scheduling.rules.length" class="space-y-1.5">
        <li v-for="rule in scheduling.rules" :key="rule" class="select-text">{{ rule }}</li>
      </ul>
      <div v-if="scheduling.tolerations.length">
        <div class="mb-1 text-xs text-muted-foreground">Tolerations</div>
        <ul class="space-y-1">
          <li v-for="toleration in scheduling.tolerations" :key="toleration" class="break-words select-text">
            {{ toleration }}
          </li>
        </ul>
      </div>
    </div>
  </PanelSection>

  <PanelSection v-if="probeCount" value="probes" title="Probes" :icon="HeartPulse" :hint="plural(probeCount, 'probe')">
    <div class="space-y-3">
      <div v-for="entry in probes" :key="entry.name">
        <div v-if="manyContainers" class="mb-1.5 text-xs font-medium text-foreground/80">{{ entry.name }}</div>
        <FactList>
          <Fact v-for="probe in entry.probes" :key="probe.type" :label="probe.type">
            {{ probe.check }}
            <span class="block text-xs text-muted-foreground">{{ probe.timing }}</span>
          </Fact>
        </FactList>
      </div>
    </div>
  </PanelSection>
</template>

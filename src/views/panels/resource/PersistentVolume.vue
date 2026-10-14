<script setup lang="ts">
/** A persistent volume, briefly: size, claim, class, what happens to it later and where it lives. */
import { Info } from "lucide-vue-next";
import PanelSection from "@/components/generic/PanelSection.vue";
import FactList from "@/components/generic/FactList.vue";
import Fact from "@/components/generic/Fact.vue";
import ObjectLink from "@/components/generic/ObjectLink.vue";
import { usePanelTarget } from "@/composables/usePanelObject";
import { parseMemory } from "@/components/tables/metrics";
import { formatBytes } from "@/lib/metrics/units";
import { schedulingWords } from "@/lib/resources/pod";
import { RECLAIM_WORDS, accessModeWords, volumeSource } from "@/lib/resources/storage";

const props = defineProps<{ resource: any }>();
const target = usePanelTarget(() => props.resource);

const spec = computed(() => props.resource.spec ?? {});
const source = computed(() => volumeSource(props.resource));
const claim = computed(() => spec.value.claimRef);
const reclaim = computed(() => spec.value.persistentVolumeReclaimPolicy ?? "Retain");
/* Node affinity of a zonal / local volume, in the words used for pods. */
const placement = computed(() =>
  schedulingWords({ affinity: { nodeAffinity: spec.value.nodeAffinity?.required ? { requiredDuringSchedulingIgnoredDuringExecution: spec.value.nodeAffinity.required } : undefined } }).rules[0]
);
</script>

<template>
  <PanelSection value="overview" title="Overview" :icon="Info">
    <FactList>
      <Fact label="Size" :value="spec.capacity?.storage ? formatBytes(parseMemory(spec.capacity.storage)) : null" />
      <Fact label="Claim">
        <ObjectLink
          v-if="claim?.name"
          :object-ref="{ kind: 'PersistentVolumeClaim', name: claim.name, namespace: claim.namespace }"
          :target="target"
          icon
          :label="`${claim.namespace}/${claim.name}`"
        />
        <span v-else class="text-muted-foreground">Not claimed</span>
      </Fact>
      <Fact label="Storage class">
        <ObjectLink
          v-if="spec.storageClassName"
          :object-ref="{ kind: 'StorageClass', name: spec.storageClassName }"
          :target="target"
        />
        <span v-else class="text-muted-foreground">None</span>
      </Fact>
      <Fact label="Access" :value="accessModeWords(spec.accessModes)" />
      <Fact label="Afterwards">
        {{ RECLAIM_WORDS[reclaim] ?? reclaim }}
        <span class="text-xs text-muted-foreground"> · {{ reclaim }}</span>
      </Fact>
      <Fact label="Stored in">
        {{ source.kind }}
        <span v-if="source.detail" class="block truncate font-mono text-xs text-muted-foreground" :title="source.detail">{{
          source.detail
        }}</span>
      </Fact>
      <Fact v-if="placement" label="Reachable" :value="placement.replace('Only on nodes where', 'From nodes where')" />
    </FactList>
  </PanelSection>
</template>

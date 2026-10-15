<script setup lang="ts">
/** A storage class, briefly: who provisions, whether it is the default, when volumes appear and what happens to them. */
import { Info, SlidersHorizontal } from "lucide-vue-next";
import PanelSection from "@/components/generic/PanelSection.vue";
import FactList from "@/components/generic/FactList.vue";
import Fact from "@/components/generic/Fact.vue";
import { BINDING_WORDS, RECLAIM_WORDS, isDefaultClass } from "@/lib/resources/storage";

const props = defineProps<{ resource: any }>();

const reclaim = computed(() => props.resource.reclaimPolicy ?? "Delete");
const binding = computed(() => props.resource.volumeBindingMode ?? "Immediate");
const parameters = computed(() => Object.entries(props.resource.parameters ?? {}));
</script>

<template>
  <PanelSection value="overview" title="Overview" :icon="Info">
    <FactList>
      <Fact label="Provisioner" mono :value="resource.provisioner" />
      <Fact label="Default">
        <span v-if="isDefaultClass(resource)">Yes: claims without a class get this one</span>
        <span v-else class="text-muted-foreground">No</span>
      </Fact>
      <Fact label="Volumes">
        {{ BINDING_WORDS[binding] ?? binding }}
      </Fact>
      <Fact label="Afterwards">
        {{ RECLAIM_WORDS[reclaim] ?? reclaim }}
      </Fact>
      <Fact label="Resizing" :value="resource.allowVolumeExpansion ? 'Claims can grow' : 'Not allowed'" :muted="!resource.allowVolumeExpansion" />
    </FactList>
  </PanelSection>

  <PanelSection v-if="parameters.length" value="parameters" title="Parameters" :icon="SlidersHorizontal" :count="parameters.length">
    <FactList>
      <Fact v-for="[key, value] in parameters" :key="key" :label="key" mono :value="String(value)" />
    </FactList>
  </PanelSection>
</template>

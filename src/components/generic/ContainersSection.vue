<script setup lang="ts">
/** The Containers section of a pod or of a workload's pod template. */
import { Boxes } from "lucide-vue-next";
import PanelSection from "@/components/generic/PanelSection.vue";
import Containers from "@/components/generic/Containers.vue";

const props = defineProps<{ object: any }>();

const podSpec = computed(() => props.object.spec?.template?.spec ?? props.object.spec);
const containers = computed(() => (Array.isArray(podSpec.value?.containers) ? podSpec.value.containers : []));
</script>

<template>
  <PanelSection
    v-if="containers.length > 0"
    value="containers"
    title="Containers"
    :icon="Boxes"
    :count="containers.length + (podSpec?.initContainers?.length ?? 0)"
  >
    <Containers
      :containers="containers"
      :statuses="object.status?.containerStatuses"
      :init-containers="podSpec?.initContainers"
      :init-statuses="object.status?.initContainerStatuses"
    />
  </PanelSection>
</template>

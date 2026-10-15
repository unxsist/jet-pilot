<script setup lang="ts">
/** The Pods section of a workload: the pods its selector matches, problems first. */
import { Box } from "lucide-vue-next";
import PanelSection from "@/components/generic/PanelSection.vue";
import PodList from "@/components/generic/PodList.vue";
import { useNow, usePanelTarget, useRelatedList } from "@/composables/usePanelObject";
import { labelSelectorMatches } from "@/lib/clusterGraph";
import { podState } from "@/lib/resources/pod";

const props = defineProps<{ workload: any }>();
const target = usePanelTarget(() => props.workload);
const now = useNow();

const { items, loading } = useRelatedList(
  () => "Pod",
  () => target.value,
  () => (props.workload.metadata?.namespace ? [props.workload.metadata.namespace] : null)
);
const pods = computed(() =>
  items.value.filter((pod: any) => labelSelectorMatches(props.workload.spec?.selector, pod.metadata?.labels))
);
const troubled = computed(
  () => pods.value.filter((pod: any) => ["destructive", "warning"].includes(podState(pod, now.value).tone)).length
);
</script>

<template>
  <PanelSection
    value="pods"
    title="Pods"
    :icon="Box"
    :count="pods.length"
    :hint="troubled ? `${troubled} need attention` : undefined"
  >
    <PodList v-if="pods.length" :pods="pods" :now="now" :detail="(pod) => pod.spec?.nodeName?.split('.')[0]" />
    <p v-else-if="!loading" class="text-xs text-muted-foreground">No pods right now.</p>
  </PanelSection>
</template>

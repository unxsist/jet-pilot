<script setup lang="ts">
/**
 * A job: how far it got (completions, failures, duration), what started
 * it (a CronJob, linked) and its pods.
 */
import { Box, Info } from "lucide-vue-next";
import PanelSection from "@/components/generic/PanelSection.vue";
import FactList from "@/components/generic/FactList.vue";
import Fact from "@/components/generic/Fact.vue";
import OwnerChain from "@/components/generic/OwnerChain.vue";
import PodList from "@/components/generic/PodList.vue";
import { useNow, usePanelTarget, useRelatedList } from "@/composables/usePanelObject";
import { formatDateTime } from "@/lib/utils";
import { ago, between, durationWords, plural, toMs } from "@/lib/resources/format";

const props = defineProps<{ resource: any }>();
const target = usePanelTarget(() => props.resource);
const now = useNow();

const spec = computed(() => props.resource.spec ?? {});
const status = computed(() => props.resource.status ?? {});
const completions = computed(() => spec.value.completions ?? 1);

const duration = computed(() => {
  if (!status.value.startTime) return null;
  if (status.value.completionTime) return between(status.value.startTime, status.value.completionTime);
  const failed = (status.value.conditions ?? []).find((c: any) => c.type === "Failed" && c.status === "True");
  if (failed) return between(status.value.startTime, failed.lastTransitionTime);
  return `${durationWords(now.value - (toMs(status.value.startTime) ?? now.value))} so far`;
});

const { items: pods } = useRelatedList(
  () => "Pod",
  () => target.value,
  () => (props.resource.metadata?.namespace ? [props.resource.metadata.namespace] : null)
);
const own = computed(() =>
  pods.value.filter(
    (pod: any) =>
      (pod.metadata?.ownerReferences ?? []).some((o: any) => o.uid === props.resource.metadata?.uid) ||
      pod.metadata?.labels?.["batch.kubernetes.io/job-name"] === props.resource.metadata?.name
  )
);
</script>

<template>
  <PanelSection value="overview" title="Overview" :icon="Info">
    <FactList>
      <Fact label="Completed">
        {{ status.succeeded ?? 0 }} of {{ completions }}
        <span v-if="spec.parallelism && spec.parallelism > 1" class="text-xs text-muted-foreground">
          · {{ spec.parallelism }} at a time</span
        >
      </Fact>
      <Fact v-if="status.failed" label="Failed">
        <span class="text-destructive">{{ plural(status.failed, "time") }}</span>
        <span class="text-xs text-muted-foreground"> · gives up after {{ plural((spec.backoffLimit ?? 6) + 1, "failure") }}</span>
      </Fact>
      <Fact v-if="status.active" label="Running" :value="plural(status.active, 'pod')" />
      <Fact v-if="duration" label="Duration" :value="duration" />
      <Fact v-if="status.startTime" label="Started" :title="formatDateTime(new Date(status.startTime))" :value="ago(status.startTime, now)" />
      <Fact v-if="resource.metadata?.ownerReferences?.length" label="Started by">
        <OwnerChain :object="resource" :target="target" />
      </Fact>
      <Fact
        v-if="spec.ttlSecondsAfterFinished !== undefined"
        label="Clean-up"
        :value="`Deleted ${durationWords(spec.ttlSecondsAfterFinished * 1000)} after it finishes`"
      />
    </FactList>
  </PanelSection>

  <PanelSection value="pods" title="Pods" :icon="Box" :count="own.length">
    <PodList v-if="own.length" :pods="own" :now="now" :detail="(pod) => ago(pod.metadata?.creationTimestamp, now)" />
    <p v-else class="text-xs text-muted-foreground">Its pods are gone (cleaned up after it finished).</p>
  </PanelSection>
</template>

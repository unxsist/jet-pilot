<script setup lang="ts">
/** Side panel of a KEDA ScaledObject / ScaledJob: state, range, triggers. */
import { Loader2, Pause, Play, Scaling, Zap } from "lucide-vue-next";
import PanelSection from "@/components/generic/PanelSection.vue";
import { Button } from "@/components/ui/button";
import StatusHeader from "./StatusHeader.vue";
import Fields from "./Fields.vue";
import Field from "./Field.vue";
import ObjectLink from "./ObjectLink.vue";
import ReplicaRange from "./ReplicaRange.vue";
import TriggerList from "./TriggerList.vue";
import { injectStrict } from "@/lib/utils";
import { DialogProviderSpawnDialogKey } from "@/providers/DialogProvider";
import { guardedCluster } from "@/lib/guardrails/backstop";
import { readOnlyReason } from "@/lib/guardrails/policy";
import { everyInWords, groupOf, spanInWords } from "@/lib/operators/format";
import { isPaused, replicaRange, scaledObjectState, scaleTarget } from "@/lib/operators/keda";
import { setAutoscalingPaused } from "@/lib/operators/actions";
import { fetchObject, targetOf, useLiveObject } from "@/lib/operators/panel";

const props = defineProps<{ resource: any }>();
const spawnDialog = injectStrict(DialogProviderSpawnDialogKey);
const { object, settle } = useLiveObject(() => props.resource);

const isKeda = computed(() => groupOf(object.value?.apiVersion) === "keda.sh");
const job = computed(() => object.value?.kind === "ScaledJob");
const target = computed(() => targetOf(object.value));
const workload = computed(() => scaleTarget(object.value));
const range = computed(() => replicaRange(object.value));
const paused = computed(() => isPaused(object.value));

const line = computed(() => {
  if (job.value) return `Runs up to ${range.value.max} jobs at once`;
  const w = workload.value;
  return w
    ? `Scales ${w.kind} ${w.name} between ${range.value.min} and ${range.value.max} replicas`
    : "";
});

/* The scaled workload's replicas right now. */
const current = ref<number | undefined>();
watch(
  [workload, () => object.value?.metadata?.resourceVersion],
  async () => {
    const w = workload.value;
    if (!isKeda.value || job.value || !w) return;
    try {
      const scaled = await fetchObject(target.value, {
        apiVersion: w.apiVersion,
        kind: w.kind,
        name: w.name,
        namespace: object.value.metadata?.namespace,
      });
      current.value = Number(scaled?.status?.replicas ?? scaled?.spec?.replicas ?? 0);
    } catch {
      current.value = undefined;
    }
  },
  { immediate: true }
);

const readOnly = computed(() => {
  const cluster = guardedCluster(target.value.context, target.value.kubeConfig);
  return cluster.readOnly ? readOnlyReason(cluster) : "";
});

const busy = ref(false);
const toggle = async () => {
  busy.value = true;
  try {
    if (await setAutoscalingPaused(object.value, !paused.value, spawnDialog)) settle();
  } finally {
    busy.value = false;
  }
};

const seconds = (value: unknown, fallback: number) => Number(value ?? fallback) * 1000;
const fallback = computed(() => {
  const f = object.value?.spec?.fallback;
  return f ? `${f.replicas} replicas after ${f.failureThreshold} failed checks` : undefined;
});
</script>

<template>
  <template v-if="isKeda">
    <StatusHeader :state="scaledObjectState(object)" :line="line">
      <template #actions>
        <span class="inline-flex" :title="readOnly || undefined">
          <Button size="sm" variant="outline" :disabled="!!readOnly || busy" @click="toggle">
            <Loader2 v-if="busy" class="h-3.5 w-3.5 animate-spin" />
            <Play v-else-if="paused" class="h-3.5 w-3.5" />
            <Pause v-else class="h-3.5 w-3.5" />
            {{ paused ? "Resume autoscaling" : "Pause autoscaling" }}
          </Button>
        </span>
      </template>
    </StatusHeader>

    <PanelSection value="spec" title="Scaling" :icon="Scaling">
      <div class="space-y-4">
        <div v-if="!job" class="space-y-2">
          <p class="text-xs">
            <template v-if="current !== undefined">
              <span class="text-base font-semibold tabular-nums">{{ current }}</span>
              <span class="text-muted-foreground"> replica{{ current === 1 ? "" : "s" }} now</span>
            </template>
            <span v-else class="text-muted-foreground">Current replicas unknown</span>
          </p>
          <ReplicaRange :min="range.min" :max="range.max" :current="current" />
        </div>
        <Fields>
          <Field label="Target" v-if="workload && !job">
            <ObjectLink
              :target="target"
              :object="{ apiVersion: workload.apiVersion, kind: workload.kind, name: workload.name, namespace: object.metadata?.namespace }"
            />
          </Field>
          <Field label="Image" :value="object.spec?.jobTargetRef?.template?.spec?.containers?.[0]?.image" mono />
          <Field label="Checks" :value="everyInWords(seconds(object.spec?.pollingInterval, 30))" />
          <Field
            v-if="!job"
            label="Cool-down"
            :value="`${spanInWords(seconds(object.spec?.cooldownPeriod, 300))} before scaling to zero`"
          />
          <Field label="Idle at" :value="range.idle !== undefined ? `${range.idle} replicas` : undefined" />
          <Field label="Fallback" :value="fallback" />
        </Fields>
      </div>
    </PanelSection>

    <PanelSection value="flow" title="Triggers" :icon="Zap" :count="object.spec?.triggers?.length ?? 0">
      <TriggerList :object="object" />
    </PanelSection>
  </template>
</template>

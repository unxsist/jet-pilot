<script setup lang="ts">
/**
 * An autoscaler: what it scales, where the replicas sit between minimum
 * and maximum, each metric against its target, and whether it can scale,
 * in sentences.
 */
import { Activity, Gauge, Info } from "lucide-vue-next";
import { StatusDot } from "@/components/ui/status";
import PanelSection from "@/components/generic/PanelSection.vue";
import FactList from "@/components/generic/FactList.vue";
import Fact from "@/components/generic/Fact.vue";
import ObjectLink from "@/components/generic/ObjectLink.vue";
import RangeBar from "@/components/generic/RangeBar.vue";
import { usePanelTarget } from "@/composables/usePanelObject";
import { hpaConditionWords, hpaMetrics, type HpaMetric } from "@/lib/resources/autoscaling";

const props = defineProps<{ resource: any }>();
const target = usePanelTarget(() => props.resource);

const spec = computed(() => props.resource.spec ?? {});
const status = computed(() => props.resource.status ?? {});
const scaleTarget = computed(() => spec.value.scaleTargetRef ?? {});
const min = computed(() => spec.value.minReplicas ?? 1);
const metrics = computed(() => hpaMetrics(props.resource));
const conditions = computed(() => hpaConditionWords(props.resource));
const problems = computed(() => conditions.value.filter((c) => !c.ok));

/* The scale leaves room above the target, so the target sits at ~80 %. */
const scale = (metric: HpaMetric) => Math.max(metric.target * 1.25, metric.current ?? 0, 1);
const width = (metric: HpaMetric, value: number) => `${Math.min(100, (value / scale(metric)) * 100)}%`;
const above = (metric: HpaMetric) => (metric.current ?? 0) > metric.target;
</script>

<template>
  <PanelSection value="overview" title="Overview" :icon="Info">
    <div class="space-y-4">
      <FactList>
        <Fact label="Scales">
          <span class="inline-flex min-w-0 items-baseline gap-1.5">
            <span class="text-xs text-muted-foreground">{{ scaleTarget.kind }}</span>
            <ObjectLink
              :object-ref="{
                kind: scaleTarget.kind,
                name: scaleTarget.name,
                namespace: resource.metadata?.namespace,
                apiVersion: scaleTarget.apiVersion,
              }"
              :target="target"
            />
          </span>
        </Fact>
      </FactList>
      <div>
        <div class="flex items-baseline justify-between text-xs">
          <span class="text-muted-foreground">Replicas</span>
          <span v-if="status.desiredReplicas !== undefined && status.desiredReplicas !== status.currentReplicas" class="text-muted-foreground">
            heading to {{ status.desiredReplicas }}
          </span>
        </div>
        <RangeBar
          :min="min"
          :max="spec.maxReplicas ?? min"
          :current="status.currentReplicas ?? 0"
          :desired="status.desiredReplicas"
          unit="replicas"
        />
      </div>
    </div>
  </PanelSection>

  <PanelSection v-if="metrics.length" value="metrics" title="Metrics" :icon="Gauge" :count="metrics.length">
    <ul class="space-y-3.5">
      <li v-for="metric in metrics" :key="metric.label">
        <div class="mb-1.5 flex items-baseline justify-between gap-3 text-xs">
          <span class="truncate text-foreground">{{ metric.label }}</span>
          <span class="shrink-0 tabular-nums text-muted-foreground">
            <span class="text-foreground">{{ metric.currentText }}</span> of {{ metric.targetText }} target
          </span>
        </div>
        <div
          class="relative h-1.5 rounded-full bg-muted"
          role="meter"
          :aria-label="metric.label"
          :aria-valuetext="`${metric.currentText} of ${metric.targetText} target`"
        >
          <div
            v-if="metric.current !== undefined"
            class="h-full rounded-full transition-[width] duration-base ease-out"
            :class="above(metric) ? 'bg-info' : 'bg-primary/70'"
            :style="{ width: width(metric, metric.current) }"
          />
          <div
            class="absolute -inset-y-1 w-0.5 rounded-full bg-foreground/60"
            :style="{ left: width(metric, metric.target) }"
            :title="`Target ${metric.targetText}`"
          />
        </div>
        <p class="mt-1 text-xs text-muted-foreground">
          {{ metric.scope.charAt(0).toUpperCase() + metric.scope.slice(1) }}<template v-if="metric.current === undefined"> · no reading yet</template
          ><template v-else-if="above(metric)"> · above target, so it adds replicas</template>
        </p>
      </li>
    </ul>
  </PanelSection>

  <!-- Folded while all is well (its value isn't opened by default then). -->
  <PanelSection
    v-if="conditions.length"
    :value="problems.length ? 'scaling' : 'scaling-ok'"
    title="Scaling"
    :icon="Activity"
    :hint="problems.length ? problems[0]!.text : 'All OK'"
  >
    <ul class="space-y-2">
      <li v-for="condition in conditions" :key="condition.type" class="flex items-start gap-2.5">
        <StatusDot :tone="condition.ok ? 'success' : 'warning'" class="mt-1.5" />
        <div class="min-w-0">
          <div class="text-sm" :class="condition.ok ? '' : 'text-warning'">{{ condition.text }}</div>
          <p v-if="condition.message && !condition.ok" class="text-xs text-muted-foreground select-text">
            {{ condition.message }}
          </p>
        </div>
      </li>
    </ul>
  </PanelSection>
</template>

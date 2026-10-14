<script setup lang="ts">
import { Gauge, ListChecks, Recycle } from "lucide-vue-next";
import PanelSection from "@/components/generic/PanelSection.vue";
import StatusHeader from "@/components/operators/StatusHeader.vue";
import Fields from "@/components/operators/Fields.vue";
import Field from "@/components/operators/Field.vue";
import ObjectLink from "@/components/operators/ObjectLink.vue";
import UsageBar from "@/components/operators/UsageBar.vue";
import { groupOf } from "@/lib/operators/format";
import {
  disruptionInWords,
  nodePoolNodes,
  nodePoolState,
  nodePoolUsage,
  requirementsInWords,
} from "@/lib/operators/karpenter";
import { targetOf } from "@/lib/operators/panel";

/* Karpenter NodePools. */
const props = defineProps<{ resource: any }>();

const isKarpenter = computed(() => groupOf(props.resource?.apiVersion) === "karpenter.sh");
const usage = computed(() => nodePoolUsage(props.resource));
const disruption = computed(() => disruptionInWords(props.resource));
const requirements = computed(() => requirementsInWords(props.resource));

const line = computed(() => {
  const nodes = nodePoolNodes(props.resource);
  const weight = props.resource?.spec?.weight;
  return [
    nodes !== undefined && `${nodes} node${nodes === 1 ? "" : "s"}`,
    weight !== undefined && `weight ${weight}`,
  ]
    .filter(Boolean)
    .join(" · ");
});

const nodeClass = computed(() => {
  const classRef = props.resource?.spec?.template?.spec?.nodeClassRef;
  if (!classRef?.name) return null;
  const group = classRef.group ?? (classRef.apiVersion ? groupOf(classRef.apiVersion) : "karpenter.k8s.aws");
  return { apiVersion: `${group}/v1`, kind: classRef.kind ?? "EC2NodeClass", name: classRef.name };
});
</script>

<template>
  <template v-if="isKarpenter">
    <StatusHeader :state="nodePoolState(resource)" :line="line" />

    <PanelSection value="spec" title="Capacity" :icon="Gauge">
      <div class="space-y-3">
        <UsageBar
          v-for="item in usage"
          :key="item.resource"
          :label="item.label"
          :text="item.text"
          :percent="item.percent"
        />
        <p v-if="!resource.spec?.limits" class="text-xs text-muted-foreground">
          No limits: Karpenter adds nodes as long as pods need them.
        </p>
      </div>
    </PanelSection>

    <PanelSection value="flow" title="Disruption" :icon="Recycle">
      <ul class="space-y-1.5 text-xs">
        <li>{{ disruption.policy }}</li>
        <li v-if="disruption.expiry">{{ disruption.expiry }}</li>
        <li v-for="budget in disruption.budgets" :key="budget" class="text-muted-foreground">{{ budget }}</li>
      </ul>
    </PanelSection>

    <PanelSection value="requirements" title="Nodes" :icon="ListChecks">
      <Fields>
        <Field label="Node class" v-if="nodeClass">
          <ObjectLink :target="targetOf(resource)" :object="nodeClass" />
        </Field>
        <Field
          v-for="requirement in requirements"
          :key="requirement.label"
          :label="requirement.label"
          :value="requirement.value"
        />
      </Fields>
    </PanelSection>
  </template>
</template>

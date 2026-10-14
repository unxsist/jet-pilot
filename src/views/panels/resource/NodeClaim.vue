<script setup lang="ts">
import { Cpu } from "lucide-vue-next";
import PanelSection from "@/components/generic/PanelSection.vue";
import StatusHeader from "@/components/operators/StatusHeader.vue";
import Fields from "@/components/operators/Fields.vue";
import Field from "@/components/operators/Field.vue";
import ObjectLink from "@/components/operators/ObjectLink.vue";
import { groupOf } from "@/lib/operators/format";
import {
  capacityType,
  claimCapacity,
  instanceType,
  nodeClaimState,
  nodePoolOf,
  zoneOf,
} from "@/lib/operators/karpenter";
import { targetOf } from "@/lib/operators/panel";

/* Karpenter NodeClaims: the machine behind a node. */
const props = defineProps<{ resource: any }>();

const isKarpenter = computed(() => groupOf(props.resource?.apiVersion) === "karpenter.sh");
const target = computed(() => targetOf(props.resource));
const line = computed(() =>
  [instanceType(props.resource), capacityType(props.resource), zoneOf(props.resource)]
    .filter(Boolean)
    .join(" · ")
);
const pool = computed(() => nodePoolOf(props.resource));
</script>

<template>
  <template v-if="isKarpenter">
    <StatusHeader :state="nodeClaimState(resource)" :line="line" />

    <PanelSection value="spec" title="Machine" :icon="Cpu">
      <Fields>
        <Field label="Node" v-if="resource.status?.nodeName">
          <ObjectLink :target="target" :object="{ apiVersion: 'v1', kind: 'Node', name: resource.status.nodeName }" />
        </Field>
        <Field label="Node pool" v-if="pool">
          <ObjectLink :target="target" :object="{ apiVersion: resource.apiVersion, kind: 'NodePool', name: pool }" />
        </Field>
        <Field label="Instance type" :value="instanceType(resource)" />
        <Field label="Capacity" :value="capacityType(resource)" />
        <Field label="Zone" :value="zoneOf(resource)" />
        <Field label="Resources" :value="claimCapacity(resource)" />
        <Field label="Image" :value="resource.status?.imageID" mono />
        <Field label="Provider ID" :value="resource.status?.providerID" mono />
      </Fields>
    </PanelSection>
  </template>
</template>

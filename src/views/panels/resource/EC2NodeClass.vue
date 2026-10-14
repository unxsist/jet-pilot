<script setup lang="ts">
import { CloudCog } from "lucide-vue-next";
import PanelSection from "@/components/generic/PanelSection.vue";
import StatusHeader from "@/components/operators/StatusHeader.vue";
import Fields from "@/components/operators/Fields.vue";
import Field from "@/components/operators/Field.vue";
import { readyState } from "@/lib/operators/format";
import { amiInWords, nodeClassRole } from "@/lib/operators/karpenter";

/* Karpenter EC2NodeClasses, briefly: AMI, role, network. */
const props = defineProps<{ resource: any }>();

const ids = (list: any[] | undefined) => (list ?? []).map((item) => item?.id).filter(Boolean);
const subnets = computed(() => ids(props.resource?.status?.subnets));
const securityGroups = computed(() => ids(props.resource?.status?.securityGroups));
</script>

<template>
  <StatusHeader :state="readyState(resource)" :line="amiInWords(resource)" />
  <PanelSection value="spec" title="Node class" :icon="CloudCog">
    <Fields>
      <Field label="AMI" :value="amiInWords(resource)" />
      <Field label="Role" :value="nodeClassRole(resource)" mono />
      <Field label="Subnets" :value="subnets.join(', ')" mono />
      <Field label="Security groups" :value="securityGroups.join(', ')" mono />
    </Fields>
  </PanelSection>
</template>

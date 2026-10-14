<script setup lang="ts">
import { ReceiptText } from "lucide-vue-next";
import PanelSection from "@/components/generic/PanelSection.vue";
import StatusHeader from "@/components/operators/StatusHeader.vue";
import Fields from "@/components/operators/Fields.vue";
import Field from "@/components/operators/Field.vue";
import ObjectLink from "@/components/operators/ObjectLink.vue";
import { groupOf } from "@/lib/operators/format";
import { orderState } from "@/lib/operators/certManager";
import { targetOf } from "@/lib/operators/panel";

/* cert-manager ACME Orders. */
const props = defineProps<{ resource: any }>();

const isAcme = computed(() => groupOf(props.resource?.apiVersion) === "acme.cert-manager.io");
const request = computed(() => {
  const owner = (props.resource?.metadata?.ownerReferences ?? []).find(
    (o: any) => o.kind === "CertificateRequest"
  );
  return owner
    ? { apiVersion: owner.apiVersion, kind: owner.kind, name: owner.name, namespace: props.resource.metadata?.namespace }
    : null;
});
</script>

<template>
  <template v-if="isAcme">
    <StatusHeader :state="orderState(resource)" :line="(resource.spec?.dnsNames ?? []).join(', ')" />
    <PanelSection value="spec" title="Order" :icon="ReceiptText">
      <Fields>
        <Field label="Domains" v-if="resource.spec?.dnsNames?.length">
          <ul class="space-y-0.5">
            <li v-for="name in resource.spec.dnsNames" :key="name">{{ name }}</li>
          </ul>
        </Field>
        <Field label="Request" v-if="request">
          <ObjectLink :target="targetOf(resource)" :object="request" />
        </Field>
        <Field label="Order URL" :value="resource.status?.url" mono />
      </Fields>
    </PanelSection>
  </template>
</template>

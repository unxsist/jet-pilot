<script setup lang="ts">
import { BadgeCheck } from "lucide-vue-next";
import PanelSection from "@/components/generic/PanelSection.vue";
import StatusHeader from "@/components/operators/StatusHeader.vue";
import Fields from "@/components/operators/Fields.vue";
import Field from "@/components/operators/Field.vue";
import ObjectLink from "@/components/operators/ObjectLink.vue";
import { groupOf } from "@/lib/operators/format";
import { certificateRequestState, issuerRefInWords } from "@/lib/operators/certManager";
import { targetOf } from "@/lib/operators/panel";

/* cert-manager CertificateRequests. */
const props = defineProps<{ resource: any }>();

const isCertManager = computed(() => groupOf(props.resource?.apiVersion) === "cert-manager.io");
const certificate = computed(() => {
  const name = props.resource?.metadata?.annotations?.["cert-manager.io/certificate-name"];
  return name
    ? { apiVersion: "cert-manager.io/v1", kind: "Certificate", name, namespace: props.resource.metadata?.namespace }
    : null;
});
</script>

<template>
  <template v-if="isCertManager">
    <StatusHeader :state="certificateRequestState(resource)" :line="issuerRefInWords(resource.spec?.issuerRef)" />
    <PanelSection value="spec" title="Request" :icon="BadgeCheck">
      <Fields>
        <Field label="Certificate" v-if="certificate">
          <ObjectLink :target="targetOf(resource)" :object="certificate" />
        </Field>
        <Field label="Issuer" :value="issuerRefInWords(resource.spec?.issuerRef)" />
        <Field label="Requested by" :value="resource.spec?.username" />
      </Fields>
    </PanelSection>
  </template>
</template>

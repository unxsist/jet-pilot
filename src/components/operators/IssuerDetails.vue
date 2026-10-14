<script setup lang="ts">
/** Side panel of a cert-manager Issuer / ClusterIssuer. */
import { Stamp } from "lucide-vue-next";
import PanelSection from "@/components/generic/PanelSection.vue";
import StatusHeader from "./StatusHeader.vue";
import Fields from "./Fields.vue";
import Field from "./Field.vue";
import ObjectLink from "./ObjectLink.vue";
import { groupOf, readyState } from "@/lib/operators/format";
import { issuerType, solverInWords } from "@/lib/operators/certManager";
import { targetOf } from "@/lib/operators/panel";

const props = defineProps<{ resource: any }>();

const isCertManager = computed(() => groupOf(props.resource?.apiVersion) === "cert-manager.io");
const type = computed(() => issuerType(props.resource));
const line = computed(() => [type.value.type, type.value.detail].filter(Boolean).join(" · "));
const solvers = computed<string[]>(() =>
  (props.resource?.spec?.acme?.solvers ?? []).map(solverInWords)
);
/* A ClusterIssuer's CA secret lives in cert-manager's namespace. */
const caSecret = computed(() => {
  const name = props.resource?.spec?.ca?.secretName;
  const namespace = props.resource?.metadata?.namespace;
  return name && namespace ? { apiVersion: "v1", kind: "Secret", name, namespace } : null;
});
</script>

<template>
  <template v-if="isCertManager">
    <StatusHeader :state="readyState(resource)" :line="line" />
    <PanelSection value="spec" title="Issuer" :icon="Stamp">
      <Fields>
        <Field label="Type" :value="type.type" />
        <Field label="Server" :value="type.server" mono />
        <Field label="E-mail" :value="type.email" />
        <Field label="Solvers" v-if="solvers.length">
          <ul class="space-y-0.5">
            <li v-for="solver in solvers" :key="solver">{{ solver }}</li>
          </ul>
        </Field>
        <Field label="CA secret" v-if="resource.spec?.ca?.secretName">
          <ObjectLink v-if="caSecret" :target="targetOf(resource)" :object="caSecret" />
          <template v-else>{{ resource.spec.ca.secretName }}</template>
        </Field>
        <Field label="Vault path" :value="resource.spec?.vault?.path" mono />
      </Fields>
    </PanelSection>
  </template>
</template>

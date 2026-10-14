<script setup lang="ts">
/** Side panel of an External Secrets SecretStore / ClusterSecretStore. */
import { Vault } from "lucide-vue-next";
import PanelSection from "@/components/generic/PanelSection.vue";
import StatusHeader from "./StatusHeader.vue";
import Fields from "./Fields.vue";
import Field from "./Field.vue";
import { groupOf } from "@/lib/operators/format";
import { storeAuthInWords, storeProvider, storeState } from "@/lib/operators/externalSecrets";

const props = defineProps<{ resource: any }>();

const isEso = computed(() => groupOf(props.resource?.apiVersion) === "external-secrets.io");
const provider = computed(() => storeProvider(props.resource));
const line = computed(() => [provider.value?.name, provider.value?.detail].filter(Boolean).join(" · "));
const access = computed(() => {
  const capabilities = props.resource?.status?.capabilities;
  return capabilities === "ReadWrite" ? "Read and write" : capabilities === "ReadOnly" ? "Read only" : undefined;
});
</script>

<template>
  <template v-if="isEso">
    <StatusHeader :state="storeState(resource)" :line="line" />
    <PanelSection value="spec" title="Store" :icon="Vault">
      <Fields>
        <Field label="Provider" :value="provider?.name" />
        <Field label="Where" :value="provider?.detail" />
        <Field label="Signs in with" :value="storeAuthInWords(resource)" />
        <Field label="Access" :value="access" />
      </Fields>
    </PanelSection>
  </template>
</template>

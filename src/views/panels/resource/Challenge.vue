<script setup lang="ts">
import { ShieldQuestion } from "lucide-vue-next";
import PanelSection from "@/components/generic/PanelSection.vue";
import StatusHeader from "@/components/operators/StatusHeader.vue";
import Fields from "@/components/operators/Fields.vue";
import Field from "@/components/operators/Field.vue";
import ObjectLink from "@/components/operators/ObjectLink.vue";
import { groupOf } from "@/lib/operators/format";
import {
  challengeHint,
  challengeSolver,
  challengeState,
  challengeType,
} from "@/lib/operators/certManager";
import { targetOf } from "@/lib/operators/panel";

/* cert-manager ACME Challenges: what is wrong, in plain words first. */
const props = defineProps<{ resource: any }>();

const isAcme = computed(() => groupOf(props.resource?.apiVersion) === "acme.cert-manager.io");
const state = computed(() => challengeState(props.resource));
const hint = computed(() => challengeHint(props.resource) ?? undefined);
const line = computed(() =>
  [props.resource?.spec?.dnsName, challengeType(props.resource)].filter(Boolean).join(" · ")
);
const order = computed(() => {
  const owner = (props.resource?.metadata?.ownerReferences ?? []).find((o: any) => o.kind === "Order");
  return owner
    ? { apiVersion: owner.apiVersion, kind: "Order", name: owner.name, namespace: props.resource.metadata?.namespace }
    : null;
});
/* An HTTP-01 challenge is served at this URL. */
const url = computed(() =>
  challengeType(props.resource) === "HTTP-01" && props.resource?.spec?.token
    ? `http://${props.resource.spec.dnsName}/.well-known/acme-challenge/${props.resource.spec.token}`
    : ""
);
</script>

<template>
  <template v-if="isAcme">
    <StatusHeader :state="state" :line="line" :hint="hint" />
    <PanelSection value="spec" title="Challenge" :icon="ShieldQuestion">
      <Fields>
        <Field label="Domain" :value="resource.spec?.dnsName" />
        <Field label="Type" :value="challengeType(resource)" />
        <Field label="Solved by" :value="challengeSolver(resource)" />
        <Field label="Presented" :value="resource.status?.presented ? 'Yes' : 'Not yet'" />
        <Field label="URL" :value="url" mono />
        <Field label="Order" v-if="order">
          <ObjectLink :target="targetOf(resource)" :object="order" />
        </Field>
      </Fields>
    </PanelSection>
  </template>
</template>

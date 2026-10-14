<script setup lang="ts">
import { BadgeCheck, Loader2, RefreshCw, ShieldQuestion } from "lucide-vue-next";
import PanelSection from "@/components/generic/PanelSection.vue";
import StatusHeader from "@/components/operators/StatusHeader.vue";
import Fields from "@/components/operators/Fields.vue";
import Field from "@/components/operators/Field.vue";
import ObjectLink from "@/components/operators/ObjectLink.vue";
import IssuanceChain from "@/components/operators/IssuanceChain.vue";
import { Button } from "@/components/ui/button";
import { guardedCluster } from "@/lib/guardrails/backstop";
import { readOnlyReason } from "@/lib/guardrails/policy";
import { goDurationInWords, groupOf } from "@/lib/operators/format";
import {
  canRenew,
  certificateExpiry,
  certificateNames,
  certificateState,
  issuerRefInWords,
  renewalInWords,
} from "@/lib/operators/certManager";
import { renewCertificate } from "@/lib/operators/actions";
import { targetOf, useLiveObject } from "@/lib/operators/panel";

/* cert-manager Certificates (other groups' "Certificate" kinds: nothing). */
const props = defineProps<{ resource: any }>();
const { object: cert, settle } = useLiveObject(() => props.resource);

const isCertManager = computed(() => groupOf(cert.value?.apiVersion) === "cert-manager.io");
const now = Date.now();
const state = computed(() => certificateState(cert.value, now));
const expiry = computed(() => certificateExpiry(cert.value, now));
const target = computed(() => targetOf(cert.value));

const line = computed(() =>
  [expiry.value?.label, renewalInWords(cert.value, now)]
    .filter(Boolean)
    .join(" · ")
);

const readOnly = computed(() => {
  const cluster = guardedCluster(target.value.context, target.value.kubeConfig);
  return cluster.readOnly ? readOnlyReason(cluster) : "";
});

const renewing = ref(false);
const renew = async () => {
  renewing.value = true;
  try {
    if (await renewCertificate(cert.value)) settle();
  } finally {
    renewing.value = false;
  }
};

const issuer = computed(() => {
  const issuerRef = cert.value?.spec?.issuerRef;
  if (!issuerRef?.name || (issuerRef.group && issuerRef.group !== "cert-manager.io")) return null;
  const kind = issuerRef.kind ?? "Issuer";
  return {
    apiVersion: "cert-manager.io/v1",
    kind,
    name: issuerRef.name,
    namespace: kind === "Issuer" ? cert.value.metadata?.namespace : undefined,
  };
});

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });
const validity = computed(() => {
  const from = cert.value?.status?.notBefore;
  const until = cert.value?.status?.notAfter;
  if (!from || !until) return "";
  return `${dateFormat.format(new Date(from))} – ${dateFormat.format(new Date(until))}`;
});

const key = computed(() => {
  const privateKey = cert.value?.spec?.privateKey ?? {};
  const algorithm = privateKey.algorithm ?? "RSA";
  const size = privateKey.size ?? (algorithm === "ECDSA" ? 256 : algorithm === "Ed25519" ? undefined : 2048);
  return algorithm === "ECDSA" ? `ECDSA P-${size}` : size ? `${algorithm} ${size}` : algorithm;
});

/* The issuance chain matters while it isn't simply ready. */
const showIssuance = computed(() => state.value.label !== "Ready");
</script>

<template>
  <template v-if="isCertManager">
    <StatusHeader :state="state" :line="line" :line-tone="expiry?.tone">
      <template #actions>
        <span class="inline-flex" :title="readOnly || undefined">
          <Button
            size="sm"
            variant="outline"
            :disabled="!!readOnly || !canRenew(cert) || renewing"
            :title="canRenew(cert) ? 'Issue the certificate again now' : 'An issuance is already running'"
            @click="renew"
          >
            <Loader2 v-if="renewing || state.busy" class="h-3.5 w-3.5 animate-spin" />
            <RefreshCw v-else class="h-3.5 w-3.5" />
            {{ state.busy ? "Issuing…" : "Renew" }}
          </Button>
        </span>
      </template>
    </StatusHeader>

    <PanelSection value="flow" title="Issuance" :icon="ShieldQuestion" v-if="showIssuance">
      <IssuanceChain :certificate="cert" />
    </PanelSection>

    <PanelSection value="spec" title="Certificate" :icon="BadgeCheck">
      <Fields>
        <Field label="Domains" v-if="certificateNames(cert).length">
          <ul class="space-y-0.5">
            <li v-for="name in certificateNames(cert)" :key="name">{{ name }}</li>
          </ul>
        </Field>
        <Field label="Issuer" v-if="cert.spec?.issuerRef?.name">
          <ObjectLink v-if="issuer" :target="target" :object="issuer" :label="issuerRefInWords(cert.spec.issuerRef)" />
          <template v-else>{{ issuerRefInWords(cert.spec.issuerRef) }}</template>
        </Field>
        <Field label="Secret" v-if="cert.spec?.secretName">
          <ObjectLink
            :target="target"
            :object="{ apiVersion: 'v1', kind: 'Secret', name: cert.spec.secretName, namespace: cert.metadata?.namespace }"
          />
        </Field>
        <Field label="Valid" :value="validity" />
        <Field label="Key" :value="key" />
        <Field label="Lifetime" :value="goDurationInWords(cert.spec?.duration)" />
        <Field label="Renews" :value="cert.spec?.renewBefore ? `${goDurationInWords(cert.spec.renewBefore)} before expiry` : undefined" />
      </Fields>
    </PanelSection>
  </template>
</template>

<script setup lang="ts">
/**
 * The latest issuance of a cert-manager Certificate, step by step: the
 * CertificateRequest, the ACME Order and its Challenges, each with its
 * state and, for challenges, the reason in plain words.
 */
import { Skeleton } from "@/components/ui/skeleton";
import { StatusDot, statusTextClass } from "@/components/ui/status";
import ObjectLink from "./ObjectLink.vue";
import { apiPath, kubeGet } from "@/lib/kubeApi";
import { targetOf } from "@/lib/operators/panel";
import type { OperatorState } from "@/lib/operators/format";
import {
  certificateRequestState,
  challengeHint,
  challengeSolver,
  challengeState,
  challengeType,
  issuanceChain,
  orderState,
  type IssuanceChain,
} from "@/lib/operators/certManager";

const props = defineProps<{ certificate: any }>();

const chain = shallowRef<IssuanceChain | null>(null);
const failed = ref("");

const list = async (apiVersion: string, resource: string) => {
  const namespace = props.certificate.metadata?.namespace;
  const response = await kubeGet(targetOf(props.certificate), apiPath({ apiVersion, resource, namespace }));
  return (response?.items ?? []) as any[];
};

const load = async () => {
  try {
    const [requests, orders, challenges] = await Promise.all([
      list("cert-manager.io/v1", "certificaterequests"),
      // Not every issuer is ACME: no orders or challenges then.
      list("acme.cert-manager.io/v1", "orders").catch(() => []),
      list("acme.cert-manager.io/v1", "challenges").catch(() => []),
    ]);
    chain.value = issuanceChain(props.certificate, requests, orders, challenges);
    failed.value = "";
  } catch (error) {
    failed.value = (error as { message?: string })?.message ?? String(error);
  }
};

watch(
  () => props.certificate?.metadata?.resourceVersion,
  () => load(),
  { immediate: true }
);

const target = computed(() => targetOf(props.certificate));
const now = Date.now();

const labelClass = (state: OperatorState) =>
  state.tone === "destructive" || state.tone === "warning"
    ? statusTextClass[state.tone]
    : "text-muted-foreground";

const refOf = (object: any) => ({
  apiVersion: object.apiVersion,
  kind: object.kind,
  name: object.metadata?.name,
  namespace: object.metadata?.namespace,
});
</script>

<template>
  <p v-if="failed" class="text-xs text-muted-foreground">Couldn't load the issuance: {{ failed }}</p>
  <div v-else-if="!chain" class="space-y-2" aria-label="Loading the issuance">
    <Skeleton class="h-4 w-2/3" />
    <Skeleton class="h-4 w-1/2" />
  </div>
  <p v-else-if="!chain.request" class="text-xs text-muted-foreground">
    No certificate request yet: cert-manager starts one when it issues the certificate.
  </p>
  <ol v-else class="relative space-y-3 text-xs">
    <li class="flex items-start gap-2.5">
      <StatusDot :tone="certificateRequestState(chain.request).tone" class="mt-1" />
      <div class="min-w-0 flex-1">
        <div class="flex items-baseline justify-between gap-2">
          <ObjectLink :target="target" :object="refOf(chain.request)" label="Request" />
          <span :class="labelClass(certificateRequestState(chain.request))">{{
            certificateRequestState(chain.request).label
          }}</span>
        </div>
        <p
          v-if="certificateRequestState(chain.request).tone === 'destructive' && !chain.order"
          class="mt-0.5 select-text text-muted-foreground"
        >
          {{ certificateRequestState(chain.request).message }}
        </p>
      </div>
    </li>
    <li v-if="chain.order" class="flex items-start gap-2.5">
      <StatusDot :tone="orderState(chain.order).tone" class="mt-1" />
      <div class="min-w-0 flex-1">
        <div class="flex items-baseline justify-between gap-2">
          <ObjectLink :target="target" :object="refOf(chain.order)" label="ACME order" />
          <span :class="labelClass(orderState(chain.order))">{{ orderState(chain.order).label }}</span>
        </div>
        <p v-if="orderState(chain.order).message" class="mt-0.5 select-text text-muted-foreground">
          {{ orderState(chain.order).message }}
        </p>
      </div>
    </li>
    <li
      v-for="challenge in chain.challenges"
      :key="challenge.metadata?.uid"
      class="flex items-start gap-2.5"
    >
      <StatusDot :tone="challengeState(challenge, now).tone" :pulse="challengeState(challenge, now).busy" class="mt-1" />
      <div class="min-w-0 flex-1">
        <div class="flex items-baseline justify-between gap-2">
          <ObjectLink :target="target" :object="refOf(challenge)" :label="challenge.spec?.dnsName || challenge.metadata?.name" />
          <span :class="labelClass(challengeState(challenge, now))">{{ challengeState(challenge, now).label }}</span>
        </div>
        <p class="text-muted-foreground">
          {{ [challengeType(challenge), challengeSolver(challenge)].filter(Boolean).join(" via ") }}
        </p>
        <p v-if="challengeHint(challenge)" class="mt-1 font-medium text-foreground">
          {{ challengeHint(challenge) }}
        </p>
        <p
          v-if="challenge.status?.reason && challengeState(challenge, now).tone !== 'success'"
          class="mt-0.5 line-clamp-3 select-text break-words text-muted-foreground"
          :title="challenge.status.reason"
        >
          {{ challenge.status.reason }}
        </p>
      </div>
    </li>
  </ol>
</template>

<script setup lang="ts">
import { KeySquare, Loader2, RefreshCw } from "lucide-vue-next";
import PanelSection from "@/components/generic/PanelSection.vue";
import { Button } from "@/components/ui/button";
import StatusHeader from "@/components/operators/StatusHeader.vue";
import Fields from "@/components/operators/Fields.vue";
import Field from "@/components/operators/Field.vue";
import ObjectLink from "@/components/operators/ObjectLink.vue";
import { guardedCluster } from "@/lib/guardrails/backstop";
import { readOnlyReason } from "@/lib/guardrails/policy";
import { groupOf, relativeInWords, toTime } from "@/lib/operators/format";
import {
  externalSecretState,
  refreshInWords,
  storeRef,
  targetSecretName,
} from "@/lib/operators/externalSecrets";
import { syncExternalSecret } from "@/lib/operators/actions";
import { targetOf, useLiveObject } from "@/lib/operators/panel";

/* External Secrets ExternalSecrets. */
const props = defineProps<{ resource: any }>();
const { object: secret, settle } = useLiveObject(() => props.resource);

const isEso = computed(() => groupOf(secret.value?.apiVersion) === "external-secrets.io");
const target = computed(() => targetOf(secret.value));
const store = computed(() => storeRef(secret.value));

const line = computed(() => {
  const synced = toTime(secret.value?.status?.refreshTime);
  return [
    synced !== null ? `Last synced ${relativeInWords(synced, Date.now())}` : "Never synced",
    refreshInWords(secret.value).toLowerCase(),
  ].join(" · ");
});

const storeObject = computed(() =>
  store.value
    ? {
        apiVersion: secret.value.apiVersion,
        kind: store.value.kind,
        name: store.value.name,
        namespace: store.value.kind === "SecretStore" ? secret.value.metadata?.namespace : undefined,
      }
    : null
);

/* What ends up in the Secret: "DB_PASSWORD ← prod/payments/db › password". */
const keys = computed(() => [
  ...(secret.value?.spec?.data ?? []).map((item: any) => ({
    name: item.secretKey,
    from: [item.remoteRef?.key, item.remoteRef?.property].filter(Boolean).join(" › "),
  })),
  ...(secret.value?.spec?.dataFrom ?? []).map((item: any) => ({
    name: "All keys",
    from: item.extract?.key ?? (item.find?.name?.regexp ? `matching ${item.find.name.regexp}` : "found by tags"),
  })),
]);

const readOnly = computed(() => {
  const cluster = guardedCluster(target.value.context, target.value.kubeConfig);
  return cluster.readOnly ? readOnlyReason(cluster) : "";
});

const syncing = ref(false);
const sync = async () => {
  syncing.value = true;
  try {
    if (await syncExternalSecret(secret.value)) settle();
  } finally {
    syncing.value = false;
  }
};
</script>

<template>
  <template v-if="isEso">
    <StatusHeader :state="externalSecretState(secret)" :line="line">
      <template #actions>
        <span class="inline-flex" :title="readOnly || undefined">
          <Button size="sm" variant="outline" :disabled="!!readOnly || syncing" @click="sync">
            <Loader2 v-if="syncing" class="h-3.5 w-3.5 animate-spin" />
            <RefreshCw v-else class="h-3.5 w-3.5" />
            Sync now
          </Button>
        </span>
      </template>
    </StatusHeader>

    <PanelSection value="spec" title="Secret" :icon="KeySquare">
      <Fields>
        <Field label="Store" v-if="storeObject">
          <ObjectLink :target="target" :object="storeObject" :label="`${storeObject.name}${storeObject.kind === 'ClusterSecretStore' ? ' (cluster)' : ''}`" />
        </Field>
        <Field label="Writes to">
          <ObjectLink
            :target="target"
            :object="{ apiVersion: 'v1', kind: 'Secret', name: targetSecretName(secret), namespace: secret.metadata?.namespace }"
          />
        </Field>
        <Field label="Refreshes" :value="refreshInWords(secret)" />
        <Field label="Keys" v-if="keys.length">
          <ul class="space-y-1">
            <li v-for="key in keys" :key="`${key.name}${key.from}`" class="min-w-0">
              <span class="font-medium">{{ key.name }}</span>
              <span class="text-muted-foreground"> from {{ key.from }}</span>
            </li>
          </ul>
        </Field>
      </Fields>
    </PanelSection>
  </template>
</template>

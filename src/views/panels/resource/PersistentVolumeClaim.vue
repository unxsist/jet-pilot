<script setup lang="ts">
/**
 * A claim: what it asked for and what it got, its storage class and
 * volume (links), how it may be mounted, and the pods that use it.
 */
import { Box, Info } from "lucide-vue-next";
import PanelSection from "@/components/generic/PanelSection.vue";
import FactList from "@/components/generic/FactList.vue";
import Fact from "@/components/generic/Fact.vue";
import ObjectLink from "@/components/generic/ObjectLink.vue";
import PodList from "@/components/generic/PodList.vue";
import { useNow, usePanelTarget, useRelatedList } from "@/composables/usePanelObject";
import { parseMemory } from "@/components/tables/metrics";
import { formatBytes } from "@/lib/metrics/units";
import { BINDING_WORDS, accessModeWords, isDefaultClass, podsUsingClaim } from "@/lib/resources/storage";

const props = defineProps<{ resource: any }>();
const target = usePanelTarget(() => props.resource);
const now = useNow();

const spec = computed(() => props.resource.spec ?? {});
const status = computed(() => props.resource.status ?? {});
const namespace = computed(() => props.resource.metadata?.namespace as string);

const requested = computed(() => spec.value.resources?.requests?.storage);
const bound = computed(() => status.value.capacity?.storage);
const size = (value: unknown) => formatBytes(parseMemory(value));
const resizing = computed(
  () => bound.value && requested.value && parseMemory(bound.value) < parseMemory(requested.value)
);

const { items: pods, loading: podsLoading } = useRelatedList(() => "Pod", () => target.value, () => (namespace.value ? [namespace.value] : null));
const users = computed(() => podsUsingClaim(props.resource, pods.value));

/* The class, for a pending claim's explanation. */
const { items: classes } = useRelatedList(
  () => (status.value.phase === "Pending" ? "StorageClass" : null),
  () => target.value,
  () => ["all"]
);
const storageClass = computed(() =>
  classes.value.find((c: any) =>
    spec.value.storageClassName ? c.metadata?.name === spec.value.storageClassName : isDefaultClass(c)
  )
);
/* Why a pending claim has no volume, when the class tells. */
const classMissing = computed(
  () => status.value.phase === "Pending" && classes.value.length > 0 && !storageClass.value
);
const waitsForPod = computed(
  () =>
    status.value.phase === "Pending" &&
    storageClass.value?.volumeBindingMode === "WaitForFirstConsumer" &&
    !users.value.length
);
</script>

<template>
  <PanelSection value="overview" title="Overview" :icon="Info">
      <FactList>
        <Fact label="Size">
          <template v-if="bound">
            {{ size(bound) }}
            <span v-if="resizing" class="text-xs text-warning"> · growing to {{ size(requested) }}</span>
          </template>
          <template v-else-if="requested">
            {{ size(requested) }} <span class="text-xs text-muted-foreground">requested</span>
          </template>
          <template v-else>–</template>
        </Fact>
        <Fact label="Storage class">
          <ObjectLink
            v-if="spec.storageClassName"
            :object-ref="{ kind: 'StorageClass', name: spec.storageClassName }"
            :target="target"
          />
          <span v-else class="text-muted-foreground">{{ spec.storageClassName === "" ? "None (static volumes)" : "The default" }}</span>
          <span v-if="classMissing" class="block text-xs text-warning">{{
            spec.storageClassName ? "Doesn't exist: no volume can be made for it" : "The cluster has no default class"
          }}</span>
        </Fact>
        <Fact label="Access" :value="accessModeWords(spec.accessModes)" />
        <Fact v-if="spec.volumeMode === 'Block'" label="Mode" value="Raw block device" />
        <Fact label="Volume">
          <ObjectLink
            v-if="spec.volumeName"
            :object-ref="{ kind: 'PersistentVolume', name: spec.volumeName }"
            :target="target"
            icon
          />
          <span v-else class="text-muted-foreground">Not bound yet</span>
          <span v-if="waitsForPod" class="block text-xs text-muted-foreground">{{ BINDING_WORDS.WaitForFirstConsumer }}</span>
        </Fact>
      </FactList>
  </PanelSection>

  <PanelSection value="used-by" title="Used by" :icon="Box" :count="users.length">
    <PodList v-if="users.length" :pods="users" :now="now" :detail="(pod) => pod.spec?.nodeName?.split('.')[0]" />
    <p v-else-if="!podsLoading" class="text-xs text-muted-foreground">No pod uses this claim.</p>
  </PanelSection>
</template>

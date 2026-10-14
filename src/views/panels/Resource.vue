<script setup lang="ts">
/**
 * The side panel of any object: its state in a word at the top, usage over
 * time, the kind's own sections (resource/<Kind>.vue: what it is, whether
 * it is OK, what it is connected to), then containers, conditions, labels
 * and annotations (editable in place) and events. The object is live: an
 * edit, a cordon or a rollout shows as it happens.
 *
 * What matters most is open; details (scheduling, probes, system info)
 * stay folded with a hint of what is inside, and conditions and events
 * open by themselves when something is wrong.
 */
import { Accordion } from "@/components/ui/accordion";
import { Skeleton } from "@/components/ui/skeleton";
import PanelSection from "@/components/generic/PanelSection.vue";
import MetadataSection from "@/components/generic/MetadataSection.vue";
import StateSummary from "@/components/generic/StateSummary.vue";
import Events from "@/components/generic/Events.vue";
import Conditions from "@/components/generic/Conditions.vue";
import ContainersSection from "@/components/generic/ContainersSection.vue";
import { PanelSectionsKey } from "@/components/generic/panelSections";
import { KubernetesObject } from "@kubernetes/client-node";
import { hasUsage, type Subject } from "@/lib/metrics/usage";
import { CalendarSearch, ListChecks } from "lucide-vue-next";
import { useLiveObject, useNow } from "@/composables/usePanelObject";
import { objectState } from "@/lib/resources/state";
import { conditionHealthy } from "@/lib/resources/conditions";

import type { Component } from "vue";
import { deliveryKindOf } from "@/lib/gitops/kinds";

const props = defineProps<{ resource: KubernetesObject }>();

/* GitOps deliveries (Flux, Argo CD) have a panel of their own. */
const Delivery = defineAsyncComponent(() => import("@/views/panels/Delivery.vue"));
const isDelivery = computed(() => deliveryKindOf(props.resource) !== null);

const { live, gone } = useLiveObject(() => props.resource);
const now = useNow();

/*
 * Kind-specific sections (resource/<Kind>.vue). Async components are created
 * once per kind: creating one per render remounted the section (and reloaded
 * its chunk) on every update. Kinds without a section render nothing.
 */
const resourceSections = import.meta.glob<{ default: Component }>(
  "./resource/*.vue"
);
const sectionCache = new Map<string, Component | null>();

const getResourceSpecificComponent = (
  resource: KubernetesObject
): Component | null => {
  const kind = resource.kind || "";
  if (!sectionCache.has(kind)) {
    const loader = resourceSections[`./resource/${kind}.vue`];
    sectionCache.set(kind, loader ? defineAsyncComponent(loader) : null);
  }
  return sectionCache.get(kind) ?? null;
};

/* Usage over time (its own chunk; only kinds with pods or a node). */
const UsageSection = defineAsyncComponent(
  () => import("@/components/metrics/UsageSection.vue")
);
const showUsage = computed(() => hasUsage(props.resource.kind));

/* Generic, read-only views on common spec / status shapes. */
const anyResource = computed(() => live.value as any);
const state = computed(() =>
  gone.value
    ? { label: "Deleted", tone: "muted" as const, detail: "It no longer exists in the cluster. This is how it last looked." }
    : objectState(live.value, now.value)
);

/* Kinds whose section shows their conditions its own way. */
const OWN_CONDITIONS = new Set(["Node", "HorizontalPodAutoscaler"]);
const conditions = computed(() => {
  const list = anyResource.value.status?.conditions;
  return Array.isArray(list) && !OWN_CONDITIONS.has(live.value.kind ?? "") ? list : [];
});
const unhealthyConditions = computed(() => conditions.value.filter((c: any) => !conditionHealthy(c)).length);

const isEvent = computed(() => live.value.kind === "Event");
const hasMetadata = computed(
  () =>
    !isEvent.value ||
    Object.keys(live.value.metadata?.labels ?? {}).length + Object.keys(live.value.metadata?.annotations ?? {}).length > 0
);

/*
 * Open sections, chosen when an object is shown: the essentials, plus
 * conditions and events when something is wrong.
 */
const DEFAULT_OPEN = [
  "usage", "overview", "status", "data", "containers", "uses", "ports", "endpoints", "routes", "rules", "tls",
  "capacity", "taints", "metrics", "scaling", "jobs", "pods", "claims", "used-by", "quota", "limits", "event",
  // RBAC kinds (resource/Role.vue, ...), Helm runs and operator kinds.
  "aggregation", "granted", "subjects", "access", "runs", "spec", "flow",
  "labels",
];
const open = ref<string[]>([]);
const problem = () => state.value?.tone === "destructive" || state.value?.tone === "warning";
watch(
  () => `${live.value.metadata?.context}/${live.value.metadata?.uid}`,
  () => {
    open.value = [
      ...DEFAULT_OPEN,
      ...(unhealthyConditions.value > 0 ? ["conditions"] : []),
      ...(problem() ? ["events"] : []),
    ];
  },
  { immediate: true }
);
provide(PanelSectionsKey, {
  open: (value: string) => {
    if (!open.value.includes(value)) open.value = [...open.value, value];
  },
});

const conditionsHint = computed(() =>
  unhealthyConditions.value > 0 ? `${unhealthyConditions.value} not OK` : "All OK"
);
</script>
<template>
  <Delivery v-if="isDelivery" :key="`${resource.metadata?.uid}`" :resource="resource" />
  <!-- Keyed: following a link reuses this component for another object. -->
  <div v-else :key="`${live.metadata?.context}/${live.metadata?.uid}`" class="bg-card">
    <StateSummary :state="state" :now="now" />
    <Accordion v-model="open" class="w-full" type="multiple" collapsible>
      <UsageSection v-if="showUsage" :resource="live as Subject" />
      <component
        :is="getResourceSpecificComponent(live)"
        v-if="getResourceSpecificComponent(live)"
        :resource="live"
      />
      <!-- Pods place their containers themselves (right after the overview). -->
      <ContainersSection v-if="live.kind !== 'Pod'" :object="live" />
      <PanelSection
        v-if="conditions.length > 0"
        value="conditions"
        title="Conditions"
        :icon="ListChecks"
        :count="conditions.length"
        :hint="conditionsHint"
      >
        <Conditions :conditions="conditions" />
      </PanelSection>
      <template v-if="hasMetadata">
        <MetadataSection type="labels" :object="live" :editable="!isEvent" />
        <MetadataSection type="annotations" :object="live" :editable="!isEvent" />
      </template>
      <PanelSection v-if="!isEvent" value="events" title="Events" :icon="CalendarSearch">
        <Suspense>
          <Events :object="live" />

          <template #fallback>
            <div class="space-y-2" aria-label="Fetching events">
              <Skeleton v-for="index in 3" :key="index" class="h-12 w-full" />
            </div>
          </template>
        </Suspense>
      </PanelSection>
    </Accordion>
  </div>
</template>

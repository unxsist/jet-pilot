<script setup lang="ts">
import { Accordion } from "@/components/ui/accordion";
import { Skeleton } from "@/components/ui/skeleton";
import PanelSection from "@/components/generic/PanelSection.vue";
import MetadataAnnotationsLabels from "@/components/generic/MetadataAnnotationsLabels.vue";
import Events from "@/components/generic/Events.vue";
import Conditions from "@/components/generic/Conditions.vue";
import Containers from "@/components/generic/Containers.vue";
import { KubernetesObject } from "@kubernetes/client-node";
import { hasUsage, type Subject } from "@/lib/metrics/usage";
import {
  Boxes,
  CalendarSearch,
  ListChecks,
  NotebookPen,
  Tags,
} from "lucide-vue-next";

import type { Component } from "vue";
import { deliveryKindOf } from "@/lib/gitops/kinds";

const props = defineProps<{ resource: KubernetesObject }>();

/* GitOps deliveries (Flux, Argo CD) have a panel of their own. */
const Delivery = defineAsyncComponent(() => import("@/views/panels/Delivery.vue"));
const isDelivery = computed(() => deliveryKindOf(props.resource) !== null);

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
const anyResource = computed(() => props.resource as any);

const conditions = computed(() => {
  const list = anyResource.value.status?.conditions;
  return Array.isArray(list) ? list : [];
});

const podSpec = computed(
  () => anyResource.value.spec?.template?.spec ?? anyResource.value.spec
);

const containers = computed(() => {
  const list = podSpec.value?.containers;
  return Array.isArray(list) ? list : [];
});

const labelCount = computed(
  () => Object.keys(props.resource.metadata?.labels || {}).length
);
const annotationCount = computed(
  () => Object.keys(props.resource.metadata?.annotations || {}).length
);
</script>
<template>
  <Delivery v-if="isDelivery" :key="`${resource.metadata?.uid}`" :resource="resource" />
  <div v-else class="bg-card">
    <Accordion
      class="w-full"
      type="multiple"
      collapsible
      :default-value="[
        'usage',
        'status',
        'data',
        'containers',
        'conditions',
        'labels',
        'annotations',
      ]"
    >
      <UsageSection v-if="showUsage" :resource="resource as Subject" />
      <component
        v-if="getResourceSpecificComponent(resource)"
        :is="getResourceSpecificComponent(resource)"
        :resource="resource"
      />
      <PanelSection
        v-if="containers.length > 0"
        value="containers"
        title="Containers"
        :icon="Boxes"
        :count="containers.length + (podSpec?.initContainers?.length ?? 0)"
      >
        <Containers
          :containers="containers"
          :statuses="anyResource.status?.containerStatuses"
          :init-containers="podSpec?.initContainers"
          :init-statuses="anyResource.status?.initContainerStatuses"
        />
      </PanelSection>
      <PanelSection
        v-if="conditions.length > 0"
        value="conditions"
        title="Conditions"
        :icon="ListChecks"
        :count="conditions.length"
      >
        <Conditions :conditions="conditions" />
      </PanelSection>
      <PanelSection
        value="labels"
        title="Labels"
        :icon="Tags"
        :count="labelCount"
      >
        <MetadataAnnotationsLabels type="labels" :object="resource" />
      </PanelSection>
      <PanelSection
        value="annotations"
        title="Annotations"
        :icon="NotebookPen"
        :count="annotationCount"
      >
        <MetadataAnnotationsLabels type="annotations" :object="resource" />
      </PanelSection>
      <PanelSection value="events" title="Events" :icon="CalendarSearch">
        <Suspense>
          <Events :object="resource" />

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

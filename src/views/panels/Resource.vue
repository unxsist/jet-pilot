<script setup lang="ts">
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import MetadataAnnotationsLabels from "@/components/generic/MetadataAnnotationsLabels.vue";
import Events from "@/components/generic/Events.vue";
import { KubernetesObject } from "@kubernetes/client-node";
import { Tags, NotebookPen, CalendarSearch } from "lucide-vue-next";
import Loading from "@/components/Loading.vue";

import type { Component } from "vue";

defineProps<{ resource: KubernetesObject }>();

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
</script>
<template>
  <div class="bg-background">
    <Accordion
      class="w-full"
      type="multiple"
      collapsible
      :default-value="['annotations', 'labels', 'data']"
    >
      <AccordionItem class="px-4" value="annotations">
        <AccordionTrigger>
          <div class="flex items-center gap-2">
            <NotebookPen class="h-4" /> Annotations
          </div>
        </AccordionTrigger>
        <AccordionContent>
          <MetadataAnnotationsLabels type="annotations" :object="resource" />
        </AccordionContent>
      </AccordionItem>
      <AccordionItem class="px-4" value="labels">
        <AccordionTrigger>
          <div class="flex items-center gap-2"><Tags class="h-5" /> Labels</div>
        </AccordionTrigger>
        <AccordionContent>
          <MetadataAnnotationsLabels type="labels" :object="resource" />
        </AccordionContent>
      </AccordionItem>
      <component
        v-if="getResourceSpecificComponent(resource)"
        :is="getResourceSpecificComponent(resource)"
        :resource="resource"
      />
      <AccordionItem class="px-4" value="events">
        <AccordionTrigger>
          <div class="flex items-center gap-2">
            <CalendarSearch class="h-4" /> Events
          </div>
        </AccordionTrigger>
        <AccordionContent>
          <Suspense>
            <Events :object="resource" />

            <template #fallback>
              <div class="text-center">
                <Loading label="Fetching events" />
              </div>
            </template>
          </Suspense>
        </AccordionContent>
      </AccordionItem>
    </Accordion>
  </div>
</template>

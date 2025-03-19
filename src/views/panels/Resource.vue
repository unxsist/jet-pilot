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

defineProps<{ resource: KubernetesObject }>();

const getResourceSpecificComponent = (resource: KubernetesObject) => {
  return defineAsyncComponent(
    () => import(`@/views/panels/resource/${resource.kind}.vue`)
  );
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

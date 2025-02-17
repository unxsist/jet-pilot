<script setup lang="ts">
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import MetadataAnnotationsLabels from "@/components/generic/MetadataAnnotationsLabels.vue";
import { KubernetesObject } from "@kubernetes/client-node";

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
          <div class="flex items-center gap-2">Annotations</div>
        </AccordionTrigger>
        <AccordionContent>
          <MetadataAnnotationsLabels type="annotations" :object="resource" />
        </AccordionContent>
      </AccordionItem>
      <AccordionItem class="px-4" value="labels">
        <AccordionTrigger>
          <div class="flex items-center gap-2">Labels</div>
        </AccordionTrigger>
        <AccordionContent>
          <MetadataAnnotationsLabels type="labels" :object="resource" />
        </AccordionContent>
      </AccordionItem>
      <component
        :is="getResourceSpecificComponent(resource)"
        :resource="resource"
      />
    </Accordion>
  </div>
</template>

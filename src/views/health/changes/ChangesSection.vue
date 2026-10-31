<script setup lang="ts">
/**
 * "Changes" in an object's side panel: its latest changes (and for pods
 * and workloads, those of what they depend on: their workload, the
 * ConfigMaps and Secrets they use), newest first, with a link to the full
 * timeline. Loads when the section opens.
 */
import { History } from "lucide-vue-next";
import { Skeleton } from "@/components/ui/skeleton";
import PanelSection from "@/components/generic/PanelSection.vue";
import ChangesList from "./ChangesList.vue";

defineProps<{ object: any }>();
</script>

<template>
  <PanelSection value="changes" title="Changes" :icon="History">
    <Suspense>
      <ChangesList :object="object" />
      <template #fallback>
        <div class="space-y-2" aria-label="Reading changes">
          <Skeleton v-for="index in 3" :key="index" class="h-9 w-full" />
        </div>
      </template>
    </Suspense>
  </PanelSection>
</template>

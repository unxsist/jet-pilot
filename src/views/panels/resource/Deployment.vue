<script setup lang="ts">
import {
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Activity } from "lucide-vue-next";
import { V1Deployment } from "@kubernetes/client-node";
import Badge from "@/components/ui/badge/Badge.vue";

defineProps<{ resource: V1Deployment }>();
</script>
<template>
  <AccordionItem class="px-4" value="status">
    <AccordionTrigger>
      <div class="flex items-center gap-2">
        <Activity class="h-4" />Status &amp; Replicas
      </div>
    </AccordionTrigger>
    <AccordionContent>
      <div class="space-y-4">
        <div class="grid grid-cols-3 gap-4">
          <div class="flex space-x-1">
            <span class="font-semibold">Available:</span>
            <span
              >{{ resource.status?.readyReplicas ?? 0 }} /
              {{ resource.spec?.replicas }}</span
            >
          </div>
          <div class="flex space-x-1">
            <span class="font-semibold">Updated:</span>
            <span>{{ resource.status?.updatedReplicas ?? 0 }}</span>
          </div>
          <div class="flex space-x-1">
            <span class="font-semibold">Unavailable:</span>
            <span>{{
              resource.status?.replicas - (resource.status?.readyReplicas ?? 0)
            }}</span>
          </div>
        </div>
        <div class="flex space-x-2 col-span-3">
          <span class="font-semibold">Update Strategy:</span>
          <Badge variant="outline">{{ resource.spec?.strategy?.type }}</Badge>
        </div>
        <div class="grid grid-cols-2 text-muted-foreground">
          <div
            class="flex space-x-1"
            v-if="resource.spec?.strategy?.rollingUpdate"
          >
            <span class="font-semibold">Max Unavailable:</span>
            <span>{{
              resource.spec?.strategy?.rollingUpdate?.maxUnavailable
            }}</span>
          </div>
          <div
            class="flex space-x-1"
            v-if="resource.spec?.strategy?.rollingUpdate"
          >
            <span class="font-semibold">Max Surge:</span>
            <span>{{ resource.spec?.strategy?.rollingUpdate?.maxSurge }}</span>
          </div>
        </div>
      </div>
    </AccordionContent>
  </AccordionItem>
</template>

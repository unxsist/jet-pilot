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
      <div class="grid grid-cols-2">
        <div class="relative flex items-center justify-center p-2 border-b">
          <span class="font-black text-lg">{{
            resource.status?.readyReplicas ?? 0
          }}</span>
          <span
            class="uppercase text-xs font-semibold absolute right-1.5 bottom-1.5 text-muted-foreground"
          >
            Available
          </span>
        </div>
        <div
          class="relative flex items-center justify-center p-2 border-l border-b"
        >
          <span class="font-black text-lg">{{
            resource.spec?.replicas ?? 0
          }}</span>
          <span
            class="uppercase text-xs font-semibold absolute left-1.5 bottom-1.5 text-muted-foreground"
          >
            Desired
          </span>
        </div>
      </div>
      <div class="grid grid-cols-2 mb-4">
        <div class="relative flex items-center justify-center p-2">
          <span class="font-black text-lg">{{
            resource.status?.unavailableReplicas ?? 0
          }}</span>
          <span
            class="uppercase text-xs font-semibold absolute right-1.5 top-1.5 text-muted-foreground"
          >
            Unavailable
          </span>
        </div>
        <div class="relative flex items-center justify-center p-2 border-l">
          <span class="font-bold text-lg">{{
            resource.status?.updatedReplicas ?? 0
          }}</span>
          <span
            class="uppercase text-xs font-semibold absolute left-1.5 top-1.5 text-muted-foreground"
          >
            Updated
          </span>
        </div>
      </div>
      <div class="space-y-4">
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

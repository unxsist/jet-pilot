<script setup lang="ts">
import { Activity } from "lucide-vue-next";
import { V1Deployment } from "@kubernetes/client-node";
import PanelSection from "@/components/generic/PanelSection.vue";
import { Progress } from "@/components/ui/progress";

const props = defineProps<{ resource: V1Deployment }>();

const desired = computed(() => props.resource.spec?.replicas ?? 0);
const ready = computed(() => props.resource.status?.readyReplicas ?? 0);

const stats = computed(() => [
  { label: "Ready", value: ready.value, warn: ready.value < desired.value },
  { label: "Desired", value: desired.value, warn: false },
  {
    label: "Updated",
    value: props.resource.status?.updatedReplicas ?? 0,
    warn: false,
  },
  {
    label: "Unavailable",
    value: props.resource.status?.unavailableReplicas ?? 0,
    warn: (props.resource.status?.unavailableReplicas ?? 0) > 0,
  },
]);

const readyPercent = computed(() =>
  desired.value > 0 ? Math.round((ready.value / desired.value) * 100) : 0
);
</script>
<template>
  <PanelSection value="status" title="Status & replicas" :icon="Activity">
    <div class="space-y-3">
      <div class="grid grid-cols-4 overflow-hidden rounded-lg border">
        <div
          v-for="(stat, index) in stats"
          :key="stat.label"
          class="bg-surface-1/60 px-3 py-2"
          :class="{ 'border-l': index > 0 }"
        >
          <div
            class="text-lg font-semibold tabular-nums"
            :class="stat.warn ? 'text-warning' : 'text-foreground'"
          >
            {{ stat.value }}
          </div>
          <div class="text-2xs font-medium uppercase tracking-wide text-muted-foreground">
            {{ stat.label }}
          </div>
        </div>
      </div>
      <div class="flex items-center gap-3">
        <Progress :model-value="readyPercent" class="h-1.5 flex-1" />
        <span class="text-xs tabular-nums text-muted-foreground"
          >{{ readyPercent }}% ready</span
        >
      </div>
      <dl class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-xs">
        <dt class="text-muted-foreground">Strategy</dt>
        <dd class="font-medium">{{ resource.spec?.strategy?.type ?? "–" }}</dd>
        <template v-if="resource.spec?.strategy?.rollingUpdate">
          <dt class="text-muted-foreground">Max unavailable</dt>
          <dd class="font-mono">
            {{ resource.spec?.strategy?.rollingUpdate?.maxUnavailable }}
          </dd>
          <dt class="text-muted-foreground">Max surge</dt>
          <dd class="font-mono">
            {{ resource.spec?.strategy?.rollingUpdate?.maxSurge }}
          </dd>
        </template>
      </dl>
    </div>
  </PanelSection>
</template>

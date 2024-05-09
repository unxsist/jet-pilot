<script setup lang="ts">
import { V1Pod, PodMetric } from "@kubernetes/client-node";
import { memoryParser } from "@/lib/unitParsers";
import PodUsageChartBar from "./PodUsageChartBar.vue";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

const props = defineProps<{
  pod: V1Pod & { metrics: PodMetric[] };
}>();

const cpuDatapoints = computed(() => {
  return props.pod.metrics.map((metric: PodMetric) => {
    return metric.containers.reduce((acc, container) => {
      return acc + Number(container.usage.cpu.replace("n", "")) / 1000000;
    }, 0);
  });
});

const memoryDatapoints = computed(() => {
  return props.pod.metrics.map((metric: PodMetric) => {
    return metric.containers.reduce((acc, container) => {
      return acc + Number(container.usage.memory.replace("Ki", "")) * 1000;
    }, 0);
  });
});

const latestCpuDatapoint = computed(() => {
  return cpuDatapoints.value.toReversed()[0];
});

const latestMemoryDatapoint = computed(() => {
  return memoryDatapoints.value.toReversed()[0];
});

const cpuRequest = computed(() => {
  return props.pod.spec.containers.reduce((acc, container) => {
    if (container.resources?.requests?.cpu === undefined) {
      return acc;
    }

    if (!container.resources?.requests?.cpu.includes("m")) {
      return acc + Number(container.resources?.requests?.cpu) * 1000;
    }

    return (
      acc + Number(container.resources?.requests?.cpu?.replace("m", "") || 0)
    );
  }, 0);
});

const memoryRequest = computed(() => {
  return props.pod.spec.containers.reduce((acc, container) => {
    if (container.resources?.requests?.memory === undefined) {
      return acc;
    }

    return acc + memoryParser(container.resources?.requests?.memory);

    return (
      acc + Number(container.resources?.requests?.cpu?.replace("Mi", "") || 0)
    );
  }, 0);
});

const cpuLimit = computed(() => {
  return props.pod.spec.containers.reduce((acc, container) => {
    if (container.resources?.limits?.cpu === undefined) {
      return acc;
    }

    if (!container.resources?.limits?.cpu.includes("m")) {
      return acc + Number(container.resources?.limits?.cpu) * 1000;
    }

    return (
      acc + Number(container.resources?.limits?.cpu?.replace("m", "") || 0)
    );
  }, 0);
});

const memoryLimit = computed(() => {
  return props.pod.spec.containers.reduce((acc, container) => {
    if (container.resources?.limits?.memory === undefined) {
      return acc;
    }

    return acc + memoryParser(container.resources?.limits?.memory);
  }, 0);
});

const cpuUsage = computed(() => {
  return cpuLimit.value > 0
    ? (latestCpuDatapoint.value / cpuLimit.value) * 100
    : 0;
});

const memoryUsage = computed(() => {
  return memoryLimit.value > 0
    ? (latestMemoryDatapoint.value / memoryLimit.value) * 100
    : 0;
});

const cpuThreshold = computed(() => {
  return cpuLimit.value > 0 ? (cpuRequest.value / cpuLimit.value) * 100 : 0;
});

const memoryThreshold = computed(() => {
  return memoryLimit.value > 0
    ? (memoryRequest.value / memoryLimit.value) * 100
    : 0;
});
</script>
<template>
  <TooltipProvider :disable-hoverable-content="true">
    <Tooltip :delay-duration="200">
      <TooltipTrigger as-child>
        <div class="space-y-1">
          <PodUsageChartBar
            v-if="cpuDatapoints"
            text="C"
            :value="cpuUsage"
            :threshold="cpuThreshold > 0 ? cpuThreshold : undefined"
          />
          <PodUsageChartBar
            v-if="memoryDatapoints"
            text="M"
            :value="memoryUsage"
            :threshold="memoryThreshold > 0 ? memoryThreshold : undefined"
          />
        </div>
      </TooltipTrigger>
      <TooltipContent>
        <div>
          <div class="font-bold">CPU</div>
          <div>
            U: {{ latestCpuDatapoint.toFixed(0) }}m / R: {{ cpuRequest }}m / L:
            {{ cpuLimit }}m
          </div>
          <div class="mt-2 font-bold">Memory</div>
          <div>
            U: {{ (latestMemoryDatapoint / 1000000).toFixed(0) }}Mi / R:
            {{ (memoryRequest / 1000000).toFixed(0) }} Mi / L:
            {{ (memoryLimit / 1000000).toFixed(0) }}Mi
          </div>
        </div>
      </TooltipContent>
    </Tooltip>
  </TooltipProvider>
</template>

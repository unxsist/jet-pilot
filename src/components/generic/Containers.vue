<script setup lang="ts">
import type { V1Container, V1ContainerStatus } from "@kubernetes/client-node";
import { StatusBadge } from "@/components/ui/status";
import { RotateCcw } from "lucide-vue-next";

const props = defineProps<{
  containers: V1Container[];
  statuses?: V1ContainerStatus[];
  initContainers?: V1Container[];
  initStatuses?: V1ContainerStatus[];
}>();

interface Row {
  container: V1Container;
  status?: V1ContainerStatus;
  init: boolean;
}

const rows = computed<Row[]>(() => [
  ...(props.initContainers || []).map((container) => ({
    container,
    status: props.initStatuses?.find((s) => s.name === container.name),
    init: true,
  })),
  ...props.containers.map((container) => ({
    container,
    status: props.statuses?.find((s) => s.name === container.name),
    init: false,
  })),
]);

/* State label as kubectl shows it: Running / waiting or terminated reason. */
const stateOf = (status?: V1ContainerStatus): string | null => {
  if (!status?.state) return null;
  if (status.state.running) return status.ready ? "Running" : "Not ready";
  if (status.state.waiting) return status.state.waiting.reason || "Waiting";
  if (status.state.terminated)
    return status.state.terminated.reason || "Terminated";
  return null;
};

const resourcePair = (
  container: V1Container,
  resource: "cpu" | "memory"
): string | null => {
  const request = container.resources?.requests?.[resource];
  const limit = container.resources?.limits?.[resource];
  if (!request && !limit) return null;
  return `${request ?? "–"} / ${limit ?? "–"}`;
};
</script>

<template>
  <ul class="space-y-2">
    <li
      v-for="{ container, status, init } in rows"
      :key="`${init ? 'init-' : ''}${container.name}`"
      class="rounded-lg border bg-surface-1/60 p-3"
    >
      <div class="flex items-center gap-2">
        <span class="truncate text-sm font-medium">{{ container.name }}</span>
        <span
          v-if="init"
          class="rounded border px-1 text-2xs font-medium uppercase tracking-wide text-muted-foreground"
          >init</span
        >
        <span class="ml-auto flex shrink-0 items-center gap-2">
          <span
            v-if="(status?.restartCount ?? 0) > 0"
            class="text-xs tabular-nums text-warning"
            :title="`${status?.restartCount} restarts`"
            ><RotateCcw class="mr-0.5 inline h-3 w-3 align-[-2px]" />{{
              status?.restartCount
            }}</span
          >
          <StatusBadge
            v-if="stateOf(status)"
            :status="stateOf(status) ?? undefined"
            :tone="stateOf(status) === 'Not ready' ? 'warning' : undefined"
          />
        </span>
      </div>
      <div
        class="mt-1 truncate font-mono text-xs text-muted-foreground select-text"
        :title="container.image"
      >
        {{ container.image }}
      </div>
      <dl
        v-if="
          container.ports?.length ||
          resourcePair(container, 'cpu') ||
          resourcePair(container, 'memory')
        "
        class="mt-2.5 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs"
      >
        <template v-if="container.ports?.length">
          <dt class="text-muted-foreground">Ports</dt>
          <dd class="flex flex-wrap gap-1">
            <span
              v-for="port in container.ports"
              :key="`${port.containerPort}/${port.protocol}`"
              class="rounded border bg-background px-1.5 font-mono text-2xs leading-4"
              :title="port.name"
              >{{ port.containerPort }}/{{ port.protocol || "TCP" }}</span
            >
          </dd>
        </template>
        <template v-if="resourcePair(container, 'cpu')">
          <dt class="text-muted-foreground">CPU</dt>
          <dd class="font-mono tabular-nums" title="request / limit">
            {{ resourcePair(container, "cpu") }}
          </dd>
        </template>
        <template v-if="resourcePair(container, 'memory')">
          <dt class="text-muted-foreground">Memory</dt>
          <dd class="font-mono tabular-nums" title="request / limit">
            {{ resourcePair(container, "memory") }}
          </dd>
        </template>
      </dl>
    </li>
  </ul>
</template>

<script setup lang="ts">
import { formatDateTime } from "@/lib/utils";
import { formatAge } from "@/components/tables/age";
import { getEventLastSeen } from "@/components/tables/status";
import { StatusDot } from "@/components/ui/status";
import { CoreV1Event, KubernetesObject } from "@kubernetes/client-node";
import { usePanelTarget } from "@/composables/usePanelObject";
import { fetchEvents } from "@/lib/resources/events";

/* Rows carry the context + kubeconfig they were fetched from. */
const props = defineProps<{ object: KubernetesObject }>();

const target = usePanelTarget(() => props.object);
const events = ref<CoreV1Event[]>([]);

try {
  events.value = await fetchEvents(target.value, props.object);
} catch {
  // No events is the honest fallback: the panel stays useful without them.
}
</script>
<template>
  <ol v-if="events.length > 0" class="relative space-y-3">
    <!-- timeline rail -->
    <span
      class="absolute bottom-1 left-[3px] top-1 w-px bg-border"
      aria-hidden="true"
    />
    <li
      v-for="(event, index) in events"
      :key="index"
      class="relative flex gap-3"
    >
      <StatusDot
        :tone="event.type === 'Warning' ? 'warning' : 'muted'"
        :label="event.type"
        class="mt-1.5 rounded-full ring-4 ring-card"
      />
      <div class="min-w-0 flex-1">
        <div class="flex items-baseline justify-between gap-2">
          <span class="flex min-w-0 items-center gap-1.5">
            <span
              class="truncate text-sm font-medium"
              :class="{ 'text-warning': event.type === 'Warning' }"
              >{{ event.reason }}</span
            >
            <span
              v-if="(event.count ?? 1) > 1"
              class="shrink-0 rounded bg-muted px-1 text-2xs font-medium tabular-nums text-muted-foreground"
              :title="`Seen ${event.count} times`"
              >×{{ event.count }}</span
            >
          </span>
          <span
            :title="formatDateTime(getEventLastSeen(event) ?? new Date())"
            class="shrink-0 text-xs tabular-nums text-muted-foreground"
          >
            {{ formatAge(getEventLastSeen(event)) }}
          </span>
        </div>
        <p class="mt-0.5 text-xs text-muted-foreground select-text">
          {{ event.message }}
        </p>
      </div>
    </li>
  </ol>
  <p v-else class="text-xs text-muted-foreground">
    No events for {{ object.metadata?.name }}
  </p>
</template>

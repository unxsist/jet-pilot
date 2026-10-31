<script setup lang="ts">
/**
 * The recent warning events of the objects involved in a problem (a pod,
 * its workload, a claim), newest first and without repeats, fetched when
 * this section opens.
 */
import type { CoreV1Event } from "@kubernetes/client-node";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusDot } from "@/components/ui/status";
import { formatAge } from "@/components/tables/age";
import { getEventLastSeen } from "@/components/tables/status";
import { formatDateTime } from "@/lib/utils";
import { byLastSeen, fetchEvents } from "@/lib/resources/events";
import type { Problem, Ref } from "@/lib/health/problems/model";

const props = defineProps<{ problem: Problem; objects: Ref[] }>();

const MAX = 8;
const events = shallowRef<CoreV1Event[] | null>(null);

onMounted(async () => {
  const target = { context: props.problem.context, kubeConfig: props.problem.kubeConfig };
  const lists = await Promise.allSettled(
    props.objects.map((ref) => fetchEvents(target, { kind: ref.kind, metadata: { name: ref.name, namespace: ref.namespace, uid: ref.uid } }))
  );
  const seen = new Set<string>();
  events.value = lists
    .flatMap((list) => (list.status === "fulfilled" ? list.value : []))
    .filter((event) => event.type === "Warning")
    .sort(byLastSeen)
    .filter((event) => {
      const key = `${event.reason}\u0000${event.message}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, MAX);
});
</script>

<template>
  <div v-if="!events" class="space-y-2" aria-label="Fetching events">
    <Skeleton v-for="index in 2" :key="index" class="h-10 w-full" />
  </div>
  <ol v-else-if="events.length" class="relative space-y-3">
    <span class="absolute bottom-1 left-[3px] top-1 w-px bg-border" aria-hidden="true" />
    <li v-for="(event, index) in events" :key="index" class="relative flex gap-3">
      <StatusDot tone="warning" class="mt-1.5 rounded-full ring-4 ring-card" />
      <div class="min-w-0 flex-1">
        <div class="flex items-baseline justify-between gap-2">
          <span class="flex min-w-0 items-center gap-1.5">
            <span class="truncate text-sm font-medium text-warning">{{ event.reason }}</span>
            <span
              v-if="(event.count ?? 1) > 1"
              class="shrink-0 rounded bg-muted px-1 text-2xs font-medium tabular-nums text-muted-foreground"
              :title="`Seen ${event.count} times`"
              >×{{ event.count }}</span
            >
          </span>
          <span :title="formatDateTime(getEventLastSeen(event) ?? new Date())" class="shrink-0 text-xs tabular-nums text-muted-foreground">
            {{ formatAge(getEventLastSeen(event)) }}
          </span>
        </div>
        <p class="mt-0.5 select-text break-words text-xs text-muted-foreground">{{ event.message }}</p>
      </div>
    </li>
  </ol>
  <p v-else class="text-xs text-muted-foreground">No recent warnings. Events expire after about an hour.</p>
</template>

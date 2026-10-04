<script setup lang="ts">
import { formatDateTime, injectStrict } from "@/lib/utils";
import { formatAge } from "@/components/tables/age";
import { getEventLastSeen } from "@/components/tables/status";
import { KubeContextStateKey } from "@/providers/KubeContextProvider";
import { Kubernetes } from "@/services/Kubernetes";
import { StatusDot } from "@/components/ui/status";
import { CoreV1Event, KubernetesObject } from "@kubernetes/client-node";

const { context, kubeConfig } = injectStrict(KubeContextStateKey);

/*
 * Rows carry the context + kubeconfig they were fetched from; fall back to
 * the primary context for objects that are not context-tagged.
 */
type ContextTaggedObject = KubernetesObject & {
  metadata?: KubernetesObject["metadata"] & {
    context?: string;
    kubeConfig?: string;
  };
};

const props = defineProps<{ object: ContextTaggedObject }>();

const events = ref<CoreV1Event[]>([]);

const fetchEvents = async () => {
  const objectContext = props.object.metadata?.context || context.value;
  const objectKubeConfig =
    props.object.metadata?.kubeConfig ||
    (props.object.metadata?.context ? "" : kubeConfig.value);

  const args = [
    "events",
    "--for",
    `${props.object.kind}/${props.object.metadata?.name}`,
    "--context",
    objectContext,
    "-o",
    "json",
  ];
  if (props.object.metadata?.namespace) {
    args.push("-n", props.object.metadata.namespace);
  }
  if (objectKubeConfig) {
    args.push("--kubeconfig", objectKubeConfig);
  }

  try {
    const data = await Kubernetes.kubectl(args);
    // Most recently seen first.
    events.value = (JSON.parse(data).items as CoreV1Event[]).sort(
      (a, b) =>
        (getEventLastSeen(b)?.getTime() ?? 0) -
        (getEventLastSeen(a)?.getTime() ?? 0)
    );
  } catch (error) {
    // ignore
  }
};

await fetchEvents();
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

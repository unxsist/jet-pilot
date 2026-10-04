<script setup lang="ts">
import { formatDateTime, injectStrict } from "@/lib/utils";
import { formatAge } from "@/components/tables/age";
import { getEventLastSeen } from "@/components/tables/status";
import { KubeContextStateKey } from "@/providers/KubeContextProvider";
import { Kubernetes } from "@/services/Kubernetes";
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
  <div class="space-y-2" v-if="events.length > 0">
    <div
      v-for="(event, index) in events"
      :key="index"
      class="transition-all bg-muted p-3 hover:bg-muted-foreground/50 rounded"
    >
      <div class="flex items-center justify-between mb-1">
        <div class="font-bold">{{ event.reason }}</div>
        <div
          :title="formatDateTime(getEventLastSeen(event) ?? new Date())"
          class="text-muted-foreground"
        >
          {{ formatAge(getEventLastSeen(event)) }}
        </div>
      </div>
      <div class="text-xs">
        {{ event.message }}
      </div>
    </div>
  </div>
  <div class="text-center" v-else>
    No events for {{ object.metadata?.name }}
  </div>
</template>

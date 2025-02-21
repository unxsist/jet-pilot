<script setup lang="ts">
import { formatDateTimeDifference, injectStrict } from "@/lib/utils";
import { KubeContextStateKey } from "@/providers/KubeContextProvider";
import { Kubernetes } from "@/services/Kubernetes";
import { CoreV1Event, KubernetesObject } from "@kubernetes/client-node";

const { context, kubeConfig } = injectStrict(KubeContextStateKey);

const props = defineProps<{ object: KubernetesObject }>();

const events = ref<CoreV1Event[]>([]);

const fetchEvents = async () => {
  const args = [
    "events",
    "--for",
    `${props.object.kind}/${props.object.metadata?.name}`,
    "--context",
    context.value,
    "-n",
    props.object.metadata?.namespace,
    "-o",
    "json",
    "--kubeconfig",
    kubeConfig.value,
  ];

  try {
    const data = await Kubernetes.kubectl(args);
    events.value = JSON.parse(data).items.sort(
      (a: CoreV1Event, b: CoreV1Event) => {
        return (
          new Date(b.firstTimestamp || new Date()).getTime() -
          new Date(a.firstTimestamp || new Date()).getTime()
        );
      }
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
      class="transition-all bg-muted p-3 hover:bg-muted-foreground rounded"
    >
      <div class="flex items-center justify-between mb-1">
        <div class="font-bold">{{ event.reason }}</div>
        <div :title="event.firstTimestamp">
          {{
            formatDateTimeDifference(
              event.firstTimestamp || new Date(),
              new Date()
            )
          }}
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

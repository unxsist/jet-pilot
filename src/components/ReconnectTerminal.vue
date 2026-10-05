<script setup lang="ts">
import { SquareTerminal, RotateCw } from "lucide-vue-next";
import { Button } from "@/components/ui/button";

/*
 * Placeholder of a restored shell / terminal tab. Restoring never starts a
 * process (`kubectl exec`, a local shell): the session only connects when
 * the user clicks Reconnect (or presses Enter on it). Nothing here takes
 * the focus.
 */
const props = defineProps<{
  title: string;
  tabProps?: Record<string, any>;
}>();

const emit = defineEmits<{ connect: [] }>();

const pod = computed<string | undefined>(
  () => props.tabProps?.pod?.metadata?.name
);
const container = computed<string | undefined>(
  () =>
    props.tabProps?.container?.name ??
    props.tabProps?.pod?.spec?.containers?.[0]?.name
);

const details = computed(() =>
  [
    ["Context", props.tabProps?.context],
    ["Namespace", props.tabProps?.namespace],
    ["Pod", pod.value],
    ["Container", pod.value ? container.value : undefined],
  ].filter((entry): entry is [string, string] => !!entry[1])
);
</script>

<template>
  <div
    class="flex h-full flex-col items-center justify-center gap-3 px-6 text-center"
    data-testid="reconnect-terminal"
  >
    <div
      class="flex h-9 w-9 items-center justify-center rounded-lg border bg-surface-1 text-muted-foreground"
    >
      <SquareTerminal class="h-4 w-4" />
    </div>
    <div class="space-y-1">
      <p class="text-sm font-medium text-foreground">
        {{ pod ? "Shell" : "Terminal" }} not connected
      </p>
      <p class="text-xs text-muted-foreground">
        {{
          pod
            ? "Restored tabs do not reconnect on their own. Reconnect runs kubectl exec in the pod again."
            : "Restored tabs do not reconnect on their own. Reconnect starts a new local shell."
        }}
      </p>
    </div>
    <dl
      v-if="details.length"
      class="grid grid-cols-[auto_auto] gap-x-3 gap-y-0.5 text-left text-xs"
    >
      <template v-for="[label, value] in details" :key="label">
        <dt class="text-muted-foreground">{{ label }}</dt>
        <dd class="font-mono text-foreground">{{ value }}</dd>
      </template>
    </dl>
    <Button size="sm" variant="outline" @click="emit('connect')">
      <RotateCw class="mr-1.5 h-3.5 w-3.5" />
      Reconnect
    </Button>
  </div>
</template>

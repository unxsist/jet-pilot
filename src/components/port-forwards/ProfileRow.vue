<script setup lang="ts">
/**
 * A saved forward: start it with one click, let it start with JET Pilot.
 * A running one shows a green dot instead of the start button.
 */
import { Loader2, Play, Trash2 } from "lucide-vue-next";
import { Button } from "@/components/ui/button";
import { StatusDot } from "@/components/ui/status";
import { Switch } from "@/components/ui/switch";
import { portLabel } from "@/lib/portForwardPorts";
import type { PortForwardProfile } from "@/lib/portForwardProfiles";

const props = defineProps<{
  profile: PortForwardProfile;
  running: boolean;
  starting: boolean;
}>();

const emit = defineEmits<{
  start: [];
  autoStart: [on: boolean];
  remove: [];
}>();

const detail = computed(() => {
  const spec = props.profile.spec;
  const port = portLabel(spec.portName, spec.objectPort);
  return `${port} → ${spec.localPort} · ${spec.namespace}`;
});
const where = computed(
  () => `${props.profile.spec.namespace} · ${props.profile.spec.context}`
);
</script>

<template>
  <li
    class="group/row flex h-11 items-center gap-3 rounded-lg px-2.5 transition-colors duration-fast hover:bg-accent/50"
  >
    <span class="flex h-8 w-8 shrink-0 items-center justify-center">
      <Loader2 v-if="starting" class="h-3.5 w-3.5 animate-spin text-muted-foreground" />
      <StatusDot v-else-if="running" tone="success" label="Running" />
      <Button
        v-else
        variant="ghost"
        size="icon-sm"
        class="text-muted-foreground hover:text-foreground"
        :aria-label="`Start ${profile.name}`"
        title="Start"
        @click="emit('start')"
      >
        <Play class="h-3.5 w-3.5" />
      </Button>
    </span>
    <div class="min-w-0 flex-1">
      <div class="truncate text-sm text-foreground">{{ profile.name }}</div>
      <p class="truncate text-xs text-muted-foreground" :title="where">{{ detail }}</p>
    </div>
    <Button
      variant="ghost"
      size="icon-xs"
      class="text-muted-foreground opacity-0 transition-opacity duration-fast hover:bg-destructive/10 hover:text-destructive group-hover/row:opacity-100 group-focus-within/row:opacity-100"
      :aria-label="`Delete ${profile.name}`"
      title="Delete"
      @click="emit('remove')"
    >
      <Trash2 class="h-3.5 w-3.5" />
    </Button>
    <Switch
      :checked="profile.autoStart"
      :aria-label="`Start ${profile.name} when JET Pilot starts`"
      :title="profile.autoStart ? 'Starts with JET Pilot' : 'Start with JET Pilot'"
      @update:checked="(on: boolean) => emit('autoStart', on)"
    />
  </li>
</template>

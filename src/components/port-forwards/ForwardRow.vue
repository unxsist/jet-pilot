<script setup lang="ts">
/**
 * One running forward in the forward manager, in the Clusters hub's
 * language: the cluster's avatar with the forward's state dot, what is
 * forwarded, one quiet line (or the problem, in words), and the local
 * address to copy. Traffic and actions show on hover.
 */
import { Check, ExternalLink, MoreHorizontal, RotateCw, Send } from "lucide-vue-next";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import ContextAvatar from "@/components/ContextAvatar.vue";
import { isHttpPort, portLabel } from "@/lib/portForwardPorts";
import { forwardLine, forwardTone, trafficLine } from "@/lib/portForwardView";
import { forwardUrl } from "@/lib/portForwardLocal";
import type { ActivePortForwarding } from "@/providers/PortForwardingProvider";

const props = defineProps<{
  forward: ActivePortForwarding;
  saved: boolean;
  /** Re-renders time-relative copy ("Reconnected 2m ago"). */
  now: number;
}>();

const emit = defineEmits<{
  open: [];
  test: [];
  save: [];
  restart: [];
  stop: [];
}>();

const label = computed(() =>
  portLabel(props.forward.portName, props.forward.objectPort)
);
const address = computed(() => {
  const host = props.forward.address === "127.0.0.1" ? "localhost" : props.forward.address;
  return `${host}:${props.forward.localPort}`;
});
const url = computed(() => forwardUrl(props.forward));
const line = computed(() => forwardLine(props.forward, props.now));
const traffic = computed(() => trafficLine(props.forward.traffic));
const http = computed(() =>
  isHttpPort(props.forward.portName, props.forward.objectPort)
);
const usable = computed(
  () => props.forward.status === "ready" || props.forward.status === "reconnecting"
);

const copied = ref(false);
let copiedTimer: ReturnType<typeof setTimeout> | undefined;
const copy = async () => {
  await writeText(http.value ? url.value : address.value).catch(() => undefined);
  copied.value = true;
  clearTimeout(copiedTimer);
  copiedTimer = setTimeout(() => (copied.value = false), 1400);
};
onBeforeUnmount(() => clearTimeout(copiedTimer));
</script>

<template>
  <li
    class="group/row flex min-h-14 items-center gap-3 rounded-lg px-2.5 py-2 transition-colors duration-fast hover:bg-accent/50"
    :data-forward-id="forward.id"
  >
    <ContextAvatar
      :name="forward.context"
      :kube-config="forward.kubeConfig"
      :status="forwardTone(forward)"
      class="[--avatar-ring:var(--popover)]"
    />

    <div class="min-w-0 flex-1">
      <div class="flex min-w-0 items-baseline gap-1.5">
        <span class="truncate text-sm font-medium text-foreground">{{
          forward.objectName
        }}</span>
        <span class="shrink-0 text-xs tabular-nums text-muted-foreground">{{
          label
        }}</span>
      </div>
      <p
        class="text-xs"
        :class="{
          truncate: forward.status !== 'error',
          'line-clamp-2': forward.status === 'error',
          'text-muted-foreground': line.tone === 'muted',
          'text-warning': line.tone === 'warning',
          'text-destructive': line.tone === 'destructive',
        }"
        :title="forward.status === 'error' ? line.text : forward.pod ?? undefined"
      >
        {{ line.text }}
      </p>
    </div>

    <div class="flex shrink-0 flex-col items-end gap-0.5">
      <button
        type="button"
        class="flex items-center gap-1 rounded px-1 font-mono text-xs text-muted-foreground transition-colors duration-fast hover:text-foreground focus-ring"
        :class="forward.status === 'error' && 'line-through decoration-muted-foreground/50'"
        :title="`Copy ${http ? url : address}`"
        :aria-label="`Copy ${http ? url : address}`"
        @click="copy"
      >
        <Check v-if="copied" class="h-3 w-3 text-success" />
        {{ copied ? "Copied" : address }}
      </button>
      <span
        class="px-1 text-2xs tabular-nums text-muted-foreground opacity-0 transition-opacity duration-fast group-hover/row:opacity-100"
        aria-hidden="true"
        >{{
          forward.engine === "kubectl" ? "via kubectl" : traffic ?? "No traffic yet"
        }}</span
      >
    </div>

    <div class="-ml-1 flex w-[3.5rem] shrink-0 items-center justify-end gap-0.5">
      <Button
        v-if="forward.status === 'error'"
        variant="ghost"
        size="icon-sm"
        class="text-muted-foreground"
        :aria-label="`Restart ${forward.objectName}`"
        title="Restart"
        @click="emit('restart')"
      >
        <RotateCw class="h-3.5 w-3.5" />
      </Button>
      <Button
        v-else-if="http"
        variant="ghost"
        size="icon-sm"
        class="text-muted-foreground opacity-0 transition-opacity duration-fast group-hover/row:opacity-100 group-focus-within/row:opacity-100"
        :disabled="!usable"
        :aria-label="`Send a request to ${forward.objectName}`"
        title="Send a request"
        @click="emit('test')"
      >
        <Send class="h-3.5 w-3.5" />
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger as-child>
          <Button
            variant="ghost"
            size="icon-sm"
            class="text-muted-foreground opacity-0 transition-opacity duration-fast group-hover/row:opacity-100 group-focus-within/row:opacity-100 data-[state=open]:opacity-100"
            :aria-label="`Actions for ${forward.objectName}`"
          >
            <MoreHorizontal class="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" class="w-52">
          <DropdownMenuItem v-if="http" :disabled="!usable" @select="emit('open')">
            <ExternalLink class="h-3.5 w-3.5" /> Open in browser
          </DropdownMenuItem>
          <DropdownMenuItem :disabled="!usable" @select="emit('test')">
            <Send class="h-3.5 w-3.5" /> Send a request…
          </DropdownMenuItem>
          <DropdownMenuItem @select="copy">Copy address</DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem @select="emit('save')">
            {{ saved ? "Remove profile" : "Save as profile" }}
          </DropdownMenuItem>
          <DropdownMenuItem @select="emit('restart')">Restart</DropdownMenuItem>
          <DropdownMenuItem variant="destructive" @select="emit('stop')">
            Stop
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  </li>
</template>

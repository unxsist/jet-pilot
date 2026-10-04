<script setup lang="ts">
import {
  ArrowRight,
  Cable,
  ChevronRight,
  ExternalLink,
  Loader2,
  TriangleAlert,
  Unplug,
} from "lucide-vue-next";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { StatusBadge, StatusDot } from "@/components/ui/status";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

import {
  PortForwardingStateKey,
  PortForwardingRemovePortForwarding,
  ActivePortForwarding,
} from "@/providers/PortForwardingProvider";
import { injectStrict } from "@/lib/utils";

const { activePortForwardings } = injectStrict(PortForwardingStateKey);
const removePortForwarding = injectStrict(PortForwardingRemovePortForwarding);

import { open } from "@tauri-apps/plugin-shell";
const openInBrowser = (portForwarding: ActivePortForwarding) => {
  open(`http://${portForwarding.address}:${portForwarding.localPort}`);
};

const countByStatus = (status: ActivePortForwarding["status"]) =>
  activePortForwardings.value.filter((pf) => pf.status === status).length;

const readyCount = computed(() => countByStatus("ready"));
const startingCount = computed(() => countByStatus("starting"));
const failedCount = computed(() => countByStatus("error"));

const overallTone = computed(() =>
  failedCount.value > 0
    ? "destructive"
    : startingCount.value > 0 && readyCount.value === 0
    ? "warning"
    : "success"
);

const summary = computed(() => {
  const parts = [`${readyCount.value} active`];
  if (startingCount.value > 0) parts.push(`${startingCount.value} starting`);
  if (failedCount.value > 0) parts.push(`${failedCount.value} failed`);
  return `Port forwarding: ${parts.join(", ")}`;
});

const formatExpiry = (expiresAtMs: number | null): string | null => {
  if (!expiresAtMs) return null;
  const diff = expiresAtMs - Date.now();
  if (diff <= 0) return "now";
  const hours = Math.floor(diff / 3_600_000);
  const minutes = Math.floor((diff % 3_600_000) / 60_000);
  if (hours > 0) return `in ${hours}h ${minutes}m`;
  if (minutes > 0) return `in ${minutes}m`;
  return "in <1m";
};
</script>
<template>
  <div v-if="activePortForwardings.length > 0" class="w-full">
    <Dialog>
      <DialogTrigger as-child>
        <button
          type="button"
          :aria-label="summary"
          :title="summary"
          class="group flex h-8 w-full items-center gap-2 rounded-md border border-success/20 bg-success/[0.06] px-2.5 text-sm text-foreground transition-colors duration-fast ease-out hover:border-success/30 hover:bg-success/10 focus-ring focus-visible:ring-offset-sidebar"
        >
          <StatusDot :tone="overallTone" :pulse="readyCount > 0" />
          <span class="flex-1 truncate text-left">
            {{ readyCount }} port forward{{ readyCount === 1 ? "" : "s" }}
          </span>
          <span
            v-if="startingCount > 0"
            class="inline-flex items-center gap-1 text-xs text-warning"
          >
            <Loader2 class="h-3 w-3 animate-spin" />{{ startingCount }}
          </span>
          <span
            v-if="failedCount > 0"
            class="inline-flex items-center gap-1 text-xs text-destructive"
          >
            <TriangleAlert class="h-3 w-3" />{{ failedCount }}
          </span>
          <ChevronRight
            class="h-3.5 w-3.5 text-muted-foreground transition-transform duration-fast group-hover:translate-x-0.5"
          />
        </button>
      </DialogTrigger>
      <DialogContent class="max-w-lg gap-0 overflow-hidden p-0">
        <DialogHeader class="border-b px-5 py-4">
          <DialogTitle>Port forwards</DialogTitle>
          <DialogDescription>
            {{ summary.replace("Port forwarding: ", "") }}
          </DialogDescription>
        </DialogHeader>
        <ul class="max-h-[60vh] overflow-y-auto" tabindex="0">
          <li
            v-for="portForwarding in activePortForwardings"
            :key="portForwarding.id"
            class="flex items-center gap-3 border-b border-border-subtle px-5 py-3 last:border-b-0"
          >
            <span
              class="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border bg-surface-2 text-muted-foreground shadow-xs"
            >
              <Cable class="h-4 w-4" />
            </span>
            <div class="min-w-0 flex-1">
              <div
                class="flex items-center gap-1.5 truncate font-mono text-xs text-foreground"
              >
                <span class="truncate"
                  >{{ portForwarding.objectName }}:{{
                    portForwarding.objectPort
                  }}</span
                >
                <ArrowRight class="h-3 w-3 shrink-0 text-muted-foreground" />
                <span class="shrink-0 text-link"
                  >{{ portForwarding.address }}:{{
                    portForwarding.localPort
                  }}</span
                >
              </div>
              <div
                class="mt-0.5 flex items-center gap-1.5 truncate text-xs text-muted-foreground"
              >
                <StatusBadge
                  v-if="portForwarding.status !== 'ready'"
                  :tone="
                    portForwarding.status === 'error' ? 'destructive' : 'warning'
                  "
                  :pulse="portForwarding.status === 'starting'"
                  class="h-4 px-1.5 text-2xs"
                >
                  {{ portForwarding.status === "error" ? "Failed" : "Starting" }}
                </StatusBadge>
                <span class="truncate"
                  >{{ portForwarding.context }} /
                  {{ portForwarding.namespace }}</span
                >
                <span v-if="portForwarding.expiresAtMs" class="shrink-0">
                  · auto-stops {{ formatExpiry(portForwarding.expiresAtMs) }}
                </span>
              </div>
              <div
                v-if="portForwarding.status === 'error' && portForwarding.error"
                class="mt-1 truncate text-xs text-destructive"
                :title="portForwarding.error"
              >
                {{ portForwarding.error }}
              </div>
            </div>
            <TooltipProvider>
              <div class="flex shrink-0 items-center gap-1">
                <Tooltip>
                  <TooltipTrigger as-child>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label="Open in browser"
                      :disabled="portForwarding.status !== 'ready'"
                      @click="openInBrowser(portForwarding)"
                    >
                      <ExternalLink class="h-3.5 w-3.5" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Open in browser</TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger as-child>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      class="text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                      aria-label="Stop port forward"
                      @click="removePortForwarding(portForwarding)"
                    >
                      <Unplug class="h-3.5 w-3.5" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Stop port forward</TooltipContent>
                </Tooltip>
              </div>
            </TooltipProvider>
          </li>
        </ul>
      </DialogContent>
    </Dialog>
  </div>
</template>

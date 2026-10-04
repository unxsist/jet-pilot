<script setup lang="ts">
import { Vue3Lottie } from "vue3-lottie";
import PortForwardingAnimation from "@/assets/port_forwarding.json";

import DisconnectIcon from "@/assets/icons/disconnect.svg";
import BrowserIcon from "@/assets/icons/browser.svg";

import { Dialog, DialogContent, DialogTrigger } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
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
  <div v-if="activePortForwardings.length > 0" class="w-full mt-0 mb-4 pr-2">
    <Dialog>
      <DialogTrigger as-child>
        <button
          type="button"
          :aria-label="summary"
          :title="summary"
          class="text-foreground relative overflow-hidden flex justify-center flex-col w-full text-xs bg-orange-500 rounded-lg p-2 text-left hover:bg-orange-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span
            >{{ readyCount }} Active Port Forwarding{{
              readyCount === 1 ? "" : "s"
            }}</span
          >
          <span
            v-if="startingCount > 0 || failedCount > 0"
            class="relative z-10 mt-1 flex flex-wrap gap-1"
          >
            <span
              v-if="startingCount > 0"
              class="inline-flex items-center gap-1 rounded bg-background/90 px-1.5 py-0.5 text-xxs text-foreground"
            >
              <span class="h-1.5 w-1.5 rounded-full bg-amber-500"></span>
              {{ startingCount }} starting
            </span>
            <span
              v-if="failedCount > 0"
              class="inline-flex items-center gap-1 rounded bg-background/90 px-1.5 py-0.5 text-xxs text-destructive"
            >
              <span class="h-1.5 w-1.5 rounded-full bg-destructive"></span>
              {{ failedCount }} failed
            </span>
          </span>
          <Vue3Lottie
            class="absolute -right-2 opacity-50"
            :animation-data="PortForwardingAnimation"
            :height="70"
            :width="70"
          />
        </button>
      </DialogTrigger>
      <DialogContent class="p-0 overflow-hidden" :closeable="false">
        <div class="grid" tabindex="0">
          <template
            v-for="portForwarding in activePortForwardings"
            :key="portForwarding.id"
          >
            <div
              class="border-b last:border-b-0 p-3 flex justify-between items-center"
            >
              <div>
                <div class="text-sm font-semibold">
                  {{
                    `${portForwarding.objectName}:${portForwarding.objectPort} -> ${portForwarding.address}:${portForwarding.localPort}`
                  }}
                </div>
                <div class="text-xs font-mono">
                  {{ portForwarding.context }} / {{ portForwarding.namespace }}
                </div>
                <div class="text-xs">
                  <span
                    v-if="portForwarding.status === 'starting'"
                    class="text-amber-600 dark:text-amber-400"
                  >
                    Starting…
                  </span>
                  <span
                    v-if="portForwarding.status === 'error'"
                    class="text-destructive"
                  >
                    {{ portForwarding.error }}
                  </span>
                  <span
                    v-if="portForwarding.expiresAtMs"
                    class="text-muted-foreground"
                  >
                    auto-stops {{ formatExpiry(portForwarding.expiresAtMs) }}
                  </span>
                </div>
              </div>
              <div class="flex items-center space-x-2">
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger as-child>
                      <Button
                        variant="secondary"
                        aria-label="Open in browser"
                        :disabled="portForwarding.status !== 'ready'"
                        @click="openInBrowser(portForwarding)"
                      >
                        <BrowserIcon class="h-5" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>
                      <p>Open in browser</p>
                    </TooltipContent>
                  </Tooltip>
                  <Tooltip>
                    <TooltipTrigger as-child>
                      <Button
                        variant="destructive"
                        aria-label="Stop port forward"
                        @click="removePortForwarding(portForwarding)"
                      >
                        <DisconnectIcon class="h-5" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>
                      <p>Delete Port Forward</p>
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              </div>
            </div>
          </template>
        </div>
      </DialogContent>
    </Dialog>
  </div>
</template>

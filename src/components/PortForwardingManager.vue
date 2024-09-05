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

import { open } from "@tauri-apps/api/shell";
const openInBrowser = (portForwarding: ActivePortForwarding) => {
  open(`http://${portForwarding.address}:${portForwarding.localPort}`);
};
</script>
<template>
  <div v-if="activePortForwardings.length > 0" class="w-full mt-0 mb-4 pr-2">
    <Dialog>
      <DialogTrigger as-child>
        <button
          class="relative overflow-hidden flex justify-center flex-col w-full text-xs bg-orange-500 rounded-lg p-2 text-left hover:bg-orange-600"
        >
          <span
            >{{ activePortForwardings.length }} Active Port Forwarding{{
              activePortForwardings.length > 1 ? "s" : ""
            }}</span
          >
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
            :key="portForwarding.pid"
          >
            <div
              class="border-b last:border-b-0 p-3 flex justify-between items-center"
            >
              <div>
                <div class="text-sm font-semibold">
                  {{ portForwarding.objectName }}:{{
                    portForwarding.objectPort
                  }}
                  -> {{ portForwarding.address }}:{{ portForwarding.localPort }}
                </div>
                <div class="text-xs font-mono">
                  {{ portForwarding.context }} / {{ portForwarding.namespace }}
                </div>
              </div>
              <div class="flex items-center space-x-2">
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger>
                      <Button
                        variant="secondary"
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
                    <TooltipTrigger>
                      <Button
                        variant="destructive"
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

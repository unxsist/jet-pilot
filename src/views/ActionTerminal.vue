<script setup lang="ts">
import { invoke } from "@tauri-apps/api/core";
import type { PtyStarter } from "@/lib/pty";
import PtyTerminal from "@/components/PtyTerminal.vue";
import TerminalClusterBanner from "@/components/guardrails/TerminalClusterBanner.vue";

/*
 * A custom action running in a terminal tab (a local command, kubectl, or
 * kubectl exec). The banner shows what runs, with the values quoted for
 * reading. Enter after the process exited runs it again, but only after
 * the guardrails and the action's confirmation agree again (`authorize`).
 * Never restored on start (the `argv` prop marks it, see tabDescriptors).
 */
const props = defineProps<{
  argv: string[];
  env?: Record<string, string>;
  /** What runs, as the user reads it. */
  display: string;
  context: string;
  kubeConfig?: string;
  tabId?: string;
  /** Asked before running again; false: not now. */
  authorize?: () => Promise<boolean>;
}>();

let started = false;

const start: PtyStarter = async ({ rows, cols }, onEvent) => {
  if (started && props.authorize && !(await props.authorize())) {
    throw "not confirmed";
  }
  started = true;
  return invoke<string>("create_tty_session", {
    initCommand: props.argv,
    env: props.env ?? {},
    rows,
    cols,
    onEvent,
  });
};

const banner = computed(() =>
  props.display
    .split("\n")
    .map((line) => `$ ${line}`)
    .join("\n")
);
</script>

<template>
  <div class="flex h-full w-full flex-col">
    <TerminalClusterBanner v-if="context" :context="context" :kube-config="kubeConfig" />
    <div class="min-h-0 flex-1">
      <PtyTerminal :start="start" :banner="banner" :tab-id="tabId" />
    </div>
  </div>
</template>

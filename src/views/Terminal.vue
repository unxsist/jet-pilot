<script setup lang="ts">
import { invoke } from "@tauri-apps/api/core";
import { PtyStarter } from "@/lib/pty";
import PtyTerminal from "@/components/PtyTerminal.vue";

/*
 * Local shell with kubectl preconfigured for a context: the backend points
 * KUBECONFIG to a temporary single-context copy of the kubeconfig (with the
 * namespace set when one is given) that is removed when the session ends.
 */
const props = defineProps<{
  context: string;
  namespace: string;
  kubeConfig: string;
  tabId?: string;
}>();

const banner = computed(
  () =>
    `kubectl is configured for context ${props.context}` +
    (props.namespace ? `, namespace ${props.namespace}` : "") +
    ". KUBECONFIG points to a temporary copy, your kubeconfig is not modified."
);

const start: PtyStarter = ({ rows, cols }, onEvent) =>
  invoke<string>("create_local_terminal_session", {
    kubeConfig: props.kubeConfig,
    context: props.context,
    namespace: props.namespace || null,
    rows,
    cols,
    onEvent,
  });
</script>

<template>
  <PtyTerminal :start="start" :banner="banner" :tab-id="tabId" />
</template>

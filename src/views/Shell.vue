<script setup lang="ts">
import { invoke } from "@tauri-apps/api/core";
import { V1Container, V1Pod } from "@kubernetes/client-node";
import { SettingsContextStateKey } from "@/providers/SettingsContextProvider";
import { injectStrict } from "@/lib/utils";
import { PtyStarter, kubectlExecCommand } from "@/lib/pty";
import PtyTerminal from "@/components/PtyTerminal.vue";
import TerminalClusterBanner from "@/components/guardrails/TerminalClusterBanner.vue";

const { settings } = injectStrict(SettingsContextStateKey);

const props = defineProps<{
  context: string;
  namespace: string;
  kubeConfig: string;
  pod: V1Pod;
  container?: V1Container;
  tabId?: string;
}>();

const start: PtyStarter = ({ rows, cols }, onEvent) =>
  invoke<string>("create_tty_session", {
    initCommand: kubectlExecCommand({
      pod: props.pod.metadata?.name as string,
      container: props.container
        ? props.container.name
        : (props.pod.spec?.containers?.[0].name as string),
      context: props.context,
      namespace: props.namespace,
      kubeConfig: props.kubeConfig,
      shell: settings.value.terminal.containerShell,
    }),
    rows,
    cols,
    onEvent,
  });
</script>

<template>
  <div class="flex h-full w-full flex-col">
    <TerminalClusterBanner :context="context" :kube-config="kubeConfig" />
    <div class="min-h-0 flex-1">
      <PtyTerminal :start="start" :tab-id="tabId" />
    </div>
  </div>
</template>

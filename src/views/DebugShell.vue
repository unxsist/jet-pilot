<script setup lang="ts">
import { invoke } from "@tauri-apps/api/core";
import { PtyMessage, PtyStarter, isPtyExitMessage, ptyOutput } from "@/lib/pty";
import PtyTerminal from "@/components/PtyTerminal.vue";
import { toast } from "@/components/ui/toast";
import { runCli, cliSucceeded, cliErrorMessage } from "@/actions/command";
import { clusterArgs, debugPodNameFromOutput } from "@/lib/workloads";
import { TabClosedEvent } from "@/providers/PanelProvider";

/*
 * `kubectl debug` in the existing pty terminal. For node shells
 * (`cleanupDebugPod`) the pod kubectl creates (node-debugger-…) is deleted
 * when the session exits or the tab closes: kubectl leaves it behind.
 */
const props = defineProps<{
  context: string;
  namespace: string;
  kubeConfig: string;
  argv: string[];
  banner?: string;
  cleanupDebugPod?: boolean;
  tabId?: string;
}>();

/* Debug pods created by this tab that still need to be deleted. */
const pendingPods = new Set<string>();
const decoder = new TextDecoder();

const deletePod = async (name: string) => {
  if (!pendingPods.delete(name)) return;
  const result = await runCli("kubectl", [
    "delete",
    "pod",
    name,
    "--wait=false",
    "--ignore-not-found",
    ...clusterArgs(props),
  ]);
  if (cliSucceeded(result)) {
    toast({ title: `Deleted debug pod ${name}`, autoDismiss: true });
  } else {
    toast({
      title: `Failed to delete debug pod ${name}`,
      description: `${cliErrorMessage(result)}\nDelete it manually: kubectl delete pod ${name} -n ${props.namespace}`,
      variant: "destructive",
      duration: 20000,
    });
  }
};

const cleanupAll = () => {
  for (const name of [...pendingPods]) deletePod(name);
};

/*
 * Watches the session output for the name of the debug pod, and deletes
 * it when the session exits. The terminal's own handler still gets every
 * message.
 */
const start: PtyStarter = (size, onEvent) => {
  if (props.cleanupDebugPod) {
    const forward = onEvent.onmessage;
    let seen = "";
    let podName: string | null = null;
    onEvent.onmessage = (message: PtyMessage) => {
      const output = ptyOutput(message);
      if (output && !podName && seen.length < 8192) {
        seen += decoder.decode(output, { stream: true });
        podName = debugPodNameFromOutput(seen);
        if (podName) pendingPods.add(podName);
      } else if (isPtyExitMessage(message) && podName) {
        deletePod(podName);
      }
      forward(message);
    };
  }

  return invoke<string>("create_tty_session", {
    initCommand: props.argv,
    rows: size.rows,
    cols: size.cols,
    onEvent,
  });
};

const handleTabClosed = (e: Event) => {
  const event = e as CustomEvent<TabClosedEvent>;
  if (props.tabId && event.detail.id === props.tabId) cleanupAll();
};

onMounted(() => window.addEventListener("TabOrchestrator_TabClosed", handleTabClosed));
onUnmounted(() => {
  window.removeEventListener("TabOrchestrator_TabClosed", handleTabClosed);
  cleanupAll();
});
</script>

<template>
  <PtyTerminal :start="start" :banner="banner" :tab-id="tabId" />
</template>

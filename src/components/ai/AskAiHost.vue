<script setup lang="ts">
/*
 * Ask AI's working half (see @/lib/ai/provider): connects the agent picked
 * in Settings › AI once it is found on PATH, opens a terminal tab per
 * question (never restored on start: `argv` marks it, see tabDescriptors),
 * and adds "Ask AI about this cluster" to the palette while an agent is
 * ready.
 */
import { injectStrict } from "@/lib/utils";
import { useToast } from "@/components/ui/toast";
import { SettingsContextStateKey } from "@/providers/SettingsContextProvider";
import { KubeContextStateKey } from "@/providers/KubeContextProvider";
import { PanelProviderAddTabKey } from "@/providers/PanelProvider";
import {
  RegisterCommandStateKey,
  UnregisterCommandStateKey,
} from "@/providers/CommandPaletteProvider";
import { guardedCluster } from "@/lib/guardrails/backstop";
import type { AskAiRequest } from "@/lib/ai/askAi";
import { connectAskAi } from "@/lib/ai/provider";
import { agentPaths, detectAgents } from "@/lib/ai/detect";
import { agentInfo, agentLaunch, agentName, customProgram, type AgentId } from "@/lib/ai/agents";
import { CLUSTER_QUESTION, composePrompt, namespaceOf, shortSubject } from "@/lib/ai/prompt";

const AskAiTerminal = defineAsyncComponent(() => import("@/views/AskAiTerminal.vue"));

const { settings } = injectStrict(SettingsContextStateKey);
const kube = injectStrict(KubeContextStateKey);
const addTab = injectStrict(PanelProviderAddTabKey);
const registerCommand = injectStrict(RegisterCommandStateKey);
const unregisterCommand = injectStrict(UnregisterCommandStateKey);
const { toast } = useToast();

const agent = computed(() => (settings.value.ai?.agent ?? "") as AgentId | "");
const program = computed(() => {
  if (agent.value === "custom") return customProgram(settings.value.ai.customCommand);
  return agent.value ? agentInfo(agent.value)?.program ?? "" : "";
});
const path = computed(() => (program.value ? agentPaths.value[program.value] ?? null : null));

watch(
  program,
  (value) => {
    if (value && !(value in agentPaths.value)) {
      detectAgents([value]).catch(() => undefined);
    }
  },
  { immediate: true }
);

const ask = (request: AskAiRequest) => {
  const id = agent.value;
  if (!id || !path.value) return;
  const cluster = guardedCluster(request.context, request.kubeConfig);
  const readOnly = cluster.readOnly;
  const launch = agentLaunch(id, composePrompt(request, { readOnly }), {
    readOnly,
    path: path.value,
    customCommand: settings.value.ai.customCommand,
    customReadOnlyCommand: settings.value.ai.customReadOnlyCommand,
  });
  if ("error" in launch) {
    toast({ title: "Ask AI can't start", description: launch.error, variant: "destructive" });
    return;
  }
  addTab(
    `ask-ai_${request.context}_${Date.now().toString(36)}`,
    `Ask AI: ${shortSubject(request.subject)}`,
    AskAiTerminal,
    {
      context: request.context,
      kubeConfig: request.kubeConfig,
      namespace: namespaceOf(request.namespace) ?? "",
      argv: launch.argv,
      env: launch.env,
      agent: agentName(id, settings.value.ai.customCommand),
      readOnlyMode: readOnly
        ? id === "custom"
          ? "starts with your read-only command"
          : agentInfo(id)?.readOnlyMode
        : undefined,
    },
    "shell"
  );
  window.dispatchEvent(new Event("TabOrchestrator_Expand"));
};

onUnmounted(connectAskAi({ available: () => !!agent.value && !!path.value, ask }));

const COMMAND_ID = "ask-ai-cluster";
watch(
  () => !!agent.value && !!path.value,
  (ready) => {
    unregisterCommand(COMMAND_ID);
    if (!ready) return;
    registerCommand({
      id: COMMAND_ID,
      name: "Ask AI about this cluster",
      description: "Start your AI agent with kubectl set to the current cluster",
      keywords: ["ai", "agent", "claude", "codex", "gemini", "opencode", "copilot", "investigate", "troubleshoot", "health"],
      execute: () => {
        if (!kube.context.value) {
          toast({
            title: "No context selected",
            description: "Select a context to ask about.",
            variant: "destructive",
          });
          return;
        }
        ask({
          context: kube.context.value,
          kubeConfig: kube.kubeConfig.value,
          namespace: kube.namespace.value,
          subject: guardedCluster(kube.context.value, kube.kubeConfig.value).displayName,
          question: CLUSTER_QUESTION,
        });
      },
    });
  },
  { immediate: true }
);
onUnmounted(() => unregisterCommand(COMMAND_ID));
</script>

<template>
  <slot />
</template>

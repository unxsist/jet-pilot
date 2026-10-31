<script setup lang="ts">
import { invoke } from "@tauri-apps/api/core";
import { Lock } from "lucide-vue-next";
import type { PtyStarter } from "@/lib/pty";
import PtyTerminal from "@/components/PtyTerminal.vue";
import TerminalClusterBanner from "@/components/guardrails/TerminalClusterBanner.vue";
import { guardedCluster } from "@/lib/guardrails/backstop";

/*
 * Ask AI: the user's agent CLI answering a question about a cluster, with
 * KUBECONFIG pinned to a temporary single-context copy (like the local
 * terminal). On read-only clusters the agent was started in its read-only
 * or plan mode (`readOnlyMode` says how), which the banner says instead of
 * the terminal's usual read-only note. Enter after the agent exits starts
 * it again on the same question. Never restored on start (`argv`).
 */
const props = defineProps<{
  context: string;
  kubeConfig: string;
  namespace?: string;
  argv: string[];
  env?: Record<string, string>;
  /** Its name: "Claude Code". */
  agent: string;
  /** Read-only clusters: what the agent does there, after its name. */
  readOnlyMode?: string;
  tabId?: string;
}>();

const cluster = computed(() => guardedCluster(props.context, props.kubeConfig));

const banner = computed(
  () =>
    `${props.agent} · kubectl on ${props.context}` +
    (props.namespace ? ` / ${props.namespace}` : "") +
    " · KUBECONFIG is a temporary copy, yours is untouched"
);

const start: PtyStarter = ({ rows, cols }, onEvent) =>
  invoke<string>("create_agent_terminal_session", {
    kubeConfig: props.kubeConfig,
    context: props.context,
    namespace: props.namespace || null,
    argv: props.argv,
    env: props.env ?? {},
    rows,
    cols,
    onEvent,
  });
</script>

<template>
  <div class="flex h-full w-full flex-col">
    <div
      v-if="readOnlyMode"
      role="note"
      class="flex h-8 shrink-0 items-center gap-2 border-b border-warning/20 bg-warning/[0.06] px-3 text-xs"
      data-testid="ask-ai-read-only-banner"
    >
      <Lock class="h-3.5 w-3.5 shrink-0 text-warning" />
      <span class="shrink-0 font-medium text-foreground">{{ cluster.displayName }}</span>
      <span class="min-w-0 truncate text-muted-foreground">
        is read-only, so {{ agent }} {{ readOnlyMode }}.
      </span>
    </div>
    <TerminalClusterBanner v-else :context="context" :kube-config="kubeConfig" />
    <div class="min-h-0 flex-1">
      <PtyTerminal :start="start" :banner="banner" :tab-id="tabId" />
    </div>
  </div>
</template>

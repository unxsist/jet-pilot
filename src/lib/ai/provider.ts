/*
 * The app's Ask AI, provided under AskAiKey in App.vue. Its working half,
 * AskAiHost (mounted in the app once it is idle: it needs the settings and
 * the tab panel), connects here with the agent from Settings › AI. Until
 * then, and while no agent is set up and installed, Ask AI is unavailable.
 */
import { computed, shallowRef } from "vue";
import type { AskAi, AskAiRequest } from "./askAi";

export interface AskAiConnection {
  /** Read inside a computed: reactive. */
  available(): boolean;
  ask(request: AskAiRequest): void;
}

const connection = shallowRef<AskAiConnection | null>(null);

export const appAskAi: AskAi = {
  available: computed(() => connection.value?.available() ?? false),
  ask: (request) => connection.value?.ask(request),
};

/** Connects the host; returns the disconnect. */
export function connectAskAi(host: AskAiConnection): () => void {
  connection.value = host;
  return () => {
    if (connection.value === host) connection.value = null;
  };
}

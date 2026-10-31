/*
 * "Ask AI": hands a question about a cluster to the AI agent the user
 * already has (a CLI like Claude Code or Codex), started in a terminal tab
 * with kubectl pinned to that cluster. JET Pilot sends nothing anywhere
 * itself and stores no keys. Callers say what to ask; the provider (see
 * @/lib/ai) decides how. Until one is provided, Ask AI is unavailable and
 * callers hide their buttons.
 */
import { computed, inject, type ComputedRef, type InjectionKey } from "vue";

export interface AskAiRequest {
  context: string;
  kubeConfig: string;
  namespace?: string;
  /** What it's about, for the tab title: "checkout-api (Deployment)". */
  subject: string;
  /** The question in plain words: "Why is checkout-api crash looping?" */
  question: string;
  /** What JET Pilot already knows (state, events, the likely cause), one fact per entry. */
  evidence?: string[];
}

export interface AskAi {
  /** An agent is set up and found on this computer. */
  available: ComputedRef<boolean>;
  ask(request: AskAiRequest): void;
}

export const AskAiKey: InjectionKey<AskAi> = Symbol("AskAi");

const unavailable: AskAi = { available: computed(() => false), ask: () => undefined };

export const useAskAi = (): AskAi => inject(AskAiKey, unavailable);

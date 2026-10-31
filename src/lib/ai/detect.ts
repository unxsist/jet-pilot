/*
 * Which agent CLIs are installed (`ai_find_agents`: a PATH lookup, nothing
 * runs), shared by the Ask AI host and Settings › AI so a "Check again"
 * there also wakes up the buttons.
 */
import { invoke } from "@tauri-apps/api/core";
import { ref } from "vue";

/** Program → where it was found (null: not installed). Missing keys: not looked up yet. */
export const agentPaths = ref<Record<string, string | null>>({});

export async function detectAgents(programs: string[]): Promise<void> {
  const wanted = [...new Set(programs.map((program) => program.trim()).filter(Boolean))];
  if (!wanted.length) return;
  const found = await invoke<(string | null)[]>("ai_find_agents", { programs: wanted });
  const next = { ...agentPaths.value };
  wanted.forEach((program, index) => (next[program] = found[index] ?? null));
  agentPaths.value = next;
}

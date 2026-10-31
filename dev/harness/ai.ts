/*
 * Ask AI (src/lib/ai): agent CLIs found on PATH and a scripted agent
 * session in the terminal tab.
 *
 * Knobs (query string, persisted in localStorage):
 *   ?ai=claude|codex|gemini|opencode|copilot|custom  that agent is picked in
 *                        Settings › AI (default: claude)
 *   ?ai=off              agents installed, none picked (Ask AI hidden)
 *   ?ai=none             no agent installed (install hints)
 *   ?aireadonly=1        the first context is read-only (agents start in
 *                        their read-only or plan mode)
 *
 * Installed: Claude Code, Codex and the custom `my-agent`; Gemini CLI,
 * OpenCode and Copilot CLI are missing.
 */
import { CONTEXTS, HOME, KUBECONFIG } from "./fixtures";

const params = new URLSearchParams(location.search);
for (const key of ["ai", "aireadonly"]) {
  const value = params.get(key);
  if (value) localStorage.setItem(`harness-${key}`, value);
}
const knob = localStorage.getItem("harness-ai") || "claude";
const readOnly = localStorage.getItem("harness-aireadonly") === "1";

const INSTALLED: Record<string, string> = {
  claude: `${HOME}/.local/bin/claude`,
  codex: "/usr/local/bin/codex",
  "my-agent": "/usr/local/bin/my-agent",
};

/** Preferences and cluster records for the fixture settings. */
export function aiSettings() {
  return {
    ai: {
      agent: knob === "off" || knob === "none" ? "" : knob,
      customCommand: knob === "custom" ? "my-agent --ask {prompt}" : "",
      customReadOnlyCommand: "",
    },
    ...(readOnly
      ? { clusters: [{ kubeConfig: KUBECONFIG, context: CONTEXTS[0]!.name, readOnly: true }] }
      : {}),
  };
}

const CRLF = (text: string) => text.replace(/\n/g, "\r\n");
const dim = (text: string) => `\x1b[2m${text}\x1b[0m`;
const bold = (text: string) => `\x1b[1m${text}\x1b[0m`;
const dot = (text: string) => `\x1b[36m●\x1b[0m ${text}`;

/* The question: the line after "Question: " in the prompt (any argv word). */
const questionOf = (argv: string[]) =>
  argv
    .find((arg) => arg.includes("Question: "))
    ?.split("Question: ")[1]
    ?.split("\n")[0] ?? "";

function transcript(argv: string[]): string[] {
  const planMode = argv.includes("plan") || argv.includes("read-only") || argv.includes("--plan");
  return [
    `${bold("›")} ${questionOf(argv)}\n`,
    ...(planMode ? [dim("  plan mode · asks before running commands\n")] : []),
    "\n",
    `${dot("Looking at the pods of checkout-api first.")}\n`,
    dim("  $ kubectl get pods -l app=checkout-api\n"),
    "  NAME                            READY   STATUS             RESTARTS   AGE\n",
    "  checkout-api-7qjjhld4s-974t2    1/1     Running            0          3d\n",
    "  checkout-api-7qjjhld4s-trrmk    0/1     \x1b[31mCrashLoopBackOff\x1b[0m   14         3d\n",
    "  checkout-api-7qjjhld4s-pdp99    1/1     Running            0          3d\n",
    "\n",
    `${dot("One pod keeps restarting. Its last run ended like this:")}\n`,
    dim("  $ kubectl describe pod checkout-api-7qjjhld4s-trrmk\n"),
    "  Last State:  Terminated\n",
    "    Reason:    OOMKilled\n",
    "    Exit Code: 137\n",
    "  Limits:      memory: 512Mi\n",
    "\n",
    `${dot("checkout-api runs out of memory: the kernel stops it at its 512Mi limit, about")}\n`,
    "  a minute after it starts. The other two pods are fine, so it's likely one\n",
    "  heavy request, not the image. Raising the limit to 768Mi would stop the\n",
    "  restarts; want me to check the memory use over the last day first?\n",
    "\n",
    `${bold("›")} `,
  ];
}

export function createAiMocks(send: (channel: any, message: unknown) => void) {
  const encoder = new TextEncoder();
  return {
    handlers: {
      ai_find_agents: (p: { programs: string[] }) =>
        p.programs.map((program) => (knob === "none" ? null : INSTALLED[program] ?? null)),
      create_agent_terminal_session: (p: { argv: string[]; onEvent: any }) => {
        const id = `pty-ai-${Math.random().toString(36).slice(2)}`;
        transcript(p.argv).forEach((chunk, index) =>
          setTimeout(() => send(p.onEvent, encoder.encode(CRLF(chunk)).buffer), 150 + index * 45)
        );
        return id;
      },
    } as Record<string, (p: any) => unknown>,
  };
}

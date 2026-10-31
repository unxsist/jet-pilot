/*
 * The AI agent CLIs Ask AI can start (pure, unit tested): how each one
 * starts its interactive session with a first prompt, and its read-only or
 * plan mode, used on clusters that are read-only in JET Pilot. Flags as
 * documented by each agent (checked 2026-10):
 *
 * - Claude Code: `claude "<prompt>"`; `--permission-mode plan` with
 *   `useAutoModeDuringPlan` off, so every command outside its built-in
 *   read-only set asks first (plan mode otherwise lets a classifier
 *   approve them).
 * - Codex: `codex "<prompt>"`; `--sandbox read-only --ask-for-approval
 *   on-request`. The sandbox has no network, so each kubectl call asks to
 *   run outside it.
 * - Gemini CLI: `gemini --prompt-interactive "<prompt>"`. Its plan mode
 *   can't run shell commands at all (no kubectl), so read-only clusters get
 *   `--approval-mode default`: it asks before every command and edit.
 * - OpenCode: `opencode --prompt "<prompt>"`. No read-only flag in its
 *   current TUI; permissions come from the environment: OPENCODE_PERMISSION
 *   (version 1) and OPENCODE_CONFIG_CONTENT (version 2, which version 1
 *   reads but ignores the unknown key of).
 * - GitHub Copilot CLI: `copilot -i "<prompt>"`; `--plan`, which still runs
 *   commands whose effect it can't tell, so kubectl and helm changes are
 *   denied with `--deny-tool`.
 *
 * Plan modes guard the user's files, not the cluster: hence the asking and
 * the denied kubectl / helm changes. The prompt (./prompt.ts) also asks the
 * agent to stay read-only.
 */

export type AgentId = "claude" | "codex" | "gemini" | "opencode" | "copilot" | "custom";

export interface AgentInfo {
  id: Exclude<AgentId, "custom">;
  name: string;
  /** Executable looked up on PATH. */
  program: string;
  /** What it does on read-only clusters, after its name: "starts in plan mode…". */
  readOnlyMode: string;
  /** The install command (npm: the one that works on every platform). */
  install: string;
  url: string;
}

export const AGENTS: readonly AgentInfo[] = [
  {
    id: "claude",
    name: "Claude Code",
    program: "claude",
    readOnlyMode: "starts in plan mode and asks before it runs commands",
    install: "npm install -g @anthropic-ai/claude-code",
    url: "https://code.claude.com/docs/en/setup",
  },
  {
    id: "codex",
    name: "Codex",
    program: "codex",
    readOnlyMode: "starts in its read-only sandbox and asks before it runs commands",
    install: "npm install -g @openai/codex",
    url: "https://github.com/openai/codex",
  },
  {
    id: "gemini",
    name: "Gemini CLI",
    program: "gemini",
    readOnlyMode: "asks before it runs commands or edits files",
    install: "npm install -g @google/gemini-cli",
    url: "https://github.com/google-gemini/gemini-cli",
  },
  {
    id: "opencode",
    name: "OpenCode",
    program: "opencode",
    readOnlyMode: "asks before it runs commands and can't edit files",
    install: "npm install -g @opencode/cli",
    url: "https://opencode.ai/docs/",
  },
  {
    id: "copilot",
    name: "GitHub Copilot CLI",
    program: "copilot",
    readOnlyMode: "starts in plan mode, with kubectl and helm changes turned off",
    install: "npm install -g @github/copilot",
    url: "https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/install-copilot-cli",
  },
];

export const agentInfo = (id: string): AgentInfo | undefined => AGENTS.find((agent) => agent.id === id);


/*
 * Commands that change a cluster, denied where an agent takes deny rules.
 * Matched as a prefix, so flags before the verb slip through: the agent's
 * own asking stays the first line, this list is the second.
 */
const KUBECTL_CHANGES = [
  "annotate",
  "apply",
  "autoscale",
  "certificate",
  "cordon",
  "create",
  "debug",
  "delete",
  "drain",
  "edit",
  "expose",
  "label",
  "patch",
  "replace",
  "rollout pause",
  "rollout restart",
  "rollout resume",
  "rollout undo",
  "run",
  "scale",
  "set",
  "taint",
  "uncordon",
];
const HELM_CHANGES = ["delete", "install", "rollback", "uninstall", "upgrade"];
export const CLUSTER_CHANGES = [
  ...KUBECTL_CHANGES.map((verb) => `kubectl ${verb}`),
  ...HELM_CHANGES.map((verb) => `helm ${verb}`),
];

const OPENCODE_V1_PERMISSION = JSON.stringify({ edit: "deny", bash: "ask" });
const OPENCODE_V2_CONFIG = JSON.stringify({
  permissions: [
    { action: "shell", resource: "*", effect: "ask" },
    { action: "edit", resource: "*", effect: "deny" },
  ],
});

/**
 * Splits a command line into words like a shell would (quotes, and
 * backslashes before a space, quote or backslash, so Windows paths stay
 * intact), without running one: no variables, globs or pipes.
 */
export function splitCommandLine(line: string): string[] {
  const words: string[] = [];
  let word = "";
  let started = false;
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (quote) {
      if (c === quote) quote = null;
      else if (c === "\\" && quote === '"' && (line[i + 1] === '"' || line[i + 1] === "\\")) word += line[++i];
      else word += c;
    } else if (c === '"' || c === "'") {
      quote = c;
      started = true;
    } else if (c === "\\" && /[\s"'\\]/.test(line[i + 1] ?? "")) {
      word += line[++i];
      started = true;
    } else if (/\s/.test(c)) {
      if (started) words.push(word);
      word = "";
      started = false;
    } else {
      word += c;
      started = true;
    }
  }
  if (started) words.push(word);
  return words;
}

export const PROMPT_PLACEHOLDER = "{prompt}";

/** The program a custom command line runs (its first word). */
export const customProgram = (line: string): string => splitCommandLine(line)[0] ?? "";

/** The name of a configured agent; a custom one goes by its program ("aider"). */
export function agentName(id: string, customCommand = ""): string {
  if (id !== "custom") return agentInfo(id)?.name ?? id;
  const program = customProgram(customCommand).split(/[\\/]/).pop()?.replace(/\.(exe|cmd|bat)$/i, "");
  return program || "Your agent";
}

/**
 * Batch-file shims (npm's `claude.cmd` on Windows) pass their arguments
 * through cmd.exe, which ends an argument at a line break, expands
 * `%variables%` and stumbles over quotes: the prompt goes in as one line.
 */
export const isBatchShim = (path: string | null | undefined): boolean => /\.(cmd|bat)$/i.test(path ?? "");

export function oneLine(prompt: string): string {
  return prompt
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join(" ")
    .replace(/"/g, "'")
    .replace(/%/g, " percent");
}

export interface LaunchOptions {
  readOnly: boolean;
  /** Where the program was found (it runs from there). */
  path?: string | null;
  customCommand?: string;
  customReadOnlyCommand?: string;
}

export type Launch = { argv: string[]; env: Record<string, string> } | { error: string };

/** The argv (and environment) that starts `agent` on `prompt`. */
export function agentLaunch(agent: AgentId, prompt: string, options: LaunchOptions): Launch {
  const { readOnly } = options;
  const text = isBatchShim(options.path) ? oneLine(prompt) : prompt;

  if (agent === "custom") {
    const line = (readOnly ? options.customReadOnlyCommand : options.customCommand)?.trim() ?? "";
    if (!line) {
      return {
        error: readOnly
          ? "This cluster is read-only. Add a read-only command for your agent in Settings › AI to use it here."
          : "Add the command that starts your agent in Settings › AI.",
      };
    }
    const words = splitCommandLine(line);
    const argv = words.some((word) => word.includes(PROMPT_PLACEHOLDER))
      ? words.map((word) => word.split(PROMPT_PLACEHOLDER).join(text))
      : [...words, text];
    return { argv, env: {} };
  }

  const info = agentInfo(agent);
  if (!info) return { error: `Unknown agent "${agent}".` };
  const program = options.path || info.program;

  switch (agent) {
    case "claude": {
      // The prompt goes before --disallowedTools, which takes every word after it.
      const argv = readOnly
        ? [
            program,
            text,
            "--permission-mode",
            "plan",
            "--settings",
            JSON.stringify({ useAutoModeDuringPlan: false }),
            "--disallowedTools",
            ...CLUSTER_CHANGES.map((command) => `Bash(${command} *)`),
          ]
        : [program, text];
      return { argv, env: {} };
    }
    case "codex":
      return {
        argv: readOnly
          ? [program, "--sandbox", "read-only", "--ask-for-approval", "on-request", text]
          : [program, text],
        env: {},
      };
    case "gemini":
      return {
        argv: readOnly
          ? [program, "--approval-mode", "default", "--prompt-interactive", text]
          : [program, "--prompt-interactive", text],
        env: {},
      };
    case "opencode":
      return {
        argv: [program, "--prompt", text],
        env: readOnly
          ? { OPENCODE_PERMISSION: OPENCODE_V1_PERMISSION, OPENCODE_CONFIG_CONTENT: OPENCODE_V2_CONFIG }
          : {},
      };
    case "copilot":
      return {
        argv: readOnly
          ? [program, "--plan", ...CLUSTER_CHANGES.map((command) => `--deny-tool=shell(${command})`), "-i", text]
          : [program, "-i", text],
        env: {},
      };
  }
}

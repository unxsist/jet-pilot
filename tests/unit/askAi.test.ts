import { describe, expect, it } from "vitest";
import {
  AGENTS,
  CLUSTER_CHANGES,
  agentLaunch,
  agentName,
  customProgram,
  isBatchShim,
  oneLine,
  splitCommandLine,
} from "@/lib/ai/agents";
import { CLUSTER_QUESTION, composePrompt, namespaceOf, shortSubject } from "@/lib/ai/prompt";
import { describeTab } from "@/lib/tabDescriptors";

const argvOf = (launch: ReturnType<typeof agentLaunch>) => {
  if ("error" in launch) throw new Error(launch.error);
  return launch.argv;
};

describe("Ask AI agents", () => {
  it("starts each agent interactively with the prompt", () => {
    const prompt = "Why?\nBecause.";
    const normal = { readOnly: false };
    expect(argvOf(agentLaunch("claude", prompt, normal))).toEqual(["claude", prompt]);
    expect(argvOf(agentLaunch("codex", prompt, normal))).toEqual(["codex", prompt]);
    expect(argvOf(agentLaunch("gemini", prompt, normal))).toEqual(["gemini", "--prompt-interactive", prompt]);
    expect(argvOf(agentLaunch("opencode", prompt, normal))).toEqual(["opencode", "--prompt", prompt]);
    expect(argvOf(agentLaunch("copilot", prompt, normal))).toEqual(["copilot", "-i", prompt]);
    // Runs from where it was found.
    expect(argvOf(agentLaunch("claude", prompt, { readOnly: false, path: "/opt/bin/claude" }))[0]).toBe(
      "/opt/bin/claude"
    );
  });

  it("starts each agent in its read-only or plan mode on read-only clusters", () => {
    const readOnly = { readOnly: true };

    const claude = argvOf(agentLaunch("claude", "Why?", readOnly));
    // The prompt comes before --disallowedTools, which takes every word after it.
    expect(claude.slice(0, 6)).toEqual([
      "claude",
      "Why?",
      "--permission-mode",
      "plan",
      "--settings",
      '{"useAutoModeDuringPlan":false}',
    ]);
    expect(claude[6]).toBe("--disallowedTools");
    expect(claude).toContain("Bash(kubectl delete *)");
    expect(claude).toContain("Bash(helm upgrade *)");
    expect(claude).toHaveLength(7 + CLUSTER_CHANGES.length);

    expect(argvOf(agentLaunch("codex", "Why?", readOnly))).toEqual([
      "codex",
      "--sandbox",
      "read-only",
      "--ask-for-approval",
      "on-request",
      "Why?",
    ]);
    expect(argvOf(agentLaunch("gemini", "Why?", readOnly))).toEqual([
      "gemini",
      "--approval-mode",
      "default",
      "--prompt-interactive",
      "Why?",
    ]);

    const opencode = agentLaunch("opencode", "Why?", readOnly);
    expect(opencode).toEqual({
      argv: ["opencode", "--prompt", "Why?"],
      env: {
        OPENCODE_PERMISSION: '{"edit":"deny","bash":"ask"}',
        OPENCODE_CONFIG_CONTENT: expect.stringContaining('"action":"shell","resource":"*","effect":"ask"'),
      },
    });

    const copilot = argvOf(agentLaunch("copilot", "Why?", readOnly));
    expect(copilot[1]).toBe("--plan");
    expect(copilot).toContain("--deny-tool=shell(kubectl apply)");
    expect(copilot.slice(-2)).toEqual(["-i", "Why?"]);
  });

  it("keeps the environment empty outside read-only clusters", () => {
    for (const agent of AGENTS) {
      const launch = agentLaunch(agent.id, "Why?", { readOnly: false });
      expect("env" in launch && launch.env, agent.id).toEqual({});
    }
  });

  it("runs custom command lines without a shell", () => {
    expect(splitCommandLine(`my-agent --model "big one" 'it''s' a\\ b {prompt}`)).toEqual([
      "my-agent",
      "--model",
      "big one",
      "its",
      "a b",
      "{prompt}",
    ]);
    expect(splitCommandLine(`  x  ""  "say \\"hi\\""  `)).toEqual(["x", "", 'say "hi"']);
    expect(customProgram("  ~/bin/agent --x")).toBe("~/bin/agent");
    expect(customProgram("C:\\tools\\agent.cmd {prompt}")).toBe("C:\\tools\\agent.cmd");
    expect(customProgram("")).toBe("");

    const options = { readOnly: false, customCommand: "agent --ask={prompt} --fast" };
    expect(argvOf(agentLaunch("custom", "Why; rm -rf /?", options))).toEqual([
      "agent",
      "--ask=Why; rm -rf /?",
      "--fast",
    ]);
    // Without {prompt}: the question goes last.
    expect(argvOf(agentLaunch("custom", "Why?", { readOnly: false, customCommand: "agent -i" }))).toEqual([
      "agent",
      "-i",
      "Why?",
    ]);
  });

  it("uses the custom read-only command on read-only clusters, or refuses", () => {
    const options = { customCommand: "agent {prompt}", customReadOnlyCommand: "agent --plan {prompt}" };
    expect(argvOf(agentLaunch("custom", "Why?", { ...options, readOnly: true }))).toEqual([
      "agent",
      "--plan",
      "Why?",
    ]);
    const refused = agentLaunch("custom", "Why?", { customCommand: "agent", readOnly: true });
    expect("error" in refused && refused.error).toMatch(/read-only command/);
    const empty = agentLaunch("custom", "Why?", { readOnly: false });
    expect("error" in empty && empty.error).toMatch(/Settings › AI/);
  });

  it("names agents, custom ones by their program", () => {
    expect(agentName("claude")).toBe("Claude Code");
    expect(agentName("custom", "/usr/local/bin/aider --yes")).toBe("aider");
    expect(agentName("custom", "C:\\tools\\agent.cmd")).toBe("agent");
    expect(agentName("custom", "")).toBe("Your agent");
  });

  it("passes the prompt to batch-file shims as one plain line", () => {
    expect(isBatchShim("C:\\npm\\claude.CMD")).toBe(true);
    expect(isBatchShim("/usr/bin/claude")).toBe(false);
    expect(isBatchShim(null)).toBe(false);
    expect(oneLine('Why "this"?\n\n- 95% memory\n  next')).toBe("Why 'this'? - 95 percent memory next");
    expect(argvOf(agentLaunch("codex", "a\nb", { readOnly: false, path: "C:\\npm\\codex.cmd" }))).toEqual([
      "C:\\npm\\codex.cmd",
      "a b",
    ]);
  });
});

describe("Ask AI prompt", () => {
  const request = {
    context: "prod-eu-west-1",
    kubeConfig: "/home/me/.kube/config",
    namespace: "shop",
    subject: "checkout-api (Deployment)",
    question: " Why is checkout-api crash looping? ",
  };

  it("starts with the preamble, then the question, then the evidence", () => {
    const prompt = composePrompt(
      { ...request, evidence: ["Back-off restarting failed container api", "Logs:\nline 1\nline 2", " "] },
      { readOnly: false }
    );
    expect(prompt).toBe(
      [
        "You are helping investigate a Kubernetes cluster with kubectl. KUBECONFIG is pinned to context prod-eu-west-1, namespace shop. Investigate read-only; ask before changing anything.",
        "",
        "Question: Why is checkout-api crash looping?",
        "",
        "What JET Pilot already knows about checkout-api (Deployment):",
        "- Back-off restarting failed container api",
        "- Logs:",
        "  line 1",
        "  line 2",
      ].join("\n")
    );
  });

  it("says when the cluster is read-only and leaves out an empty namespace", () => {
    const prompt = composePrompt({ ...request, namespace: "all", question: CLUSTER_QUESTION }, { readOnly: true });
    expect(prompt).toContain("KUBECONFIG is pinned to context prod-eu-west-1. Investigate");
    expect(prompt).toContain("This cluster is read-only in JET Pilot: don't change it.");
    expect(prompt).not.toContain("What JET Pilot already knows");
    expect(namespaceOf("")).toBeNull();
    expect(namespaceOf(undefined)).toBeNull();
    expect(namespaceOf(" web ")).toBe("web");
  });

  it("cuts long evidence, never the question", () => {
    const long = "x".repeat(5000);
    const prompt = composePrompt({ ...request, evidence: Array.from({ length: 10 }, () => long) }, { readOnly: false });
    expect(prompt).toContain("Question: Why is checkout-api crash looping?");
    expect(prompt).toContain("…");
    expect(prompt).toMatch(/- \(\d+ more facts left out\)$/);
    expect(prompt.length).toBeLessThan(10_000);
  });

  it("titles the tab with the subject's name", () => {
    expect(shortSubject("checkout-api (Deployment)")).toBe("checkout-api");
    expect(shortSubject("prod-eu-west-1")).toBe("prod-eu-west-1");
    expect(shortSubject("(Deployment)")).toBe("(Deployment)");
  });

  it("never restores Ask AI tabs on start", () => {
    expect(
      describeTab({
        id: "ask-ai_prod_1",
        title: "Ask AI: checkout-api",
        icon: "shell",
        props: { context: "prod", kubeConfig: "", argv: ["claude", "Why?"], agent: "Claude Code" },
      })
    ).toBeNull();
  });
});

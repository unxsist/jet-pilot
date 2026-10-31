/*
 * The first prompt an agent gets (pure, unit tested): a short preamble on
 * where it is and how to behave, the question, then what JET Pilot already
 * knows. Kept well under what a command line can carry (Windows: 32,767
 * characters): long evidence is cut, never the question.
 */
import type { AskAiRequest } from "./askAi";

/** Room for the evidence; the preamble and question come on top. */
const EVIDENCE_BUDGET = 8000;
const FACT_LIMIT = 1500;

export const OBJECT_QUESTION = (name: string) => `Is anything wrong with ${name}? If so, why?`;
export const CLUSTER_QUESTION =
  "How healthy is this cluster? Look for anything broken or at risk, and explain why.";

/** An empty value or "all" means no namespace (as for terminals). */
export const namespaceOf = (namespace?: string | null): string | null => {
  const value = namespace?.trim() ?? "";
  return value && value !== "all" ? value : null;
};

const cut = (text: string, limit: number) =>
  text.length > limit ? `${text.slice(0, limit - 1).trimEnd()}…` : text;

/** One fact per bullet; later lines of a fact (a log tail) are indented under it. */
function evidenceLines(evidence: string[]): string[] {
  const lines: string[] = [];
  let used = 0;
  const facts = evidence.map((fact) => fact.trim()).filter(Boolean);
  for (const [index, fact] of facts.entries()) {
    const text = cut(fact, FACT_LIMIT);
    if (used + text.length > EVIDENCE_BUDGET) {
      const left = facts.length - index;
      lines.push(`- (${left} more ${left === 1 ? "fact" : "facts"} left out)`);
      break;
    }
    used += text.length;
    lines.push(`- ${text.replace(/\r?\n/g, "\n  ")}`);
  }
  return lines;
}

export function composePrompt(request: AskAiRequest, options: { readOnly: boolean }): string {
  const namespace = namespaceOf(request.namespace);
  const pinned = namespace
    ? `KUBECONFIG is pinned to context ${request.context}, namespace ${namespace}.`
    : `KUBECONFIG is pinned to context ${request.context}.`;
  const preamble = [
    `You are helping investigate a Kubernetes cluster with kubectl. ${pinned} Investigate read-only; ask before changing anything.`,
    ...(options.readOnly
      ? ["This cluster is read-only in JET Pilot: don't change it. Suggest the commands instead."]
      : []),
  ];
  const facts = evidenceLines(request.evidence ?? []);
  return [
    preamble.join("\n"),
    `Question: ${request.question.trim()}`,
    ...(facts.length ? [`What JET Pilot already knows about ${request.subject}:\n${facts.join("\n")}`] : []),
  ].join("\n\n");
}

/** "checkout-api (Deployment)" → "checkout-api", for the tab title. */
export const shortSubject = (subject: string): string => subject.replace(/\s*\([^()]*\)\s*$/, "").trim() || subject;

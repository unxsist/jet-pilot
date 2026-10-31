/*
 * The rules of the Health page's Risks tab: what isn't broken yet but will
 * hurt. Each rule says in one sentence why it matters and how to fix it;
 * findings are grouped by rule ("7 workloads have no memory limit"), not by
 * object. Pure.
 */
import type { StatusTone } from "@/components/ui/status/tones";
import { plural } from "@/lib/resources/format";

export type RiskSection = "expiry" | "drain" | "reliability" | "security" | "unused";
export type RiskSeverity = "high" | "medium" | "low";

export interface RiskRule {
  id: string;
  section: RiskSection;
  severity: RiskSeverity;
  /** "7 workloads have no memory limit". */
  title: (count: number) => string;
  /** Why it matters, in one sentence. */
  why: string;
  /** How to fix it, in one sentence. */
  fix: string;
}

export interface RiskObject {
  kind: string;
  name: string;
  namespace?: string;
  apiVersion?: string;
}

export interface RiskItem {
  rule: string;
  context: string;
  kubeConfig: string;
  object: RiskObject;
  /** What about it, briefly: "api container", "Expires in 5 days". */
  detail?: string;
  /** Copyable bits of the detail (an image, a path) are shown in monospace. */
  code?: string;
  /** Its own tone when items of a rule differ (certificate expiry). */
  tone?: StatusTone;
  /** Sorts items within a rule (soonest expiry first). */
  order?: number;
  /** A fix that is safe to offer on the item itself. */
  action?: "renew" | "add-pdb";
  /** The object as listed, for the side panel and the fix. */
  raw?: any;
}

const has = (count: number, one: string, many: string) => (count === 1 ? one : many);
const workloads = (n: number, one: string, many: string) => `${plural(n, "workload")} ${has(n, one, many)}`;

export const RULES: RiskRule[] = [
  /* ------------------------------------------------------- expiry -- */
  {
    id: "certificate-expiry",
    section: "expiry",
    severity: "high",
    title: (n) => `${plural(n, "certificate")} ${has(n, "needs", "need")} renewing`,
    why: "Clients refuse an expired certificate, so the sites and services behind it stop working.",
    fix: "cert-manager renews its certificates by itself; when it doesn't, renew and check the issuer. Replace other certificates before they expire.",
  },
  {
    id: "client-certificate",
    section: "expiry",
    severity: "high",
    title: (n) => (n === 1 ? "Your kubeconfig certificate expires soon" : `Your kubeconfig certificates of ${n} clusters expire soon`),
    why: "Once it expires, JET Pilot and kubectl can't reach the cluster until you get a new one.",
    fix: "Ask your cluster admin for a new certificate, or create one with your platform's tools.",
  },
  /* -------------------------------------------------------- drain -- */
  {
    id: "pdb-blocks",
    section: "drain",
    severity: "high",
    title: (n) => `${plural(n, "disruption budget")} ${has(n, "allows", "allow")} no evictions`,
    why: "Draining a node with their pods hangs until someone steps in, which stalls node upgrades.",
    fix: "Allow at least one disruption: lower minAvailable or raise maxUnavailable, or run more replicas.",
  },
  {
    id: "bare-pods",
    section: "drain",
    severity: "medium",
    title: (n) => `${plural(n, "pod")} ${has(n, "has", "have")} no controller`,
    why: "A drain deletes them, and nothing starts them again.",
    fix: "Run them from a Deployment, StatefulSet or Job.",
  },
  {
    id: "empty-dir",
    section: "drain",
    severity: "low",
    title: (n) => workloads(n, "keeps data in emptyDir volumes", "keep data in emptyDir volumes"),
    why: "A drain deletes that data together with the pod.",
    fix: "Use a persistent volume for anything that should survive a restart.",
  },
  /* -------------------------------------------------- reliability -- */
  {
    id: "single-replica",
    section: "reliability",
    severity: "medium",
    title: (n) => workloads(n, "runs a single replica in production", "run a single replica in production"),
    why: "A restart, rollout or node drain takes them down.",
    fix: "Run at least two replicas, with a disruption budget.",
  },
  {
    id: "no-pdb",
    section: "reliability",
    severity: "medium",
    title: (n) => workloads(n, "has no disruption budget", "have no disruption budget"),
    why: "A node drain or cluster upgrade can stop all their replicas at once.",
    fix: "Add a PodDisruptionBudget that keeps all but one replica running.",
  },
  {
    id: "no-memory-limit",
    section: "reliability",
    severity: "medium",
    title: (n) => workloads(n, "has no memory limit", "have no memory limit"),
    why: "One leak can take the memory every other pod on the node needs.",
    fix: "Set resources.limits.memory, a little above what the container really uses.",
  },
  {
    id: "no-requests",
    section: "reliability",
    severity: "medium",
    title: (n) => workloads(n, "is missing CPU or memory requests", "are missing CPU or memory requests"),
    why: "The scheduler can't place them well, and they're the first to go when a node runs short.",
    fix: "Set resources.requests for CPU and memory on every container.",
  },
  {
    id: "hpa-no-requests",
    section: "reliability",
    severity: "medium",
    title: (n) => `${plural(n, "autoscaler")} can't measure what ${has(n, "it scales", "they scale")} on`,
    why: "They scale on a share of the requested CPU or memory, and the workload requests none.",
    fix: "Set requests for the resource the autoscaler watches.",
  },
  {
    id: "latest-image",
    section: "reliability",
    severity: "medium",
    title: (n) => workloads(n, "runs a :latest or untagged image", "run a :latest or untagged image"),
    why: "What runs can change without a deploy, and a rollback can't go back to it.",
    fix: "Pin a version tag or a digest.",
  },
  {
    id: "no-readiness",
    section: "reliability",
    severity: "medium",
    title: (n) => workloads(n, "has no readiness probe", "have no readiness probe"),
    why: "Traffic reaches pods before they can serve it, and rollouts can't tell a broken version.",
    fix: "Add a readinessProbe that checks the app can serve requests.",
  },
  {
    id: "no-liveness",
    section: "reliability",
    severity: "low",
    title: (n) => workloads(n, "has no liveness probe", "have no liveness probe"),
    why: "A process that hangs keeps running until someone notices.",
    fix: "Add a livenessProbe that fails only when a restart would help.",
  },
  /* ----------------------------------------------------- security -- */
  {
    id: "privileged",
    section: "security",
    severity: "high",
    title: (n) => workloads(n, "runs privileged containers", "run privileged containers"),
    why: "A privileged container can do anything the node itself can.",
    fix: "Turn privileged off and add only the capabilities it needs.",
  },
  {
    id: "plain-secrets",
    section: "security",
    severity: "medium",
    title: (n) => workloads(n, "has secrets in plain env values", "have secrets in plain env values"),
    why: "Anyone who can read the workload can read them.",
    fix: "Move them to a Secret and use valueFrom.secretKeyRef.",
  },
  {
    id: "host-namespaces",
    section: "security",
    severity: "medium",
    title: (n) => workloads(n, "shares the node's network or processes", "share the node's network or processes"),
    why: "They can see and reach everything on the node.",
    fix: "Turn off hostNetwork, hostPID and hostIPC unless the workload truly needs them.",
  },
  {
    id: "host-path",
    section: "security",
    severity: "medium",
    title: (n) => workloads(n, "mounts directories of the node", "mount directories of the node"),
    why: "They can read or change the node's own files.",
    fix: "Use another volume type than hostPath.",
  },
  {
    id: "capabilities",
    section: "security",
    severity: "medium",
    title: (n) => workloads(n, "adds powerful capabilities", "add powerful capabilities"),
    why: "Each one is part of what root can do on the node.",
    fix: "Drop the capabilities it doesn't need.",
  },
  {
    id: "root",
    section: "security",
    severity: "low",
    title: (n) => workloads(n, "may run as root", "may run as root"),
    why: "Whoever breaks out of the container starts as root.",
    fix: "Set runAsNonRoot: true and a non-zero runAsUser.",
  },
  /* ------------------------------------------------------- unused -- */
  {
    id: "scaled-to-zero",
    section: "unused",
    severity: "low",
    title: (n) => workloads(n, "has been scaled to zero for over a month", "have been scaled to zero for over a month"),
    why: "They still hold config, secrets and sometimes volumes.",
    fix: "Delete them once nobody needs them.",
  },
  {
    id: "service-no-pods",
    section: "unused",
    severity: "low",
    title: (n) => `${plural(n, "service")} ${has(n, "selects", "select")} no pods`,
    why: "Nothing answers behind them: they're left over, or their selector is wrong.",
    fix: "Delete them, or fix the selector to match the pods' labels.",
  },
  {
    id: "unused-claim",
    section: "unused",
    severity: "low",
    title: (n) => `${plural(n, "volume claim")} ${has(n, "isn't", "aren't")} used by any pod`,
    why: "Their volumes keep the data, and usually keep costing money.",
    fix: "Delete them once the data isn't needed, or scale their StatefulSet back up.",
  },
  {
    id: "released-volume",
    section: "unused",
    severity: "low",
    title: (n) => `${plural(n, "volume")} ${has(n, "isn't", "aren't")} claimed`,
    why: "Their storage is still there, and usually still billed.",
    fix: "Delete them once you're sure the data isn't needed.",
  },
];

export const RULE_BY_ID = new Map(RULES.map((rule) => [rule.id, rule]));

export const SECTIONS: { id: RiskSection; title: string }[] = [
  { id: "expiry", title: "Expiring soon" },
  { id: "drain", title: "Drain safety" },
  { id: "reliability", title: "Reliability" },
  { id: "security", title: "Security" },
  { id: "unused", title: "Possibly unused" },
];

export const SEVERITY_TONES: Record<RiskSeverity, StatusTone> = {
  high: "destructive",
  medium: "warning",
  low: "muted",
};

const TONE_RANK: Partial<Record<StatusTone, number>> = { destructive: 0, warning: 1 };

export interface RiskGroup {
  rule: RiskRule;
  items: RiskItem[];
  /** The most urgent tone of its items. */
  tone: StatusTone;
}

export interface RiskSectionGroups {
  id: RiskSection;
  title: string;
  groups: RiskGroup[];
}

/** Findings by section and rule: the most urgent rules first, then the biggest. */
export function groupRisks(items: RiskItem[]): RiskSectionGroups[] {
  const byRule = new Map<string, RiskItem[]>();
  for (const item of items) {
    if (!RULE_BY_ID.has(item.rule)) continue;
    const list = byRule.get(item.rule) ?? [];
    list.push(item);
    byRule.set(item.rule, list);
  }
  const groups: RiskGroup[] = [...byRule.entries()].map(([id, list]) => {
    const rule = RULE_BY_ID.get(id)!;
    const sorted = [...list].sort(
      (a, b) =>
        (a.order ?? 0) - (b.order ?? 0) ||
        (a.object.namespace ?? "").localeCompare(b.object.namespace ?? "") ||
        a.object.name.localeCompare(b.object.name)
    );
    const tones = sorted.map((item) => item.tone ?? SEVERITY_TONES[rule.severity]);
    const tone = tones.sort((a, b) => (TONE_RANK[a] ?? 9) - (TONE_RANK[b] ?? 9))[0] ?? SEVERITY_TONES[rule.severity];
    return { rule, items: sorted, tone };
  });
  const order = (g: RiskGroup) => TONE_RANK[g.tone] ?? 9;
  return SECTIONS.map((section) => ({
    ...section,
    groups: groups
      .filter((g) => g.rule.section === section.id)
      .sort((a, b) => order(a) - order(b) || b.items.length - a.items.length || RULES.indexOf(a.rule) - RULES.indexOf(b.rule)),
  })).filter((section) => section.groups.length);
}

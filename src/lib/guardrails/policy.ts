/*
 * Production guardrails (pure, unit tested): what an action does to a
 * cluster, and what JET Pilot asks before running it there.
 *
 * - Read-only clusters: nothing that changes the cluster runs (mutating and
 *   destructive actions). Viewing, describe, logs, port forwards, shells and
 *   copying files out of a container keep working.
 * - Protected clusters (production): destructive actions, scaling to zero,
 *   Helm upgrades / rollbacks / uninstalls and applying YAML need a typed
 *   confirmation (the resource name, or a count like "3 pods" for several).
 *   Applied YAML always passes a server-side dry run first.
 * - Other clusters: unchanged (the app's own confirmations, where it has
 *   them).
 */
import type { ResolvedCluster } from "@/lib/clusters/meta";

export type ActionKind =
  | "delete"
  | "drain"
  | "cordon"
  | "uncordon"
  | "scale"
  | "scale-to-zero"
  | "restart"
  | "pause"
  | "resume"
  | "rollback"
  | "apply"
  | "create"
  | "replace"
  | "edit-secret"
  | "helm-upgrade"
  | "helm-rollback"
  | "helm-uninstall"
  | "cronjob-trigger"
  | "copy-to-pod"
  | "debug"
  | "node-shell"
  | "exec"
  | "port-forward"
  | "logs"
  | "describe"
  | "view";

/**
 * - read: only looks (logs, describe, YAML)
 * - interactive: a session against the cluster that JET Pilot doesn't
 *   restrict further (shell, port forward)
 * - mutate: changes the cluster
 * - destructive: removes or takes down something
 */
export type ActionEffect = "read" | "interactive" | "mutate" | "destructive";

const EFFECTS: Record<ActionKind, ActionEffect> = {
  delete: "destructive",
  drain: "destructive",
  "scale-to-zero": "destructive",
  "helm-uninstall": "destructive",
  cordon: "mutate",
  uncordon: "mutate",
  scale: "mutate",
  restart: "mutate",
  pause: "mutate",
  resume: "mutate",
  rollback: "mutate",
  apply: "mutate",
  create: "mutate",
  replace: "mutate",
  "edit-secret": "mutate",
  "helm-upgrade": "mutate",
  "helm-rollback": "mutate",
  "cronjob-trigger": "mutate",
  "copy-to-pod": "mutate",
  // An ephemeral container is added to the pod spec.
  debug: "mutate",
  // Creates a privileged pod on the node.
  "node-shell": "mutate",
  exec: "interactive",
  "port-forward": "interactive",
  logs: "read",
  describe: "read",
  view: "read",
};

export const effectOf = (kind: ActionKind): ActionEffect => EFFECTS[kind];

/** The action changes the cluster (blocked on read-only clusters). */
export const changesCluster = (kind: ActionKind): boolean =>
  EFFECTS[kind] === "mutate" || EFFECTS[kind] === "destructive";

/* Applying YAML: always a server-side dry run first on protected clusters. */
const APPLIES = new Set<ActionKind>(["apply", "create", "replace", "edit-secret"]);

/* Typed confirmation on protected clusters. */
const TYPED = new Set<ActionKind>([
  ...(Object.keys(EFFECTS) as ActionKind[]).filter(
    (kind) => EFFECTS[kind] === "destructive"
  ),
  "helm-upgrade",
  "helm-rollback",
  ...APPLIES,
]);

/* Actions the app already confirms with a dialog (or a form) of its own. */
const CONFIRMED = new Set<ActionKind>([
  "delete",
  "drain",
  "cordon",
  "uncordon",
  "scale",
  "scale-to-zero",
  "restart",
  "pause",
  "resume",
  "rollback",
  "helm-upgrade",
  "helm-rollback",
  "helm-uninstall",
  "cronjob-trigger",
  "debug",
  "node-shell",
  "copy-to-pod",
]);

export type GuardedCluster = Pick<
  ResolvedCluster,
  "protected" | "readOnly" | "displayName"
>;

export interface GuardOptions {
  /** Number of targets (bulk actions); more than one asks for "3 pods". */
  count?: number;
  /** Name of the single target: the phrase to type. */
  resourceName?: string;
  /** Kind of the targets ("Pod"), for the count phrase. */
  resourceKind?: string;
}

export interface GuardDecision {
  allowed: boolean;
  /** Why it is not allowed. */
  reason?: string;
  /** "simple": the app's own confirmation; "typed": type `phrase`. */
  confirm: "none" | "simple" | "typed";
  phrase?: string;
  /** Apply only after a passing server-side dry run (no "apply anyway"). */
  requireDryRun: boolean;
}

export const readOnlyReason = (cluster: Pick<ResolvedCluster, "displayName">) =>
  `${cluster.displayName} is read-only in JET Pilot`;

/** Read-only clusters block every action that changes them. */
export const isBlocked = (
  kind: ActionKind,
  cluster: Pick<ResolvedCluster, "readOnly">
): boolean => cluster.readOnly && changesCluster(kind);

/** Scaling to 0 replicas takes the workload down. */
export const scaleKind = (replicas: number): ActionKind =>
  replicas === 0 ? "scale-to-zero" : "scale";

/** "Pod" → "pods", "Ingress" → "ingresses", "NetworkPolicy" → "networkpolicies". */
export function pluralKind(kind: string): string {
  const word = kind.trim().toLowerCase() || "resource";
  if (/(s|x|z|ch|sh)$/.test(word)) return `${word}es`;
  if (/[^aeiou]y$/.test(word)) return `${word.slice(0, -1)}ies`;
  return `${word}s`;
}

/** What to type: the name of one target, "3 pods" for several. */
export function confirmPhrase(
  cluster: Pick<ResolvedCluster, "displayName">,
  opts: GuardOptions = {}
): string {
  const count = opts.count ?? 1;
  if (count > 1) return `${count} ${pluralKind(opts.resourceKind ?? "")}`;
  return opts.resourceName?.trim() || cluster.displayName;
}

/** Surrounding and repeated whitespace doesn't count. */
export const phraseMatches = (input: string, phrase: string): boolean =>
  input.trim().replace(/\s+/g, " ") === phrase.trim().replace(/\s+/g, " ");

export function decide(
  kind: ActionKind,
  cluster: GuardedCluster,
  opts: GuardOptions = {}
): GuardDecision {
  if (isBlocked(kind, cluster)) {
    return {
      allowed: false,
      reason: readOnlyReason(cluster),
      confirm: "none",
      requireDryRun: false,
    };
  }
  if (cluster.protected && TYPED.has(kind)) {
    return {
      allowed: true,
      confirm: "typed",
      phrase: confirmPhrase(cluster, opts),
      requireDryRun: APPLIES.has(kind),
    };
  }
  return {
    allowed: true,
    confirm: CONFIRMED.has(kind) ? "simple" : "none",
    requireDryRun: false,
  };
}

/**
 * One decision for targets on several clusters: a read-only cluster blocks
 * the whole action, a protected one asks for the typed confirmation of all
 * targets.
 */
export function decideMany(
  kind: ActionKind,
  clusters: GuardedCluster[],
  opts: GuardOptions = {}
): GuardDecision {
  const blocked = clusters.find((cluster) => isBlocked(kind, cluster));
  if (blocked) return decide(kind, blocked, opts);
  const strictest =
    clusters.find((cluster) => cluster.protected && TYPED.has(kind)) ??
    clusters[0] ?? { protected: false, readOnly: false, displayName: "" };
  return decide(kind, strictest, opts);
}

/* Button label / verb per action. */
const VERBS: Partial<Record<ActionKind, string>> = {
  "scale-to-zero": "Scale to 0",
  "edit-secret": "Apply",
  replace: "Apply",
  "helm-upgrade": "Upgrade",
  "helm-rollback": "Roll back",
  "helm-uninstall": "Uninstall",
  rollback: "Roll back",
  "cronjob-trigger": "Trigger",
  "copy-to-pod": "Upload",
  "node-shell": "Open node shell",
  "port-forward": "Port forward",
};

export const verbOf = (kind: ActionKind): string =>
  VERBS[kind] ?? kind.charAt(0).toUpperCase() + kind.slice(1);

/*
 * Row action labels → kinds, for row actions without an explicit `kind`
 * (lower-case labels, see lib/actionIcons.ts).
 */
const LABEL_KINDS: Record<string, ActionKind> = {
  "view details": "view",
  details: "view",
  describe: "describe",
  logs: "logs",
  shell: "exec",
  exec: "exec",
  attach: "exec",
  "port forward": "port-forward",
  scale: "scale",
  restart: "restart",
  rollback: "rollback",
  trigger: "cronjob-trigger",
  cordon: "cordon",
  uncordon: "uncordon",
  drain: "drain",
  "pause rollout": "pause",
  "resume rollout": "resume",
  upgrade: "helm-upgrade",
  uninstall: "helm-uninstall",
  debug: "debug",
  "node shell": "node-shell",
  delete: "delete",
  kill: "delete",
  "rollout history": "view",
  history: "view",
};

export const actionKindForLabel = (label: string): ActionKind | undefined =>
  LABEL_KINDS[label.trim().toLowerCase()];

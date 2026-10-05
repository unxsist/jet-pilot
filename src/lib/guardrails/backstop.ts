/*
 * The guardrails' last line of defence: calls that change a cluster
 * (kubectl / helm runs, the backend's apply / replace / delete commands)
 * refuse read-only clusters, also when a code path forgot guard(). Paths
 * that already ran guard() pass `{ guarded: true }`.
 */
import { resolveCluster, type ResolvedCluster } from "@/lib/clusters/meta";
import { runtimeSettings } from "@/lib/settings/runtime";
import { readOnlyReason } from "./policy";

export interface GuardedCall {
  /** The caller ran guard() (or deliberately bypasses it, see DebugShell). */
  guarded?: boolean;
}

/**
 * The cluster metadata the guardrails apply to (live settings: reactive
 * inside computed / render). Without a kubeconfig (rows of the selected
 * kubeconfig may carry "") any record of the context name counts: the
 * guardrails rather apply once too often than not at all.
 */
export function guardedCluster(context: string, kubeConfig?: string): ResolvedCluster {
  return resolveCluster(runtimeSettings()?.clusters, context, kubeConfig || undefined);
}

export class ReadOnlyClusterError extends Error {
  constructor(readonly cluster: Pick<ResolvedCluster, "displayName" | "key">) {
    super(`${readOnlyReason(cluster)}: changes to this cluster are turned off`);
    this.name = "ReadOnlyClusterError";
  }
}

/** Throws a ReadOnlyClusterError for read-only clusters (unless guarded). */
export function assertWritable(
  context: string,
  kubeConfig?: string | null,
  call?: GuardedCall
): void {
  if (call?.guarded) return;
  const cluster = guardedCluster(context, kubeConfig ?? undefined);
  if (cluster.readOnly) throw new ReadOnlyClusterError(cluster);
}

const KUBECTL_MUTATIONS = new Set([
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
  "run",
  "scale",
  "set",
  "taint",
  "uncordon",
]);
const ROLLOUT_MUTATIONS = new Set(["pause", "restart", "resume", "undo"]);
const HELM_MUTATIONS = new Set(["delete", "install", "rollback", "uninstall", "upgrade"]);

/* Flags that take the next argument as their value. */
const VALUE_FLAGS = new Set([
  "--context",
  "--kube-context",
  "--kubeconfig",
  "--namespace",
  "-n",
  "--container",
  "-c",
]);

const positionals = (args: string[]): string[] => {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith("-")) {
      if (VALUE_FLAGS.has(arg)) i++;
      continue;
    }
    out.push(arg);
  }
  return out;
};

const flagValue = (args: string[], name: string): string | undefined => {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === name) return args[i + 1];
    if (args[i].startsWith(`${name}=`)) return args[i].slice(name.length + 1);
  }
  return undefined;
};

/* `kubectl cp` destination in a container: `[namespace/]pod:path` (not `C:\…`). */
const isRemotePath = (path: string | undefined) =>
  !!path && /^[^\\/:]+(\/[^\\/:]+)?:/.test(path) && !/^[a-zA-Z]:[\\/]/.test(path);

/**
 * The cluster a kubectl / helm invocation changes, or null when it only
 * reads (get, logs, diff, template, dry runs, ...) or targets the current
 * context (no `--context`, nothing to check against).
 */
export function cliMutationTarget(
  program: "kubectl" | "helm",
  args: string[]
): { context: string; kubeConfig?: string } | null {
  const [verb, sub, third] = positionals(args);
  const mutates =
    program === "helm"
      ? HELM_MUTATIONS.has(verb)
      : verb === "rollout"
        ? ROLLOUT_MUTATIONS.has(sub)
        : verb === "cp"
          ? isRemotePath(third)
          : KUBECTL_MUTATIONS.has(verb);
  if (!mutates) return null;
  if (args.some((arg) => arg === "--dry-run" || /^--dry-run=(server|client)$/.test(arg))) {
    return null;
  }
  const context = flagValue(args, program === "helm" ? "--kube-context" : "--context");
  if (!context) return null;
  return { context, kubeConfig: flagValue(args, "--kubeconfig") };
}

/** Why a kubectl / helm run must not happen (read-only cluster), else null. */
export function cliRefusal(
  program: "kubectl" | "helm",
  args: string[],
  call?: GuardedCall
): string | null {
  if (call?.guarded) return null;
  const target = cliMutationTarget(program, args);
  if (!target) return null;
  const cluster = guardedCluster(target.context, target.kubeConfig);
  return cluster.readOnly ? new ReadOnlyClusterError(cluster).message : null;
}

/*
 * What counts as a problem on the Health page, and how one reads (pure).
 *
 * Detection (./detect) turns live objects into findings: one per broken
 * pod, node, job, claim or rollout. Grouping (./group) folds the findings
 * of one workload into a single problem ("3 of 3 pods keep crashing"),
 * named after the top owner (Pod → ReplicaSet → Deployment).
 */
import type { StatusTone } from "@/components/ui/status/tones";
import type { ObjectRef } from "@/lib/resources/kinds";

export type ProblemKind =
  | "oom"
  | "crashloop"
  | "config"
  | "image-pull"
  | "cant-start"
  | "pvc-pending"
  | "unschedulable"
  | "stuck-starting"
  | "probe"
  | "create-failed"
  | "rollout-stuck"
  | "job-failed"
  | "cronjob-failed"
  | "node-not-ready"
  | "node-pressure"
  | "pvc-lost"
  | "evicted"
  | "stuck-terminating";

/*
 * Kinds that are the same trouble seen at another moment: a container that
 * sometimes exits with an error and sometimes runs out of memory is one
 * problem, and a snooze covers both.
 */
export type ProblemFamily = "crash" | "config" | "image" | "schedule" | "start" | "probe" | "rollout" | "job" | "node" | "storage" | "evicted" | "terminating";

interface KindInfo {
  tone: Extract<StatusTone, "destructive" | "warning">;
  family: ProblemFamily;
  /** The state in a word or three, like the side panel's state line. */
  label: string;
}

/*
 * In order of precedence: when one workload has several kinds of trouble,
 * the first one names it (the root cause before its symptoms: a claim that
 * can't bind before the pod that can't be scheduled because of it).
 */
export const KINDS: Record<ProblemKind, KindInfo> = {
  oom: { tone: "destructive", family: "crash", label: "Out of memory" },
  crashloop: { tone: "destructive", family: "crash", label: "Keeps crashing" },
  config: { tone: "destructive", family: "config", label: "Configuration error" },
  "image-pull": { tone: "destructive", family: "image", label: "Can't pull the image" },
  "cant-start": { tone: "destructive", family: "crash", label: "Can't start" },
  "pvc-pending": { tone: "warning", family: "storage", label: "Waiting for a volume" },
  unschedulable: { tone: "warning", family: "schedule", label: "Can't be scheduled" },
  "stuck-starting": { tone: "warning", family: "start", label: "Stuck starting" },
  probe: { tone: "warning", family: "probe", label: "Not ready" },
  "create-failed": { tone: "destructive", family: "rollout", label: "Can't create pods" },
  "rollout-stuck": { tone: "destructive", family: "rollout", label: "Rollout stuck" },
  "job-failed": { tone: "destructive", family: "job", label: "Failed" },
  "cronjob-failed": { tone: "destructive", family: "job", label: "Last run failed" },
  "node-not-ready": { tone: "destructive", family: "node", label: "Not ready" },
  "node-pressure": { tone: "warning", family: "node", label: "Under pressure" },
  "pvc-lost": { tone: "destructive", family: "storage", label: "Volume lost" },
  evicted: { tone: "warning", family: "evicted", label: "Evicted" },
  "stuck-terminating": { tone: "warning", family: "terminating", label: "Stuck terminating" },
};

export const KIND_ORDER = Object.keys(KINDS) as ProblemKind[];

/** An object in the cluster, with its uid when known. */
export type Ref = ObjectRef & { uid?: string };

/** One broken thing: a pod, a node, a job, a claim, a rollout. */
export interface Finding {
  kind: ProblemKind;
  object: Ref;
  /** The container it's about (pods). */
  container?: string;
  /** An init container. */
  init?: boolean;
  /** Overrides the kind's label: "Low on disk", "Missing a Secret". */
  label?: string;
  /** What's wrong in a few words, for the list: "Exits with code 1". */
  short: string;
  /** The message Kubernetes gave, as is. */
  message?: string;
  exitCode?: number;
  restarts?: number;
  /** Out of memory: the limit it ran into. */
  memoryLimit?: string;
  /** When it started (epoch ms), from the cluster's own timestamps. */
  since?: number;
  /** When it last happened (epoch ms); unset while it's ongoing. */
  lastSeen?: number;
}

/** A finding with the cluster it was seen in. */
export interface ContextFinding extends Finding {
  context: string;
  kubeConfig: string;
}

/** One item of the Problems list: a workload, node, job or claim in trouble. */
export interface Problem {
  /** Stable across pod restarts and rollouts: the snooze key. */
  fingerprint: string;
  kind: ProblemKind;
  tone: KindInfo["tone"];
  label: string;
  context: string;
  kubeConfig: string;
  namespace?: string;
  /** The top owner: what the problem is named after. */
  subject: Ref;
  /** What's wrong in a few words. */
  short: string;
  /** Every finding, the primary one first. */
  findings: ContextFinding[];
  /** Pods with a problem, and all pods of the subject (pod problems only). */
  pods?: { affected: number; total: number };
  firstSeen?: number;
  lastSeen?: number;
}

export const kindInfo = (kind: ProblemKind) => KINDS[kind];

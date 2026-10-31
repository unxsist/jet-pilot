/*
 * From live objects to the Problems list (pure, unit tested): findings are
 * grouped by the top owner of what they are about (Pod → ReplicaSet →
 * Deployment, Job → CronJob), so one bad rollout is one problem, "3 of 3
 * pods". Claims waiting for a volume join the workload whose pods wait for
 * them. Problems sort by severity, the newest first.
 *
 * Owners are resolved from the lists at hand, without watching
 * ReplicaSets: a Deployment names its ReplicaSets `<deployment>-<pod
 * template hash>`, and the pods carry that hash as a label.
 */
import { ownerOf } from "@/lib/resources/pod";
import { plural } from "@/lib/resources/format";
import { KINDS, KIND_ORDER, type ContextFinding, type Finding, type Problem, type Ref } from "./model";
import {
  claimFindings,
  cronJobFindings,
  deploymentFindings,
  indexEvents,
  jobFindings,
  nodeFindings,
  podClaims,
  podFindings,
  refOf,
  withEvents,
} from "./detect";

/** Everything the Problems list is made of, across contexts (rows tagged with their context). */
export interface ProblemInput {
  pods: any[];
  deployments: any[];
  jobs: any[];
  cronJobs: any[];
  nodes: any[];
  claims: any[];
  /** Warning events, when watched: detail only. */
  events?: any[];
}

const contextOf = (object: any) => ({
  context: object?.metadata?.context ?? "",
  kubeConfig: object?.metadata?.kubeConfig ?? "",
});

const keyOf = (context: string, namespace: string | undefined, kind: string, name: string) =>
  [context, namespace ?? "", kind, name].join("\u0000");

const objectKey = (object: any, kind: string) =>
  keyOf(object?.metadata?.context ?? "", object?.metadata?.namespace, kind, object?.metadata?.name ?? "");

/** Stable across restarts and rollouts: the cluster, the top owner and the kind of trouble. */
export function fingerprintOf(problem: Pick<Problem, "context" | "kubeConfig" | "namespace" | "subject" | "kind">): string {
  return [problem.kubeConfig, problem.context, problem.namespace ?? "", `${problem.subject.kind}/${problem.subject.name}`, KINDS[problem.kind].family].join("|");
}

/** The cluster and namespace a fingerprint belongs to. */
export function fingerprintScope(fingerprint: string): { kubeConfig: string; context: string; namespace: string } {
  const [kubeConfig = "", context = "", namespace = ""] = fingerprint.split("|");
  return { kubeConfig, context, namespace };
}

interface Owners {
  deployments: Map<string, any>;
  jobs: Map<string, any>;
}

/** What a pod's problem is named after: its Deployment, StatefulSet, DaemonSet, CronJob, ... or itself. */
export function topOwner(pod: any, owners: Owners): Ref {
  const owner = ownerOf(pod);
  const context = pod?.metadata?.context ?? "";
  const namespace = pod?.metadata?.namespace || undefined;
  if (!owner) return refOf(pod, "Pod");
  if (owner.kind === "ReplicaSet") {
    const hash = pod.metadata?.labels?.["pod-template-hash"];
    if (hash && owner.name.endsWith(`-${hash}`)) {
      const deployment = owners.deployments.get(keyOf(context, namespace, "Deployment", owner.name.slice(0, -hash.length - 1)));
      if (deployment) return refOf(deployment, "Deployment");
    }
  }
  if (owner.kind === "Job") {
    const job = owners.jobs.get(keyOf(context, namespace, "Job", owner.name));
    const cronJob = job && ownerOf(job);
    if (cronJob?.kind === "CronJob") return { kind: "CronJob", name: cronJob.name, namespace, apiVersion: cronJob.apiVersion };
    if (job) return refOf(job, "Job");
  }
  return { kind: owner.kind, name: owner.name, namespace, apiVersion: owner.apiVersion };
}

/* Pods that hold a place in their workload (not finished, not evicted). */
const isCounted = (pod: any) => pod?.status?.phase !== "Succeeded" && pod?.status?.reason !== "Evicted";

interface Group {
  subject: Ref;
  context: string;
  kubeConfig: string;
  findings: ContextFinding[];
  podTotal?: number;
}

/** The Problems list: one problem per top owner, the most severe and newest first. */
export function detectProblems(input: ProblemInput, now = Date.now(), firstObserved?: (fingerprint: string) => number | undefined): Problem[] {
  const deployments = new Map(input.deployments.map((d) => [objectKey(d, "Deployment"), d]));
  const jobs = new Map(input.jobs.map((j) => [objectKey(j, "Job"), j]));
  const owners = { deployments, jobs };

  const events = new Map<string, ReturnType<typeof indexEvents>>();
  for (const event of input.events ?? []) {
    const context = event.metadata?.context ?? "";
    if (!events.has(context)) events.set(context, indexEvents((input.events ?? []).filter((e) => (e.metadata?.context ?? "") === context)));
  }

  const groups = new Map<string, Group>();
  const add = (subject: Ref, object: any, findings: Finding[]) => {
    if (!findings.length) return;
    const where = contextOf(object);
    const key = keyOf(where.context, subject.namespace, subject.kind, subject.name);
    let group = groups.get(key);
    if (!group) groups.set(key, (group = { subject, ...where, findings: [] }));
    const index = events.get(where.context);
    for (const finding of findings) group.findings.push({ ...(index ? withEvents(finding, index, now) : finding), ...where });
  };

  /* Pods: grouped by top owner, counted per owner for "2 of 3 pods". */
  const podTotals = new Map<string, number>();
  const pendingClaims = new Map<string, Ref>();
  for (const pod of input.pods) {
    const subject = topOwner(pod, owners);
    const key = keyOf(pod.metadata?.context ?? "", subject.namespace, subject.kind, subject.name);
    if (isCounted(pod)) podTotals.set(key, (podTotals.get(key) ?? 0) + 1);
    add(subject, pod, podFindings(pod, now));
    if (pod.status?.phase === "Pending") {
      for (const claim of podClaims(pod)) {
        pendingClaims.set(keyOf(pod.metadata?.context ?? "", pod.metadata?.namespace, "PersistentVolumeClaim", claim), subject);
      }
    }
  }

  for (const deployment of input.deployments) add(refOf(deployment, "Deployment"), deployment, deploymentFindings(deployment));

  /* Jobs of a CronJob are its runs: the CronJob tells about the last one. */
  const runs = new Map<string, any[]>();
  for (const job of input.jobs) {
    const owner = ownerOf(job);
    if (owner?.kind === "CronJob") {
      const key = keyOf(job.metadata?.context ?? "", job.metadata?.namespace, "CronJob", owner.name);
      runs.set(key, [...(runs.get(key) ?? []), job]);
    } else {
      add(refOf(job, "Job"), job, jobFindings(job, now));
    }
  }
  for (const cronJob of input.cronJobs) {
    add(refOf(cronJob, "CronJob"), cronJob, cronJobFindings(cronJob, runs.get(objectKey(cronJob, "CronJob")) ?? [], now));
  }

  for (const node of input.nodes) add(refOf(node, "Node"), node, nodeFindings(node));

  /*
   * A pending claim is the reason its pods wait: it joins their workload.
   * Nobody waiting for it is fine (a storage class that binds on first use).
   */
  for (const claim of input.claims) {
    const findings = claimFindings(claim, now);
    if (!findings.length) continue;
    if (findings[0]!.kind === "pvc-lost") add(refOf(claim, "PersistentVolumeClaim"), claim, findings);
    else {
      const waiting = pendingClaims.get(objectKey(claim, "PersistentVolumeClaim"));
      if (waiting) add(waiting, claim, findings);
    }
  }

  const problems: Problem[] = [];
  for (const [key, group] of groups) {
    const total = podTotals.get(key);
    problems.push(toProblem({ ...group, podTotal: total }, now, firstObserved));
  }
  return problems.sort(compareProblems);
}

const rank = (finding: Finding) => KIND_ORDER.indexOf(finding.kind);

function toProblem(group: Group, now: number, firstObserved?: (fingerprint: string) => number | undefined): Problem {
  const findings = [...group.findings].sort((a, b) => rank(a) - rank(b));
  const primary = findings[0]!;
  const kind = primary.kind;
  const info = KINDS[kind];
  const podFindings = findings.filter((f) => f.object.kind === "Pod");
  const affected = new Set(podFindings.filter((f) => f.kind !== "evicted").map((f) => f.object.name)).size;
  const evicted = new Set(podFindings.filter((f) => f.kind === "evicted").map((f) => f.object.name)).size;
  const base = {
    kind,
    context: group.context,
    kubeConfig: group.kubeConfig,
    namespace: group.subject.namespace,
    subject: group.subject,
  };
  const fingerprint = fingerprintOf(base);
  const since = findings.map((f) => f.since).filter((t): t is number => t !== undefined);
  const observed = firstObserved?.(fingerprint);
  const firstSeen = since.length ? Math.min(...since) : observed;
  const last = findings.map((f) => f.lastSeen).filter((t): t is number => t !== undefined);
  return {
    ...base,
    fingerprint,
    tone: info.tone,
    label: primary.label ?? info.label,
    short: primary.short,
    findings,
    pods:
      group.subject.kind === "Pod" || !podFindings.length
        ? undefined
        : { affected: kind === "evicted" ? evicted : affected, total: kind === "evicted" ? evicted : Math.max(group.podTotal ?? 0, affected) },
    firstSeen: firstSeen !== undefined ? Math.min(firstSeen, now) : undefined,
    lastSeen: last.length ? Math.max(...last) : undefined,
  };
}

/** Severity first, then the problem that started last, then by name. */
export function compareProblems(a: Problem, b: Problem): number {
  if (a.tone !== b.tone) return a.tone === "destructive" ? -1 : 1;
  const started = (b.firstSeen ?? 0) - (a.firstSeen ?? 0);
  if (started) return started;
  return a.subject.name.localeCompare(b.subject.name);
}

/** "2 of 3 pods", "Both pods", "All 3 pods", "4 pods" (evicted); "" for a single pod. */
export function podsWords(problem: Problem): string {
  const pods = problem.pods;
  if (!pods || pods.total <= 1) return "";
  if (problem.kind === "evicted") return plural(pods.affected, "pod");
  if (pods.affected < pods.total) return `${pods.affected} of ${pods.total} pods`;
  return pods.total === 2 ? "Both pods" : `All ${pods.total} pods`;
}

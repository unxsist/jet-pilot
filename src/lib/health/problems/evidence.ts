/*
 * Evidence for one problem, fetched only when its panel asks: the tail of a
 * container's logs, the revisions to roll back to, and the objects
 * involved. Straight from the API (no kubectl).
 */
import { apiPath, kubeGet, kubeRequestText, type KubeTarget } from "@/lib/kubeApi";
import { fetchRef } from "@/lib/resources/open";
import { labelSelectorToString } from "@/lib/workloads";
import { controllerRevisions, deploymentRevisions, type Revision } from "@/lib/rollout";
import { toMs } from "@/lib/resources/format";
import { refOf } from "./detect";
import type { ContextFinding, Problem, Ref } from "./model";

export const kubeTarget = (problem: Pick<Problem, "context" | "kubeConfig">): KubeTarget => ({
  context: problem.context,
  kubeConfig: problem.kubeConfig || undefined,
});

/** The object a problem is named after (a Deployment, a node, ...); null when it's gone. */
export const fetchSubject = (problem: Problem) =>
  fetchRef({ context: problem.context, kubeConfig: problem.kubeConfig }, problem.subject);

/** The finding whose container logs tell the most: a crash with a container, else any with one. */
export function logFinding(problem: Problem): ContextFinding | undefined {
  const withContainer = problem.findings.filter((f) => f.object.kind === "Pod" && f.container);
  return withContainer.find((f) => f.kind === "oom" || f.kind === "crashloop") ?? withContainer.find((f) => f.kind !== "image-pull" && f.kind !== "config");
}

/*
 * The instance that crashed: a container waiting to restart (or running
 * again) left its logs in the previous instance; a terminated one in its own.
 */
export function crashedInstanceIsPrevious(pod: any, container: string): boolean {
  const status = [...(pod?.status?.initContainerStatuses ?? []), ...(pod?.status?.containerStatuses ?? [])].find(
    (c: any) => c.name === container
  );
  return !status?.state?.terminated && !!status?.lastState?.terminated;
}

/** Where a problem's logs are: a pod's container, and whether in its previous instance. */
export interface LogSource {
  pod: Ref;
  container?: string;
  previous: boolean;
}

const newest = (objects: any[]) =>
  [...objects].sort((a, b) => (toMs(b.metadata?.creationTimestamp) ?? 0) - (toMs(a.metadata?.creationTimestamp) ?? 0))[0];

/**
 * The logs that explain a problem: the crashed container's, or for a failed
 * Job (or CronJob run) those of its newest failed pod. `pods` and `jobs`
 * are the live lists; null when no container ever ran.
 */
export function logSource(problem: Problem, pods: any[], jobs: any[]): LogSource | null {
  const inScope = (o: any) => o.metadata?.context === problem.context && (o.metadata?.namespace || undefined) === problem.namespace;
  const finding = logFinding(problem);
  if (finding) {
    const pod = pods.find((p) => inScope(p) && p.metadata?.name === finding.object.name);
    return { pod: finding.object, container: finding.container, previous: !!pod && crashedInstanceIsPrevious(pod, finding.container!) };
  }
  if (problem.kind !== "job-failed" && problem.kind !== "cronjob-failed") return null;
  const ownedBy = (o: any, kind: string, name: string) => (o.metadata?.ownerReferences ?? []).some((r: any) => r.kind === kind && r.name === name);
  const job =
    problem.kind === "job-failed"
      ? problem.subject.name
      : newest(jobs.filter((j) => inScope(j) && ownedBy(j, "CronJob", problem.subject.name)))?.metadata?.name;
  const pod = job && newest(pods.filter((p) => inScope(p) && ownedBy(p, "Job", job)));
  if (!pod) return null;
  const statuses: any[] = [...(pod.status?.initContainerStatuses ?? []), ...(pod.status?.containerStatuses ?? [])];
  const container = statuses.find((c) => (c.state?.terminated?.exitCode ?? 0) !== 0)?.name ?? pod.spec?.containers?.[0]?.name;
  return { pod: refOf(pod, "Pod"), container, previous: false };
}

export const LOG_TAIL_LINES = 40;

/** The last lines of a container's logs (of its previous instance when `previous`). */
export function fetchLogTail(problem: Problem, source: LogSource): Promise<string> {
  const path =
    apiPath({ apiVersion: "v1", resource: "pods", namespace: source.pod.namespace, name: source.pod.name, subresource: "log" }) +
    `?${new URLSearchParams({ ...(source.container ? { container: source.container } : {}), tailLines: String(LOG_TAIL_LINES), ...(source.previous ? { previous: "true" } : {}) })}`;
  return kubeRequestText(kubeTarget(problem), path, { accept: "text/plain" });
}

/** The revisions of a Deployment, StatefulSet or DaemonSet, newest first, with the live object. */
export async function fetchRevisions(problem: Problem, workload: any): Promise<Revision[]> {
  const selector = labelSelectorToString(workload?.spec?.selector);
  const deployment = problem.subject.kind === "Deployment";
  const list = await kubeGet<{ items?: any[] }>(
    kubeTarget(problem),
    apiPath({
      apiVersion: "apps/v1",
      resource: deployment ? "replicasets" : "controllerrevisions",
      namespace: problem.namespace,
      query: selector ? { labelSelector: selector } : undefined,
    })
  );
  return deployment ? deploymentRevisions(workload, list?.items ?? []) : controllerRevisions(workload, list?.items ?? []);
}

/** The revision a rollback goes to: the newest one before the current. */
export const previousRevision = (revisions: Revision[]) => {
  const current = revisions.find((r) => r.current);
  return revisions.find((r) => !r.current && (!current || r.revision < current.revision)) ?? null;
};

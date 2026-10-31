/*
 * Best-practice and drain-safety checks over workloads and their pod
 * templates (Polaris-style), plus the disruption budgets and bare pods that
 * stall a node drain. Pure.
 *
 * System namespaces (kube-system and friends) are left out of the
 * best-practice rules: their workloads belong to the platform, and their
 * owners decide how they run.
 */
import type { RiskItem } from "./rules";

export const SYSTEM_NAMESPACES = new Set(["kube-system", "kube-public", "kube-node-lease"]);

export interface Scope {
  context: string;
  kubeConfig: string;
}

export interface Workload {
  kind: "Deployment" | "StatefulSet" | "DaemonSet" | "CronJob";
  apiVersion: string;
  name: string;
  namespace: string;
  /** Desired replicas; null for DaemonSets and CronJobs. */
  replicas: number | null;
  /** Labels of the pods it creates. */
  podLabels: Record<string, string>;
  spec: any;
  raw: any;
}

export function workloadsOf(lists: {
  deployments?: any[];
  statefulsets?: any[];
  daemonsets?: any[];
  cronjobs?: any[];
}): Workload[] {
  const of = (kind: Workload["kind"], apiVersion: string, list: any[] | undefined, template: (o: any) => any, replicas: (o: any) => number | null) =>
    (list ?? []).map((raw) => ({
      kind,
      apiVersion,
      name: String(raw?.metadata?.name ?? ""),
      namespace: String(raw?.metadata?.namespace ?? ""),
      replicas: replicas(raw),
      podLabels: template(raw)?.metadata?.labels ?? {},
      spec: template(raw)?.spec ?? {},
      raw,
    }));
  const scaled = (o: any) => (typeof o?.spec?.replicas === "number" ? o.spec.replicas : 1);
  return [
    ...of("Deployment", "apps/v1", lists.deployments, (o) => o?.spec?.template, scaled),
    ...of("StatefulSet", "apps/v1", lists.statefulsets, (o) => o?.spec?.template, scaled),
    ...of("DaemonSet", "apps/v1", lists.daemonsets, (o) => o?.spec?.template, () => null),
    ...of("CronJob", "batch/v1", lists.cronjobs, (o) => o?.spec?.jobTemplate?.spec?.template, () => null),
  ];
}

/**
 * Does a label selector (matchLabels / matchExpressions, or a Service's
 * plain map) select these labels? An empty selector selects everything,
 * like a PodDisruptionBudget's; callers rule out empty Service selectors.
 */
export function selects(selector: any, labels: Record<string, string>): boolean {
  if (!selector) return false;
  const plain = !selector.matchLabels && !selector.matchExpressions;
  const matchLabels: Record<string, string> = plain ? selector : selector.matchLabels ?? {};
  const expressions: any[] = plain ? [] : selector.matchExpressions ?? [];
  for (const [key, value] of Object.entries(matchLabels)) if (labels[key] !== value) return false;
  for (const e of expressions) {
    const value = labels[e?.key];
    const values: string[] = e?.values ?? [];
    switch (e?.operator) {
      case "In":
        if (value === undefined || !values.includes(value)) return false;
        break;
      case "NotIn":
        if (value !== undefined && values.includes(value)) return false;
        break;
      case "Exists":
        if (value === undefined) return false;
        break;
      case "DoesNotExist":
        if (value !== undefined) return false;
        break;
    }
  }
  return true;
}

const containersOf = (spec: any): any[] => spec?.containers ?? [];
const allContainersOf = (spec: any): any[] => [...(spec?.initContainers ?? []), ...(spec?.containers ?? [])];

/* "api" for one container, "api and envoy" when several of several. */
function whichContainers(spec: any, matching: any[]): string | undefined {
  if (containersOf(spec).length <= 1) return undefined;
  const names = matching.map((c) => c?.name).filter(Boolean);
  if (!names.length) return undefined;
  const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  return `${list} ${names.length === 1 ? "container" : "containers"}`;
}

const SECRET_NAME = /(PASSWORD|PASSWD|SECRET|TOKEN|API_?KEY|PRIVATE_?KEY|CREDENTIAL)/i;
const POWERFUL = new Set(["ALL", "SYS_ADMIN", "NET_ADMIN", "SYS_PTRACE", "SYS_MODULE", "DAC_READ_SEARCH", "BPF", "PERFMON", "SYS_RAWIO"]);

/** Untagged or ":latest" (digests pin an image whatever the tag says). */
export function floatingImage(image: string): boolean {
  if (!image || image.includes("@")) return false;
  const last = image.slice(image.lastIndexOf("/") + 1);
  const colon = last.lastIndexOf(":");
  return colon < 0 || last.slice(colon + 1) === "latest";
}

/** May the container run as root (no runAsNonRoot, no non-zero user, at either level)? */
export function mayRunAsRoot(pod: any, container: any): boolean {
  const user = container?.securityContext?.runAsUser ?? pod?.securityContext?.runAsUser;
  if (typeof user === "number") return user === 0;
  const nonRoot = container?.securityContext?.runAsNonRoot ?? pod?.securityContext?.runAsNonRoot;
  return nonRoot !== true;
}

interface HpaTarget {
  kind: string;
  name: string;
  namespace: string;
}

const hpaTarget = (hpa: any): HpaTarget => ({
  kind: hpa?.spec?.scaleTargetRef?.kind,
  name: hpa?.spec?.scaleTargetRef?.name,
  namespace: hpa?.metadata?.namespace,
});

const targets = (hpa: any, w: Workload) => {
  const t = hpaTarget(hpa);
  return t.kind === w.kind && t.name === w.name && t.namespace === w.namespace;
};

/* The resources an HPA scales on as a share of requests (no metrics: 80% CPU). */
function utilizationResources(hpa: any): string[] {
  const metrics: any[] = hpa?.spec?.metrics ?? [];
  if (!metrics.length) return ["cpu"];
  const out = new Set<string>();
  for (const m of metrics) {
    const resource = m?.type === "Resource" ? m.resource : m?.type === "ContainerResource" ? m.containerResource : null;
    if (resource?.target?.type === "Utilization" && resource.name) out.add(resource.name);
  }
  return [...out];
}

export interface WorkloadInput extends Scope {
  /** The cluster is production: single replicas count. */
  production: boolean;
  workloads: Workload[];
  pods: any[];
  pdbs: any[];
  hpas: any[];
}

export function workloadRisks(input: WorkloadInput): RiskItem[] {
  const items: RiskItem[] = [];
  const add = (rule: string, w: Workload, extra: Partial<RiskItem> = {}) =>
    items.push({
      rule,
      context: input.context,
      kubeConfig: input.kubeConfig,
      object: { kind: w.kind, name: w.name, namespace: w.namespace, apiVersion: w.apiVersion },
      raw: w.raw,
      ...extra,
    });

  for (const w of input.workloads) {
    if (SYSTEM_NAMESPACES.has(w.namespace)) continue;
    const spec = w.spec;
    const containers = containersOf(spec);
    const serving = w.kind !== "CronJob";
    const hpas = input.hpas.filter((hpa) => targets(hpa, w));
    const minReplicas = Math.max(w.replicas ?? 0, ...hpas.map((hpa) => hpa?.spec?.minReplicas ?? 1));

    const noRequests = containers.filter((c) => !c?.resources?.requests?.cpu || !c?.resources?.requests?.memory);
    if (noRequests.length) add("no-requests", w, { detail: whichContainers(spec, noRequests) });

    const noLimit = containers.filter((c) => !c?.resources?.limits?.memory);
    if (noLimit.length) add("no-memory-limit", w, { detail: whichContainers(spec, noLimit) });

    // Only containers that serve (declare ports) need probes; workers and jobs don't.
    const ported = serving ? containers.filter((c) => (c?.ports ?? []).length) : [];
    const noReadiness = ported.filter((c) => !c?.readinessProbe);
    if (noReadiness.length) add("no-readiness", w, { detail: whichContainers(spec, noReadiness) });
    const noLiveness = ported.filter((c) => !c?.livenessProbe);
    if (noLiveness.length) add("no-liveness", w, { detail: whichContainers(spec, noLiveness) });

    const floating = allContainersOf(spec).map((c) => String(c?.image ?? "")).filter(floatingImage);
    if (floating.length) add("latest-image", w, { code: [...new Set(floating)].join(", ") });

    const scalable = w.kind === "Deployment" || w.kind === "StatefulSet";
    if (scalable && input.production && w.replicas === 1 && minReplicas <= 1) add("single-replica", w);
    if (scalable && minReplicas >= 2) {
      const budget = input.pdbs.some(
        (pdb) => pdb?.metadata?.namespace === w.namespace && selects(pdb?.spec?.selector, w.podLabels)
      );
      if (!budget) add("no-pdb", w, { action: "add-pdb" });
    }

    const privileged = allContainersOf(spec).filter((c) => c?.securityContext?.privileged === true);
    if (privileged.length) add("privileged", w, { detail: whichContainers(spec, privileged) });

    const shared = (["hostNetwork", "hostPID", "hostIPC"] as const).filter((key) => spec?.[key] === true);
    if (shared.length) add("host-namespaces", w, { code: shared.join(", ") });

    const paths = (spec?.volumes ?? []).map((v: any) => v?.hostPath?.path).filter(Boolean);
    if (paths.length) add("host-path", w, { code: paths.join(", ") });

    const caps = new Set<string>();
    for (const c of allContainersOf(spec)) {
      for (const cap of c?.securityContext?.capabilities?.add ?? []) {
        const name = String(cap).toUpperCase().replace(/^CAP_/, "");
        if (POWERFUL.has(name)) caps.add(name);
      }
    }
    if (caps.size) add("capabilities", w, { code: [...caps].join(", ") });

    const root = containers.filter((c) => mayRunAsRoot(spec, c));
    if (root.length) add("root", w, { detail: whichContainers(spec, root) });

    const plain = new Set<string>();
    for (const c of allContainersOf(spec)) {
      for (const env of c?.env ?? []) {
        if (typeof env?.value === "string" && env.value && SECRET_NAME.test(String(env.name ?? ""))) plain.add(env.name);
      }
    }
    if (plain.size) add("plain-secrets", w, { code: [...plain].join(", ") });

    const scratch = (spec?.volumes ?? []).filter((v: any) => v?.emptyDir).map((v: any) => v.name);
    if (scalable && scratch.length && (w.replicas ?? 0) > 0) add("empty-dir", w, { code: scratch.join(", ") });
  }

  for (const hpa of input.hpas) {
    const target = hpaTarget(hpa);
    if (SYSTEM_NAMESPACES.has(target.namespace)) continue;
    const workload = input.workloads.find((w) => targets(hpa, w));
    if (!workload) continue;
    const missing = utilizationResources(hpa).filter((resource) =>
      containersOf(workload.spec).some((c) => !c?.resources?.requests?.[resource])
    );
    if (!missing.length) continue;
    items.push({
      rule: "hpa-no-requests",
      context: input.context,
      kubeConfig: input.kubeConfig,
      object: { kind: "HorizontalPodAutoscaler", name: hpa.metadata?.name, namespace: target.namespace, apiVersion: "autoscaling/v2" },
      detail: `Scales ${workload.name} on ${missing.map((r) => (r === "cpu" ? "CPU" : r)).join(" and ")}`,
      raw: hpa,
    });
  }
  return items;
}

/** A disruption budget that keeps all but one of a workload's replicas running. */
export function disruptionBudgetFor(object: RiskItem["object"], raw: any) {
  return {
    apiVersion: "policy/v1",
    kind: "PodDisruptionBudget",
    metadata: { name: object.name, namespace: object.namespace },
    spec: {
      maxUnavailable: 1,
      selector: raw?.spec?.selector ?? { matchLabels: raw?.spec?.template?.metadata?.labels ?? {} },
    },
  };
}

/** Disruption budgets that allow no evictions, and pods nothing would recreate. */
export function drainRisks(input: Scope & { pdbs: any[]; pods: any[] }): RiskItem[] {
  const items: RiskItem[] = [];
  for (const pdb of input.pdbs) {
    const status = pdb?.status ?? {};
    if (status.disruptionsAllowed !== 0 || !(status.expectedPods > 0)) continue;
    items.push({
      rule: "pdb-blocks",
      context: input.context,
      kubeConfig: input.kubeConfig,
      object: { kind: "PodDisruptionBudget", name: pdb.metadata?.name, namespace: pdb.metadata?.namespace, apiVersion: "policy/v1" },
      detail:
        typeof status.desiredHealthy === "number" && typeof status.currentHealthy === "number"
          ? `Needs ${status.desiredHealthy} healthy ${status.desiredHealthy === 1 ? "pod" : "pods"}, has ${status.currentHealthy}`
          : undefined,
      raw: pdb,
    });
  }
  for (const pod of input.pods) {
    const meta = pod?.metadata ?? {};
    if ((meta.ownerReferences ?? []).length || meta.annotations?.["kubernetes.io/config.mirror"]) continue;
    if (meta.deletionTimestamp || pod?.status?.phase === "Succeeded" || pod?.status?.phase === "Failed") continue;
    items.push({
      rule: "bare-pods",
      context: input.context,
      kubeConfig: input.kubeConfig,
      object: { kind: "Pod", name: meta.name, namespace: meta.namespace, apiVersion: "v1" },
      detail: pod?.spec?.nodeName ? `On ${pod.spec.nodeName}` : undefined,
      raw: pod,
    });
  }
  return items;
}

/**
 * What a drain of these pods (one node's) will run into, in sentences for
 * the Drain confirmation: budgets that allow no evictions, and pods nothing
 * recreates. DaemonSet and mirror pods are skipped, like the drain does.
 */
export function drainBlockers(pods: any[], pdbs: any[]): string[] {
  const evicted = pods.filter((pod) => {
    const meta = pod?.metadata ?? {};
    if (meta.annotations?.["kubernetes.io/config.mirror"] || meta.deletionTimestamp) return false;
    if (pod?.status?.phase === "Succeeded" || pod?.status?.phase === "Failed") return false;
    return !(meta.ownerReferences ?? []).some((ref: any) => ref?.kind === "DaemonSet");
  });
  const lines: string[] = [];
  for (const pdb of pdbs) {
    if (pdb?.status?.disruptionsAllowed !== 0) continue;
    const covered = evicted.some(
      (pod) => pod.metadata?.namespace === pdb.metadata?.namespace && selects(pdb.spec?.selector, pod.metadata?.labels ?? {})
    );
    if (covered) lines.push(`The disruption budget ${pdb.metadata?.name} allows no evictions, so the drain waits until it does.`);
  }
  const bare = evicted.filter((pod) => !(pod.metadata?.ownerReferences ?? []).length).map((pod) => pod.metadata?.name);
  if (bare.length === 1) lines.push(`${bare[0]} has no controller: once evicted, nothing starts it again.`);
  else if (bare.length > 1) lines.push(`${bare.length} pods have no controller: once evicted, nothing starts them again.`);
  return lines;
}

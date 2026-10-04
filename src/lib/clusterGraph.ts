/**
 * Pure model behind the resource graph (cluster overview): which objects
 * relate to which, how healthy they are and which "application" they belong
 * to. No Vue, no IO: everything here is unit tested.
 *
 * buildTopology() indexes the objects once (by uid, kind/namespace/name,
 * owner and labels) and derives the graph in O(n) (plus O(selectors x pods
 * of one label value) for label selectors).
 */
import type { KubernetesObject, V1ObjectMeta } from "@kubernetes/client-node";
import {
  getPodReadiness,
  getPodRestarts,
  getPodStatus,
  getPodStatusTone,
} from "@/components/tables/status";

/* ------------------------------------------------------------ discovery -- */

/** An API resource together with the group it was discovered in. */
export interface DiscoveredResource {
  /** Plural resource name, e.g. "gateways". */
  name: string;
  /** API group, "" for the core group. */
  group: string;
  kind: string;
  /** Cluster-scoped resources (PersistentVolume, StorageClass). */
  namespaced?: boolean;
}

/**
 * Fully-qualified resource name for kubectl ("gateways.networking.istio.io",
 * or just "pods" for the core group). Kinds are not unique across API groups
 * (Istio and Gateway API both define `Gateway`), resource.group is.
 */
export function qualifiedResourceName(resource: DiscoveredResource): string {
  return resource.group ? `${resource.name}.${resource.group}` : resource.name;
}

/** Keeps the first occurrence of every (group, resource) pair. */
export function dedupeResources<T extends DiscoveredResource>(
  resources: T[]
): T[] {
  const seen = new Set<string>();
  return resources.filter((resource) => {
    const key = qualifiedResourceName(resource);
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

/**
 * The resources the graph knows how to relate, as (group, plural name).
 * Everything else is not fetched: the graph is a topology of applications,
 * not a dump of every object in the cluster.
 */
export const GRAPH_RESOURCES: { group: string; name: string }[] = [
  { group: "", name: "pods" },
  { group: "", name: "services" },
  { group: "", name: "configmaps" },
  { group: "", name: "secrets" },
  { group: "", name: "serviceaccounts" },
  { group: "", name: "persistentvolumeclaims" },
  { group: "", name: "persistentvolumes" },
  { group: "", name: "replicationcontrollers" },
  { group: "apps", name: "deployments" },
  { group: "apps", name: "replicasets" },
  { group: "apps", name: "statefulsets" },
  { group: "apps", name: "daemonsets" },
  { group: "batch", name: "jobs" },
  { group: "batch", name: "cronjobs" },
  { group: "networking.k8s.io", name: "ingresses" },
  { group: "networking.k8s.io", name: "networkpolicies" },
  { group: "discovery.k8s.io", name: "endpointslices" },
  { group: "storage.k8s.io", name: "storageclasses" },
  { group: "autoscaling", name: "horizontalpodautoscalers" },
  { group: "policy", name: "poddisruptionbudgets" },
  { group: "gateway.networking.k8s.io", name: "gateways" },
  { group: "gateway.networking.k8s.io", name: "httproutes" },
  { group: "networking.istio.io", name: "virtualservices" },
];

/** The discovered resources the graph fetches, in GRAPH_RESOURCES order. */
export function selectGraphResources<T extends DiscoveredResource>(
  discovered: T[]
): T[] {
  const byKey = new Map(
    discovered.map((resource) => [qualifiedResourceName(resource), resource])
  );
  return GRAPH_RESOURCES.map((wanted) =>
    byKey.get(qualifiedResourceName({ ...wanted, kind: "" }))
  ).filter((resource): resource is T => !!resource);
}

/* ----------------------------------------------------------- utilities -- */

interface OwnedObject {
  metadata?: {
    uid?: string;
    ownerReferences?: { uid: string }[];
  };
}

/**
 * Index objects by the uid of each of their owners, so the children of an
 * object can be looked up in O(1) instead of scanning every object.
 */
export function buildOwnerIndex<T extends OwnedObject>(
  objects: T[]
): Map<string, T[]> {
  const index = new Map<string, T[]>();
  for (const object of objects) {
    for (const owner of object.metadata?.ownerReferences || []) {
      const children = index.get(owner.uid);
      if (children) {
        children.push(object);
      } else {
        index.set(owner.uid, [object]);
      }
    }
  }
  return index;
}

/**
 * Runs `fn` over `items` with at most `limit` calls in flight. Results keep
 * the order of `items`; a rejection is reported as a settled result and does
 * not stop the other items.
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let next = 0;

  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      try {
        results[index] = {
          status: "fulfilled",
          value: await fn(items[index], index),
        };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
    }
  };

  const workers = Array.from(
    { length: Math.max(1, Math.min(limit, items.length)) },
    worker
  );
  await Promise.all(workers);

  return results;
}

/* ---------------------------------------------------------------- model -- */

/** A fetched object; spec / status are read loosely (many kinds). */
export type GraphObject = KubernetesObject & {
  metadata: V1ObjectMeta & { context?: string; kubeConfig?: string };
  spec?: any;
  status?: any;
  [key: string]: any;
};

/**
 * ok / warning (degraded) / error (failing); neutral for objects without a
 * health of their own (ConfigMaps, ServiceAccounts, scaled to zero, ...).
 */
export type Health = "ok" | "warning" | "error" | "neutral";

/** Visual relationship type (one edge style each). */
export type EdgeType = "owns" | "routes" | "selects" | "mounts" | "scales";

/** Column-ish role of a node: drives grouping, filters and the card. */
export type NodeCategory =
  | "traffic"
  | "service"
  | "workload"
  | "replicaset"
  | "job"
  | "pod"
  | "config"
  | "storage"
  | "identity"
  | "policy";

export interface TopoNode {
  /** uid, `missing:<Kind>/<ns>/<name>` or `external:<uid>`. */
  id: string;
  kind: string;
  name: string;
  /** "" for cluster-scoped objects. */
  namespace: string;
  /** null for missing and external nodes. */
  object: GraphObject | null;
  category: NodeCategory;
  /** Referenced but not found (a dangling reference). */
  missing?: boolean;
  /** Owner of loaded objects whose kind is not fetched (e.g. a Rollout). */
  external?: boolean;
  /** Health of the node itself, after roll-up of its pods. */
  health: Health;
  /** Why the node is not ok (human readable). */
  reasons: string[];
  /** Application group id (see AppGroup). */
  group: string;
  /** Collapsible children (ReplicaSet, Job, Pod): the workload root id. */
  parent?: string;
  /** Workload roots: every pod below them. */
  pods?: GraphObject[];
  /** Deployments: current (replicas > 0) and old ReplicaSets. */
  replicaSets?: { active: GraphObject[]; old: GraphObject[] };
  /** CronJobs: their Jobs, newest first. */
  jobs?: GraphObject[];
  /** ReplicaSets without replicas (hidden unless the history is shown). */
  old?: boolean;
  /** Labels used to match label filters (template labels for workloads). */
  labels: Record<string, string>;
}

export interface TopoEdge {
  id: string;
  source: string;
  target: string;
  type: EdgeType;
}

export interface AppGroup {
  /** `<namespace>/<app>`; `<namespace>/~shared`, `~cluster`, ... */
  id: string;
  name: string;
  namespace: string;
  /** app: an application; shared: deps used by several apps; unused: unreferenced config. */
  type: "app" | "shared" | "unused";
  nodeIds: string[];
  health: Health;
}

export interface Topology {
  nodes: Map<string, TopoNode>;
  edges: TopoEdge[];
  groups: Map<string, AppGroup>;
}

export interface TopologyOptions {
  /**
   * Kinds that were loaded successfully. A reference to an object of a kind
   * that was not loaded (e.g. Secrets without RBAC) is not "missing".
   * Defaults to every kind present in `objects`.
   */
  loadedKinds?: Set<string>;
  /** Whether a namespace was fetched (default: every namespace). */
  namespaceInScope?: (namespace: string) => boolean;
}

const HEALTH_RANK: Record<Health, number> = {
  neutral: 0,
  ok: 1,
  warning: 2,
  error: 3,
};

/** The more severe of two health values. */
export function worstHealth(a: Health, b: Health): Health {
  return HEALTH_RANK[a] >= HEALTH_RANK[b] ? a : b;
}

export const isProblem = (health: Health) =>
  health === "warning" || health === "error";

/* Kinds that are the unit of an application (their pods are collapsed). */
const ROOT_KINDS = new Set([
  "Deployment",
  "StatefulSet",
  "DaemonSet",
  "CronJob",
  "ReplicationController",
]);
/* Kinds that are collapsed into the root they are owned by. */
const LINEAGE_KINDS = new Set(["Pod", "ReplicaSet", "Job"]);

/* Config every pod references implicitly: never graphed. */
const IGNORED_CONFIGMAPS = new Set([
  "kube-root-ca.crt",
  "istio-ca-root-cert",
  "openshift-service-ca.crt",
]);
const IGNORED_SECRET_TYPES = new Set([
  "helm.sh/release.v1",
  "kubernetes.io/service-account-token",
]);

const CATEGORY_BY_KIND: Record<string, NodeCategory> = {
  Ingress: "traffic",
  Gateway: "traffic",
  HTTPRoute: "traffic",
  VirtualService: "traffic",
  Service: "service",
  ConfigMap: "config",
  Secret: "config",
  PersistentVolumeClaim: "storage",
  PersistentVolume: "storage",
  StorageClass: "storage",
  ServiceAccount: "identity",
  HorizontalPodAutoscaler: "policy",
  PodDisruptionBudget: "policy",
  NetworkPolicy: "policy",
};

const key = (kind: string, namespace: string, name: string) =>
  `${kind}/${namespace}/${name}`;

const missingId = (kind: string, namespace: string, name: string) =>
  `missing:${key(kind, namespace, name)}`;

const uidOf = (object: GraphObject) =>
  object.metadata.uid ||
  `${object.kind}/${object.metadata.namespace || ""}/${object.metadata.name}`;

const controllerRef = (object: GraphObject) => {
  const refs = object.metadata.ownerReferences || [];
  return refs.find((ref) => ref.controller) || refs[0];
};

/* ------------------------------------------------------------ selectors -- */

export interface LabelSelector {
  matchLabels?: Record<string, string>;
  matchExpressions?: { key: string; operator: string; values?: string[] }[];
}

/** Equality-based selector (Service.spec.selector). Empty selects nothing. */
export function selectorMatches(
  selector: Record<string, string> | undefined | null,
  labels: Record<string, string> | undefined | null
): boolean {
  if (!selector) return false;
  const entries = Object.entries(selector);
  if (entries.length === 0) return false;
  const actual = labels || {};
  return entries.every(([k, v]) => actual[k] === v);
}

/**
 * metav1.LabelSelector. An empty selector matches everything (as for
 * NetworkPolicy / PDB), a missing one nothing.
 */
export function labelSelectorMatches(
  selector: LabelSelector | undefined | null,
  labels: Record<string, string> | undefined | null
): boolean {
  if (!selector) return false;
  const actual = labels || {};
  for (const [k, v] of Object.entries(selector.matchLabels || {})) {
    if (actual[k] !== v) return false;
  }
  for (const expression of selector.matchExpressions || []) {
    const has = Object.prototype.hasOwnProperty.call(actual, expression.key);
    const values = expression.values || [];
    switch (expression.operator) {
      case "In":
        if (!has || !values.includes(actual[expression.key])) return false;
        break;
      case "NotIn":
        if (has && values.includes(actual[expression.key])) return false;
        break;
      case "Exists":
        if (!has) return false;
        break;
      case "DoesNotExist":
        if (has) return false;
        break;
      default:
        return false;
    }
  }
  return true;
}

const isEmptySelector = (selector: LabelSelector | undefined | null) =>
  !selector ||
  (Object.keys(selector.matchLabels || {}).length === 0 &&
    (selector.matchExpressions || []).length === 0);

/**
 * Parses a label filter like `app=web, tier!=db, env` into a predicate.
 * Returns null for an empty filter.
 */
export function parseLabelFilter(
  filter: string
): ((labels: Record<string, string>) => boolean) | null {
  const terms = filter
    .split(",")
    .map((term) => term.trim())
    .filter(Boolean)
    .map((term) => {
      const notEquals = term.split("!=");
      if (notEquals.length === 2) {
        return (labels: Record<string, string>) =>
          labels[notEquals[0].trim()] !== notEquals[1].trim();
      }
      const equals = term.split(/==?/);
      if (equals.length === 2) {
        return (labels: Record<string, string>) =>
          labels[equals[0].trim()] === equals[1].trim();
      }
      const negated = term.startsWith("!");
      const name = negated ? term.slice(1) : term;
      return (labels: Record<string, string>) =>
        negated ? !(name in labels) : name in labels;
    });
  if (terms.length === 0) return null;
  return (labels) => terms.every((term) => term(labels));
}

/* ----------------------------------------------------------- references -- */

export interface ObjectReference {
  kind: "ConfigMap" | "Secret" | "PersistentVolumeClaim" | "ServiceAccount";
  name: string;
  /** optional: true references never dangle. */
  optional: boolean;
}

/** The pod spec of a pod or of a workload's pod template. */
export function podSpecOf(object: GraphObject): any {
  switch (object.kind) {
    case "Pod":
      return object.spec;
    case "CronJob":
      return object.spec?.jobTemplate?.spec?.template?.spec;
    default:
      return object.spec?.template?.spec;
  }
}

/** Pod template labels of a workload (the labels its pods get). */
export function templateLabelsOf(object: GraphObject): Record<string, string> {
  if (object.kind === "Pod") return object.metadata.labels || {};
  if (object.kind === "CronJob") {
    return object.spec?.jobTemplate?.spec?.template?.metadata?.labels || {};
  }
  return object.spec?.template?.metadata?.labels || {};
}

/**
 * ConfigMaps, Secrets, PVCs and the ServiceAccount a pod spec depends on:
 * volumes (incl. projected), env / envFrom of all containers and
 * imagePullSecrets. The implicit `default` ServiceAccount is left out.
 */
export function podSpecReferences(spec: any): ObjectReference[] {
  if (!spec) return [];
  const refs = new Map<string, ObjectReference>();
  const add = (
    kind: ObjectReference["kind"],
    name: string | undefined,
    optional = false
  ) => {
    if (!name) return;
    if (kind === "ConfigMap" && IGNORED_CONFIGMAPS.has(name)) return;
    const id = `${kind}/${name}`;
    const existing = refs.get(id);
    // A reference is only optional when every use of it is optional.
    if (existing) existing.optional = existing.optional && optional;
    else refs.set(id, { kind, name, optional });
  };

  for (const volume of spec.volumes || []) {
    if (volume.configMap) {
      add("ConfigMap", volume.configMap.name, !!volume.configMap.optional);
    }
    if (volume.secret) {
      add("Secret", volume.secret.secretName, !!volume.secret.optional);
    }
    if (volume.persistentVolumeClaim) {
      add("PersistentVolumeClaim", volume.persistentVolumeClaim.claimName);
    }
    for (const source of volume.projected?.sources || []) {
      if (source.configMap) {
        add("ConfigMap", source.configMap.name, !!source.configMap.optional);
      }
      if (source.secret) {
        add("Secret", source.secret.name, !!source.secret.optional);
      }
    }
  }

  const containers = [
    ...(spec.initContainers || []),
    ...(spec.containers || []),
    ...(spec.ephemeralContainers || []),
  ];
  for (const container of containers) {
    for (const envFrom of container.envFrom || []) {
      if (envFrom.configMapRef) {
        add(
          "ConfigMap",
          envFrom.configMapRef.name,
          !!envFrom.configMapRef.optional
        );
      }
      if (envFrom.secretRef) {
        add("Secret", envFrom.secretRef.name, !!envFrom.secretRef.optional);
      }
    }
    for (const env of container.env || []) {
      const from = env.valueFrom;
      if (from?.configMapKeyRef) {
        add(
          "ConfigMap",
          from.configMapKeyRef.name,
          !!from.configMapKeyRef.optional
        );
      }
      if (from?.secretKeyRef) {
        add("Secret", from.secretKeyRef.name, !!from.secretKeyRef.optional);
      }
    }
  }

  for (const pullSecret of spec.imagePullSecrets || []) {
    add("Secret", pullSecret.name);
  }

  const serviceAccount = spec.serviceAccountName || spec.serviceAccount;
  if (serviceAccount && serviceAccount !== "default") {
    add("ServiceAccount", serviceAccount);
  }

  return [...refs.values()];
}

/** Backend Service names of an Ingress (rules + default backend). */
export function ingressBackends(ingress: GraphObject): string[] {
  const names = new Set<string>();
  const addBackend = (backend: any) => {
    const name = backend?.service?.name || backend?.serviceName;
    if (name) names.add(name);
  };
  addBackend(ingress.spec?.defaultBackend || ingress.spec?.backend);
  for (const rule of ingress.spec?.rules || []) {
    for (const path of rule.http?.paths || []) {
      addBackend(path.backend);
    }
  }
  return [...names];
}

/** Hosts an Ingress / HTTPRoute serves. */
export function routeHosts(object: GraphObject): string[] {
  if (object.kind === "Ingress") {
    return [
      ...new Set(
        (object.spec?.rules || [])
          .map((rule: any) => rule.host)
          .filter(Boolean) as string[]
      ),
    ];
  }
  return [...(object.spec?.hostnames || object.spec?.hosts || [])];
}

/* --------------------------------------------------------------- health -- */

export interface HealthResult {
  health: Health;
  reasons: string[];
}

const ok = (): HealthResult => ({ health: "ok", reasons: [] });
const neutral = (reason?: string): HealthResult => ({
  health: "neutral",
  reasons: reason ? [reason] : [],
});

const conditionStatus = (object: GraphObject, type: string) =>
  (object.status?.conditions || []).find((c: any) => c.type === type);

/** Restarts that flag a pod even when it is currently running. */
const RESTART_WARNING_THRESHOLD = 5;

/** Health of a single pod from its status, readiness and restarts. */
export function podHealth(pod: GraphObject): HealthResult {
  const status = getPodStatus(pod as any);
  if (status === "Terminating") {
    return { health: "warning", reasons: ["Terminating"] };
  }
  const tone = getPodStatusTone(status);
  if (tone === "destructive") return { health: "error", reasons: [status] };
  if (tone === "warning") return { health: "warning", reasons: [status] };
  if (tone === "muted") return ok(); // Completed / Succeeded

  const reasons: string[] = [];
  let health: Health = "ok";
  if (status === "Running") {
    const { ready, total } = getPodReadiness(pod as any);
    if (ready < total) {
      health = "warning";
      reasons.push(`${ready}/${total} containers ready`);
    }
  } else if (status === "Failed") {
    return { health: "error", reasons: [status] };
  }
  const restarts = getPodRestarts(pod as any);
  if (restarts >= RESTART_WARNING_THRESHOLD) {
    health = worstHealth(health, "warning");
    reasons.push(`${restarts} restarts`);
  }
  return { health, reasons };
}

/** Desired vs. available replicas of a scalable workload. */
export function replicaCounts(
  object: GraphObject
): { ready: number; desired: number } | null {
  const status = object.status || {};
  switch (object.kind) {
    case "Deployment":
    case "StatefulSet":
    case "ReplicaSet":
    case "ReplicationController":
      return {
        desired: object.spec?.replicas ?? 1,
        ready:
          object.kind === "Deployment"
            ? (status.availableReplicas ?? 0)
            : (status.readyReplicas ?? 0),
      };
    case "DaemonSet":
      return {
        desired: status.desiredNumberScheduled ?? 0,
        ready: status.numberAvailable ?? status.numberReady ?? 0,
      };
    default:
      return null;
  }
}

/** Own health of an object (before pods / references roll up into it). */
export function objectHealth(object: GraphObject): HealthResult {
  const status = object.status || {};
  switch (object.kind) {
    case "Pod":
      return podHealth(object);

    case "Deployment":
    case "StatefulSet":
    case "ReplicaSet":
    case "ReplicationController":
    case "DaemonSet": {
      const counts = replicaCounts(object)!;
      if (counts.desired === 0) return neutral("Scaled to 0");
      const progressing = conditionStatus(object, "Progressing");
      if (progressing?.reason === "ProgressDeadlineExceeded") {
        return {
          health: "error",
          reasons: ["Rollout stuck (progress deadline exceeded)"],
        };
      }
      if (counts.ready === 0) {
        return {
          health: "error",
          reasons: [`0/${counts.desired} replicas available`],
        };
      }
      if (counts.ready < counts.desired) {
        return {
          health: "warning",
          reasons: [`${counts.ready}/${counts.desired} replicas available`],
        };
      }
      return ok();
    }

    case "Job": {
      if (conditionStatus(object, "Failed")?.status === "True") {
        const failed = conditionStatus(object, "Failed");
        return {
          health: "error",
          reasons: [failed?.reason ? `Job failed: ${failed.reason}` : "Job failed"],
        };
      }
      return ok();
    }

    case "CronJob":
      if (object.spec?.suspend) return neutral("Suspended");
      return ok();

    case "PersistentVolumeClaim":
      if (status.phase === "Pending") {
        return { health: "warning", reasons: ["Claim pending"] };
      }
      if (status.phase === "Lost") {
        return { health: "error", reasons: ["Claim lost its volume"] };
      }
      return ok();

    case "PersistentVolume":
      if (status.phase === "Failed") {
        return { health: "error", reasons: ["Volume failed"] };
      }
      if (status.phase === "Released") {
        return neutral("Released");
      }
      return ok();

    case "HorizontalPodAutoscaler": {
      const reasons: string[] = [];
      let health: Health = "ok";
      for (const type of ["AbleToScale", "ScalingActive"]) {
        const condition = conditionStatus(object, type);
        if (condition?.status === "False") {
          health = "warning";
          reasons.push(condition.reason || `${type} is false`);
        }
      }
      const max = object.spec?.maxReplicas;
      if (max && status.currentReplicas >= max) {
        health = "warning";
        reasons.push(`At max replicas (${max})`);
      }
      return { health, reasons };
    }

    case "PodDisruptionBudget":
      if (
        typeof status.currentHealthy === "number" &&
        typeof status.desiredHealthy === "number" &&
        status.currentHealthy < status.desiredHealthy
      ) {
        return {
          health: "warning",
          reasons: [
            `${status.currentHealthy}/${status.desiredHealthy} healthy pods required`,
          ],
        };
      }
      return ok();

    case "Gateway": {
      const programmed = conditionStatus(object, "Programmed");
      if (programmed?.status === "False") {
        return {
          health: "error",
          reasons: [programmed.reason || "Gateway not programmed"],
        };
      }
      return ok();
    }

    case "HTTPRoute": {
      for (const parent of status.parents || []) {
        const accepted = (parent.conditions || []).find(
          (c: any) => c.type === "Accepted"
        );
        if (accepted?.status === "False") {
          return {
            health: "error",
            reasons: [accepted.reason || "Route not accepted"],
          };
        }
      }
      return ok();
    }

    case "Service":
      if (
        object.spec?.type === "LoadBalancer" &&
        !(status.loadBalancer?.ingress || []).length
      ) {
        return { health: "warning", reasons: ["Load balancer pending"] };
      }
      return ok();

    case "Ingress":
      return ok();

    default:
      return neutral();
  }
}

/** Roll the pods of a workload up into its health. */
export function rollUpPods(
  own: HealthResult,
  pods: GraphObject[],
  podHealths: Map<string, HealthResult>
): HealthResult {
  let failing = 0;
  let degraded = 0;
  let active = 0;
  const podReasons = new Map<string, number>();
  for (const pod of pods) {
    // Finished pods of a job do not count against its health.
    if (pod.status?.phase === "Succeeded") continue;
    active++;
    const result = podHealths.get(uidOf(pod)) || podHealth(pod);
    if (result.health === "error") failing++;
    if (result.health === "warning") degraded++;
    if (isProblem(result.health)) {
      for (const reason of result.reasons) {
        podReasons.set(reason, (podReasons.get(reason) || 0) + 1);
      }
    }
  }

  let health = own.health;
  const reasons = [...own.reasons];
  if (failing > 0) {
    health = worstHealth(health, failing === active ? "error" : "warning");
  } else if (degraded > 0) {
    health = worstHealth(health, "warning");
  }
  for (const [reason, count] of podReasons) {
    reasons.push(`${count} pod${count === 1 ? "" : "s"} ${reason}`);
  }
  return { health, reasons };
}

/* ------------------------------------------------------------- grouping -- */

/** Labels / annotations that name the application an object belongs to. */
export function appNameOf(object: GraphObject): string | null {
  const labels = {
    ...templateLabelsOf(object),
    ...(object.metadata.labels || {}),
  };
  return (
    labels["app.kubernetes.io/instance"] ||
    object.metadata.annotations?.["meta.helm.sh/release-name"] ||
    labels["helm.sh/release"] ||
    labels["release"] ||
    labels["app.kubernetes.io/name"] ||
    labels["app"] ||
    labels["k8s-app"] ||
    null
  );
}

const groupId = (namespace: string, name: string) => `${namespace}/${name}`;
export const SHARED_GROUP = "~shared";
export const UNUSED_GROUP = "~unused";
export const CLUSTER_NAMESPACE = "~cluster";

/* --------------------------------------------------------------- build -- */

/**
 * Builds the graph: nodes (workload roots with their pods collapsed,
 * traffic, config, storage and policy objects, dangling references), typed
 * edges, health and application groups.
 */
export function buildTopology(
  objects: GraphObject[],
  options: TopologyOptions = {}
): Topology {
  const loadedKinds =
    options.loadedKinds || new Set(objects.map((object) => object.kind || ""));
  const inScope = options.namespaceInScope || (() => true);

  /* ---- indexes (one pass) ---- */
  const byUid = new Map<string, GraphObject>();
  const byKey = new Map<string, GraphObject>();
  const byKind = new Map<string, GraphObject[]>();
  /* pods per namespace + label pair, for selector lookups */
  const podsByLabel = new Map<string, GraphObject[]>();
  const podsByNamespace = new Map<string, GraphObject[]>();
  /* workload roots per namespace + template label pair (scaled to 0) */
  const rootsByLabel = new Map<string, GraphObject[]>();
  const slicesByService = new Map<string, GraphObject[]>();

  for (const object of objects) {
    if (!object.metadata || !object.kind) continue;
    if (
      object.kind === "Secret" &&
      IGNORED_SECRET_TYPES.has(object.type || "")
    ) {
      continue;
    }
    if (
      object.kind === "ConfigMap" &&
      IGNORED_CONFIGMAPS.has(object.metadata.name || "")
    ) {
      continue;
    }
    const namespace = object.metadata.namespace || "";
    byUid.set(uidOf(object), object);
    byKey.set(key(object.kind, namespace, object.metadata.name || ""), object);
    const list = byKind.get(object.kind);
    if (list) list.push(object);
    else byKind.set(object.kind, [object]);

    if (object.kind === "Pod") {
      push(podsByNamespace, namespace, object);
      for (const [k, v] of Object.entries(object.metadata.labels || {})) {
        push(podsByLabel, `${namespace}\0${k}=${v}`, object);
      }
    } else if (ROOT_KINDS.has(object.kind)) {
      for (const [k, v] of Object.entries(templateLabelsOf(object))) {
        push(rootsByLabel, `${namespace}\0${k}=${v}`, object);
      }
    } else if (object.kind === "EndpointSlice") {
      const service =
        object.metadata.labels?.["kubernetes.io/service-name"] || "";
      if (service) push(slicesByService, `${namespace}/${service}`, object);
    }
  }

  const kindList = (kind: string) => byKind.get(kind) || [];

  /** Pods a label predicate selects, using the rarest-first label index. */
  const selectPods = (
    namespace: string,
    pairs: [string, string][],
    matches: (labels: Record<string, string>) => boolean
  ): GraphObject[] => {
    let candidates: GraphObject[] | undefined;
    for (const [k, v] of pairs) {
      const list = podsByLabel.get(`${namespace}\0${k}=${v}`) || [];
      if (!candidates || list.length < candidates.length) candidates = list;
    }
    candidates = candidates ?? podsByNamespace.get(namespace) ?? [];
    return candidates.filter((pod) => matches(pod.metadata.labels || {}));
  };
  const selectTemplates = (
    namespace: string,
    pairs: [string, string][],
    matches: (labels: Record<string, string>) => boolean
  ): GraphObject[] => {
    if (pairs.length === 0) return [];
    const [k, v] = pairs[0];
    return (rootsByLabel.get(`${namespace}\0${k}=${v}`) || []).filter(
      (root) => matches(templateLabelsOf(root))
    );
  };

  /* ---- nodes ---- */
  const nodes = new Map<string, TopoNode>();
  const edges = new Map<string, TopoEdge>();
  const addEdge = (source: string, target: string, type: EdgeType) => {
    if (source === target) return;
    const id = `${type}:${source}->${target}`;
    if (!edges.has(id)) edges.set(id, { id, source, target, type });
  };

  const addNode = (
    object: GraphObject,
    category: NodeCategory,
    extra: Partial<TopoNode> = {}
  ): TopoNode => {
    const id = uidOf(object);
    const node: TopoNode = {
      id,
      kind: object.kind || "",
      name: object.metadata.name || "",
      namespace: object.metadata.namespace || "",
      object,
      category,
      health: "neutral",
      reasons: [],
      group: "",
      labels: object.metadata.labels || {},
      ...extra,
    };
    nodes.set(id, node);
    return node;
  };

  /** A dangling reference: shown as a red dashed node. */
  const missingNode = (
    kind: string,
    namespace: string,
    name: string
  ): TopoNode => {
    const id = missingId(kind, namespace, name);
    let node = nodes.get(id);
    if (!node) {
      node = {
        id,
        kind,
        name,
        namespace,
        object: null,
        category: CATEGORY_BY_KIND[kind] || "workload",
        missing: true,
        health: "error",
        reasons: [`${kind} "${name}" does not exist`],
        group: "",
        labels: {},
      };
      nodes.set(id, node);
    }
    return node;
  };

  /** Can a reference to kind/namespace be judged as dangling? */
  const canBeMissing = (kind: string, namespace: string) =>
    loadedKinds.has(kind) && inScope(namespace);

  /* Workload roots: follow controller references up to a root kind. */
  const rootIds = new Map<string, string>();
  const externalRoots = new Map<string, TopoNode>();
  const rootIdOf = (object: GraphObject, depth = 0): string => {
    const uid = uidOf(object);
    const cached = rootIds.get(uid);
    if (cached) return cached;
    let root = uid;
    if (!ROOT_KINDS.has(object.kind || "") && depth < 8) {
      const ref = controllerRef(object);
      if (ref && ref.kind !== "Node") {
        const owner = byUid.get(ref.uid);
        if (owner) {
          root = rootIdOf(owner, depth + 1);
        } else {
          // Owner of a kind the graph does not fetch (Rollout, a CRD, ...).
          root = `external:${ref.uid}`;
          if (!externalRoots.has(root)) {
            externalRoots.set(root, {
              id: root,
              kind: ref.kind,
              name: ref.name,
              namespace: object.metadata.namespace || "",
              object: null,
              category: "workload",
              external: true,
              health: "neutral",
              reasons: [],
              group: "",
              labels: {},
            });
          }
        }
      }
    }
    rootIds.set(uid, root);
    return root;
  };

  const lineage: GraphObject[] = [];
  for (const kind of [...ROOT_KINDS, ...LINEAGE_KINDS]) {
    for (const object of kindList(kind)) lineage.push(object);
  }

  const rootNodes = new Map<string, TopoNode>();
  for (const object of lineage) {
    const rootId = rootIdOf(object);
    if (rootId === uidOf(object)) {
      const node = addNode(object, "workload", {
        pods: [],
        labels: { ...templateLabelsOf(object), ...(object.metadata.labels || {}) },
      });
      rootNodes.set(rootId, node);
    }
  }
  for (const [id, node] of externalRoots) {
    node.pods = [];
    nodes.set(id, node);
    rootNodes.set(id, node);
  }

  /* Collapsible children (ReplicaSets, Jobs, Pods) and ownership edges. */
  for (const object of lineage) {
    const id = uidOf(object);
    const rootId = rootIds.get(id)!;
    const root = rootNodes.get(rootId)!;
    if (object.kind === "Pod") root.pods!.push(object);
    if (rootId === id) continue;

    const category: NodeCategory =
      object.kind === "Pod"
        ? "pod"
        : object.kind === "ReplicaSet"
          ? "replicaset"
          : "job";
    const isOld =
      object.kind === "ReplicaSet" &&
      (object.spec?.replicas ?? 0) === 0 &&
      (object.status?.replicas ?? 0) === 0;
    addNode(object, category, { parent: rootId, old: isOld || undefined });

    if (object.kind === "ReplicaSet") {
      root.replicaSets = root.replicaSets || { active: [], old: [] };
      (isOld ? root.replicaSets.old : root.replicaSets.active).push(object);
    }
    if (object.kind === "Job") {
      root.jobs = root.jobs || [];
      root.jobs.push(object);
    }

    const ref = controllerRef(object);
    if (ref) {
      const owner = byUid.get(ref.uid);
      addEdge(owner ? uidOf(owner) : rootId, id, "owns");
    }
  }
  for (const root of rootNodes.values()) {
    root.jobs?.sort((a, b) =>
      String(b.metadata.creationTimestamp || "").localeCompare(
        String(a.metadata.creationTimestamp || "")
      )
    );
  }

  /* Other graphed objects. */
  for (const [kind, category] of Object.entries(CATEGORY_BY_KIND)) {
    for (const object of kindList(kind)) addNode(object, category);
  }

  /* ---- relationships ---- */

  /** Workload roots (deduped) of a set of pods. */
  const rootsOfPods = (pods: GraphObject[]) => [
    ...new Set(pods.map((pod) => rootIds.get(uidOf(pod))!)),
  ];

  /* Service -> workloads (traffic), plus endpoints for health. */
  const serviceReadyEndpoints = new Map<string, number | null>();
  for (const service of kindList("Service")) {
    const namespace = service.metadata.namespace || "";
    const selector: Record<string, string> = service.spec?.selector || {};
    const pairs = Object.entries(selector) as [string, string][];
    const serviceId = uidOf(service);
    if (pairs.length === 0) {
      // No selector: endpoints are managed elsewhere (EndpointSlices).
      const slices = slicesByService.get(
        `${namespace}/${service.metadata.name}`
      );
      serviceReadyEndpoints.set(
        serviceId,
        slices
          ? slices.reduce(
              (sum, slice) =>
                sum +
                (slice.endpoints || []).filter(
                  (e: any) => e.conditions?.ready !== false
                ).length,
              0
            )
          : null
      );
      continue;
    }
    const matches = (labels: Record<string, string>) =>
      selectorMatches(selector, labels);
    const pods = selectPods(namespace, pairs, matches);
    const ready = pods.filter(
      (pod) =>
        !pod.metadata.deletionTimestamp &&
        (pod.status?.conditions || []).some(
          (c: any) => c.type === "Ready" && c.status === "True"
        )
    ).length;
    serviceReadyEndpoints.set(serviceId, ready);
    const targets = new Set(rootsOfPods(pods));
    for (const root of selectTemplates(namespace, pairs, matches)) {
      targets.add(uidOf(root));
    }
    for (const target of targets) addEdge(serviceId, target, "routes");
  }

  /** Service node id for a reference, or a missing node. */
  const serviceTarget = (
    namespace: string,
    name: string
  ): string | null => {
    const service = byKey.get(key("Service", namespace, name));
    if (service) return uidOf(service);
    if (!canBeMissing("Service", namespace)) return null;
    return missingNode("Service", namespace, name).id;
  };

  /* Ingress -> Service (+ TLS secrets). */
  for (const ingress of kindList("Ingress")) {
    const namespace = ingress.metadata.namespace || "";
    const id = uidOf(ingress);
    for (const name of ingressBackends(ingress)) {
      const target = serviceTarget(namespace, name);
      if (target) addEdge(id, target, "routes");
    }
    for (const tls of ingress.spec?.tls || []) {
      if (!tls.secretName) continue;
      const secret = byKey.get(key("Secret", namespace, tls.secretName));
      if (secret) addEdge(id, uidOf(secret), "mounts");
      else if (canBeMissing("Secret", namespace)) {
        addEdge(id, missingNode("Secret", namespace, tls.secretName).id, "mounts");
      }
    }
  }

  /* Gateway API: Gateway -> HTTPRoute -> Service. */
  for (const route of kindList("HTTPRoute")) {
    const namespace = route.metadata.namespace || "";
    const id = uidOf(route);
    for (const parent of route.spec?.parentRefs || []) {
      if ((parent.kind || "Gateway") !== "Gateway") continue;
      const gatewayNamespace = parent.namespace || namespace;
      const gateway = byKey.get(key("Gateway", gatewayNamespace, parent.name));
      if (gateway) addEdge(uidOf(gateway), id, "routes");
      else if (canBeMissing("Gateway", gatewayNamespace)) {
        addEdge(
          missingNode("Gateway", gatewayNamespace, parent.name).id,
          id,
          "routes"
        );
      }
    }
    for (const rule of route.spec?.rules || []) {
      for (const backend of rule.backendRefs || []) {
        if ((backend.kind || "Service") !== "Service" || backend.group) continue;
        const target = serviceTarget(backend.namespace || namespace, backend.name);
        if (target) addEdge(id, target, "routes");
      }
    }
  }

  /* Istio VirtualService -> Service (short or FQDN hosts). */
  for (const virtualService of kindList("VirtualService")) {
    const namespace = virtualService.metadata.namespace || "";
    const id = uidOf(virtualService);
    for (const http of virtualService.spec?.http || []) {
      for (const route of http.route || []) {
        const host: string = route.destination?.host || "";
        if (!host) continue;
        const [name, hostNamespace] = host.split(".");
        const service = byKey.get(
          key("Service", hostNamespace || namespace, name)
        );
        if (service) addEdge(id, uidOf(service), "routes");
      }
    }
  }

  /* Workloads -> ConfigMaps / Secrets / PVCs / ServiceAccounts. */
  const missingRefsOf = new Map<string, string[]>();
  for (const root of rootNodes.values()) {
    const namespace = root.namespace;
    /*
     * The pod template is what the workload declares: its references are
     * judged (dangling or not). Running pods add what was injected or is
     * per replica (StatefulSet claims), as edges only: injected references
     * (e.g. legacy token secrets) are not the workload's to fix.
     */
    const template = root.object ? podSpecOf(root.object) : null;
    const declared = new Map<string, ObjectReference>();
    for (const ref of podSpecReferences(template)) {
      declared.set(`${ref.kind}/${ref.name}`, ref);
    }
    const observed = new Map<string, ObjectReference>();
    for (const pod of root.pods || []) {
      for (const ref of podSpecReferences(pod.spec)) {
        observed.set(`${ref.kind}/${ref.name}`, ref);
      }
    }
    // Workloads without a template (external roots, bare pods) declare
    // what their pods use.
    const judged = template ? declared : observed;
    for (const [id, ref] of observed) {
      const target = byKey.get(key(ref.kind, namespace, ref.name));
      if (target && !judged.has(id)) {
        addEdge(root.id, uidOf(target), "mounts");
      }
    }
    if (root.kind === "StatefulSet" && root.object) {
      // Claims of volumeClaimTemplates: <template>-<statefulset>-<ordinal>.
      const replicas = root.object.spec?.replicas ?? 1;
      for (const claimTemplate of root.object.spec?.volumeClaimTemplates || []) {
        for (let ordinal = 0; ordinal < replicas; ordinal++) {
          const claim = byKey.get(
            key(
              "PersistentVolumeClaim",
              namespace,
              `${claimTemplate.metadata?.name}-${root.name}-${ordinal}`
            )
          );
          if (claim) addEdge(root.id, uidOf(claim), "mounts");
        }
      }
    }
    for (const ref of judged.values()) {
      const target = byKey.get(key(ref.kind, namespace, ref.name));
      if (target) {
        addEdge(root.id, uidOf(target), "mounts");
      } else if (!ref.optional && canBeMissing(ref.kind, namespace)) {
        addEdge(root.id, missingNode(ref.kind, namespace, ref.name).id, "mounts");
        const list = missingRefsOf.get(root.id) || [];
        list.push(`References missing ${ref.kind} "${ref.name}"`);
        missingRefsOf.set(root.id, list);
      }
    }
  }

  /* PVC -> PV -> StorageClass. */
  for (const claim of kindList("PersistentVolumeClaim")) {
    const id = uidOf(claim);
    const volumeName = claim.spec?.volumeName;
    const volume = volumeName
      ? byKey.get(key("PersistentVolume", "", volumeName))
      : undefined;
    if (volume) {
      addEdge(id, uidOf(volume), "mounts");
    } else {
      const storageClass = claim.spec?.storageClassName;
      const sc = storageClass
        ? byKey.get(key("StorageClass", "", storageClass))
        : undefined;
      if (sc) addEdge(id, uidOf(sc), "mounts");
    }
  }
  for (const volume of kindList("PersistentVolume")) {
    const storageClass = volume.spec?.storageClassName;
    const sc = storageClass
      ? byKey.get(key("StorageClass", "", storageClass))
      : undefined;
    if (sc) addEdge(uidOf(volume), uidOf(sc), "mounts");
  }

  /* HPA -> scale target. */
  const hpaReasons = new Map<string, string[]>();
  for (const hpa of kindList("HorizontalPodAutoscaler")) {
    const namespace = hpa.metadata.namespace || "";
    const ref = hpa.spec?.scaleTargetRef;
    if (!ref?.name || !ref.kind) continue;
    const target = byKey.get(key(ref.kind, namespace, ref.name));
    if (target) {
      addEdge(uidOf(hpa), rootIds.get(uidOf(target)) || uidOf(target), "scales");
    } else if (canBeMissing(ref.kind, namespace)) {
      addEdge(uidOf(hpa), missingNode(ref.kind, namespace, ref.name).id, "scales");
      hpaReasons.set(uidOf(hpa), [
        `Scale target ${ref.kind} "${ref.name}" does not exist`,
      ]);
    }
  }

  /* PDB / NetworkPolicy -> selected workloads. */
  const selectRoots = (namespace: string, selector: LabelSelector) => {
    const pairs = Object.entries(selector.matchLabels || {}) as [
      string,
      string,
    ][];
    const matches = (labels: Record<string, string>) =>
      labelSelectorMatches(selector, labels);
    const targets = new Set(rootsOfPods(selectPods(namespace, pairs, matches)));
    for (const root of selectTemplates(namespace, pairs, matches)) {
      targets.add(uidOf(root));
    }
    return targets;
  };
  for (const pdb of kindList("PodDisruptionBudget")) {
    const selector = pdb.spec?.selector;
    if (isEmptySelector(selector)) continue;
    for (const target of selectRoots(pdb.metadata.namespace || "", selector)) {
      addEdge(uidOf(pdb), target, "selects");
    }
  }
  for (const policy of kindList("NetworkPolicy")) {
    const selector = policy.spec?.podSelector;
    // An empty podSelector applies to the whole namespace: no edges.
    if (isEmptySelector(selector)) continue;
    for (const target of selectRoots(
      policy.metadata.namespace || "",
      selector
    )) {
      addEdge(uidOf(policy), target, "selects");
    }
  }

  const edgeList = [...edges.values()];
  const outgoing = new Map<string, TopoEdge[]>();
  const incoming = new Map<string, TopoEdge[]>();
  for (const edge of edgeList) {
    push(outgoing, edge.source, edge);
    push(incoming, edge.target, edge);
  }

  /* ---- health ---- */
  const podHealths = new Map<string, HealthResult>();
  for (const node of nodes.values()) {
    if (node.missing || !node.object) continue;
    const result = objectHealth(node.object);
    if (node.kind === "Pod") podHealths.set(node.id, result);
    node.health = result.health;
    node.reasons = result.reasons;
  }
  const isComplete = (job: GraphObject) =>
    conditionStatus(job, "Complete")?.status === "True";
  for (const root of rootNodes.values()) {
    let result: HealthResult;
    if (root.kind === "Pod" && root.object) {
      result = podHealths.get(root.id) || podHealth(root.object);
    } else if (root.kind === "CronJob") {
      // Only the latest run counts: older failures are history.
      const last = root.jobs?.[0];
      result = { health: root.health, reasons: [...root.reasons] };
      if (last) {
        const lastHealth = objectHealth(last);
        if (lastHealth.health === "error") {
          result = {
            health: "error",
            reasons: [...result.reasons, "Last run failed"],
          };
        } else if (!isComplete(last)) {
          const lastPods = (root.pods || []).filter(
            (pod) => controllerRef(pod)?.uid === last.metadata.uid
          );
          result = rollUpPods(result, lastPods, podHealths);
        }
      }
    } else if (root.kind === "Job" && root.object && isComplete(root.object)) {
      result = { health: root.health, reasons: root.reasons };
    } else if (root.external && (root.pods || []).length === 0) {
      result = { health: "neutral", reasons: [] };
    } else {
      const own: HealthResult = root.object
        ? { health: root.health, reasons: root.reasons }
        : { health: "ok", reasons: [] };
      result = rollUpPods(own, root.pods || [], podHealths);
    }
    const missing = missingRefsOf.get(root.id);
    if (missing) {
      result = {
        health: worstHealth(result.health, "warning"),
        reasons: [...result.reasons, ...missing],
      };
    }
    root.health = result.health;
    root.reasons = result.reasons;
  }
  for (const [id, reasons] of hpaReasons) {
    const node = nodes.get(id)!;
    node.health = "error";
    node.reasons = [...reasons, ...node.reasons];
  }
  for (const service of kindList("Service")) {
    const node = nodes.get(uidOf(service))!;
    const ready = serviceReadyEndpoints.get(node.id);
    if (service.spec?.type === "ExternalName") continue;
    if (ready === 0) {
      const hasSelector = Object.keys(service.spec?.selector || {}).length > 0;
      const selected = (outgoing.get(node.id) || []).length > 0;
      node.health = "error";
      node.reasons = [
        hasSelector && !selected
          ? "Selector matches no pods"
          : "No ready endpoints",
        ...node.reasons,
      ];
    } else if (ready === null && node.health === "ok") {
      node.health = "neutral";
    }
  }
  /* Traffic objects inherit trouble of their backends. */
  for (const kind of ["HTTPRoute", "VirtualService", "Ingress", "Gateway"]) {
    for (const object of kindList(kind)) {
      const node = nodes.get(uidOf(object))!;
      const backends = (outgoing.get(node.id) || [])
        .filter((edge) => edge.type === "routes")
        .map((edge) => nodes.get(edge.target)!);
      if (backends.length === 0) continue;
      const broken = backends.filter((backend) => backend.health === "error");
      for (const backend of broken) {
        node.reasons.push(
          backend.missing
            ? `Backend ${backend.kind} "${backend.name}" does not exist`
            : `Backend ${backend.kind} "${backend.name}": ${backend.reasons[0] || "failing"}`
        );
      }
      if (broken.length > 0) {
        node.health = worstHealth(
          node.health,
          broken.length === backends.length ? "error" : "warning"
        );
      }
    }
  }
  /* ---- groups ---- */
  const groups = new Map<string, AppGroup>();
  const assign = (node: TopoNode, id: string, name: string, type: AppGroup["type"]) => {
    node.group = id;
    let group = groups.get(id);
    if (!group) {
      const namespace = id.slice(0, id.indexOf("/"));
      group = { id, name, namespace, type, nodeIds: [], health: "neutral" };
      groups.set(id, group);
    }
    group.nodeIds.push(node.id);
  };
  const namespaceOf = (node: TopoNode) => node.namespace || CLUSTER_NAMESPACE;
  const assignApp = (node: TopoNode, appName: string) =>
    assign(node, groupId(namespaceOf(node), appName), appName, "app");
  const assignShared = (node: TopoNode) =>
    assign(node, groupId(namespaceOf(node), SHARED_GROUP), "Shared", "shared");

  // 1. Workload roots: their app label, else their own name.
  for (const root of rootNodes.values()) {
    const name = (root.object && appNameOf(root.object)) || root.name;
    assignApp(root, name);
  }
  // 2. Collapsible children follow their root.
  for (const node of nodes.values()) {
    if (node.parent) {
      const root = nodes.get(node.parent)!;
      assign(node, root.group, groups.get(root.group)!.name, "app");
    }
  }

  /** Groups of the nodes on the other side of a node's edges. */
  const neighbourGroups = (
    id: string,
    direction: "out" | "in",
    types?: EdgeType[]
  ) => {
    const list = (direction === "out" ? outgoing : incoming).get(id) || [];
    const result: string[] = [];
    for (const edge of list) {
      if (types && !types.includes(edge.type)) continue;
      const other = nodes.get(direction === "out" ? edge.target : edge.source)!;
      if (other.group && !result.includes(other.group)) result.push(other.group);
    }
    return result;
  };

  /** Assign a node to the single group it connects to, else shared / own. */
  const assignByNeighbours = (
    node: TopoNode,
    candidates: string[],
    fallback: "shared" | "own" | "unused"
  ) => {
    const sameNamespace = candidates.filter((id) =>
      id.startsWith(`${namespaceOf(node)}/`)
    );
    if (sameNamespace.length === 1) {
      assign(node, sameNamespace[0], groups.get(sameNamespace[0])!.name, "app");
      return;
    }
    // The group named like the object's own app label wins a tie.
    const own = node.object && appNameOf(node.object);
    if (own && sameNamespace.includes(groupId(namespaceOf(node), own))) {
      assignApp(node, own);
      return;
    }
    // Entry points fanning out to several apps (an Ingress with paths to
    // three services) are an application of their own.
    if (sameNamespace.length > 1 && fallback === "own") {
      assignApp(node, own || node.name);
      return;
    }
    if (sameNamespace.length > 1 || fallback === "shared") {
      if (sameNamespace.length === 0 && candidates.length === 1) {
        assign(node, candidates[0], groups.get(candidates[0])!.name, "app");
        return;
      }
      assignShared(node);
      return;
    }
    if (fallback === "own") {
      assignApp(node, own || node.name);
      return;
    }
    assign(
      node,
      groupId(namespaceOf(node), UNUSED_GROUP),
      "Unreferenced",
      "unused"
    );
  };

  // Missing nodes are placed last, next to whatever references them.
  const unassigned = (category: NodeCategory) =>
    [...nodes.values()].filter(
      (n) => !n.group && !n.missing && n.category === category
    );

  // 3. Services: the app they route to.
  for (const node of unassigned("service")) {
    assignByNeighbours(node, neighbourGroups(node.id, "out"), "own");
  }
  // 4. Routes (HTTPRoute / VirtualService / Ingress), then Gateways.
  for (const kind of ["HTTPRoute", "VirtualService", "Ingress", "Gateway"]) {
    for (const node of unassigned("traffic").filter((n) => n.kind === kind)) {
      assignByNeighbours(
        node,
        neighbourGroups(node.id, "out", ["routes"]),
        "own"
      );
    }
  }
  // 5. Policies: the workloads they scale / select.
  for (const node of unassigned("policy")) {
    assignByNeighbours(node, neighbourGroups(node.id, "out"), "shared");
  }
  // 6. Config, identity and claims: the workloads using them.
  for (const category of ["config", "identity", "storage"] as NodeCategory[]) {
    for (const node of unassigned(category).filter(
      (n) => n.kind !== "PersistentVolume" && n.kind !== "StorageClass"
    )) {
      assignByNeighbours(node, neighbourGroups(node.id, "in"), "unused");
    }
  }
  // 7. Volumes follow their claims; storage classes their volumes / claims.
  for (const kind of ["PersistentVolume", "StorageClass"]) {
    for (const node of [...nodes.values()].filter(
      (n) => !n.group && !n.missing && n.kind === kind
    )) {
      const candidates = neighbourGroups(node.id, "in");
      if (candidates.length === 1) {
        assign(node, candidates[0], groups.get(candidates[0])!.name, "app");
      } else if (candidates.length === 0) {
        assign(
          node,
          groupId(CLUSTER_NAMESPACE, UNUSED_GROUP),
          "Unreferenced",
          "unused"
        );
      } else {
        assignShared(node);
      }
    }
  }
  // 8. Anything left (missing targets of routes, ...): next to a referrer.
  for (const node of nodes.values()) {
    if (node.group) continue;
    const referrers = [
      ...neighbourGroups(node.id, "in"),
      ...neighbourGroups(node.id, "out"),
    ];
    if (referrers.length > 0) {
      assign(node, referrers[0], groups.get(referrers[0])!.name, "app");
    } else {
      assignShared(node);
    }
  }

  for (const group of groups.values()) {
    let health: Health = "neutral";
    for (const id of group.nodeIds) {
      const node = nodes.get(id)!;
      if (node.parent) continue; // rolled up into the root already
      health = worstHealth(health, node.health);
    }
    group.health = health;
  }

  return { nodes, edges: edgeList, groups };
}

function push<K, V>(map: Map<K, V[]>, k: K, value: V) {
  const list = map.get(k);
  if (list) list.push(value);
  else map.set(k, [value]);
}

/* ------------------------------------------------------- visible graph -- */

export interface GraphFilters {
  /** Namespaces to show; empty = all. */
  namespaces?: string[];
  /** Node categories to hide. */
  hiddenCategories?: NodeCategory[];
  /** Label filter (see parseLabelFilter): keeps groups with a match. */
  labels?: string;
  /** Hide applications without problems. */
  problemsOnly?: boolean;
  /** Show unreferenced ConfigMaps / Secrets / ServiceAccounts / volumes. */
  showUnused?: boolean;
}

export interface ExpansionState {
  /** Workload roots whose ReplicaSets / Jobs / Pods are shown. */
  expanded: Set<string>;
  /** Workload roots whose old ReplicaSets are shown too. */
  history: Set<string>;
}

export interface VisibleGraph {
  nodes: TopoNode[];
  edges: TopoEdge[];
  groups: AppGroup[];
}

/**
 * The part of the topology that is drawn: children of collapsed workloads
 * and filtered objects are left out, edges between visible nodes are kept.
 */
export function visibleGraph(
  topology: Topology,
  expansion: ExpansionState,
  filters: GraphFilters = {}
): VisibleGraph {
  const hiddenCategories = new Set(filters.hiddenCategories || []);
  const namespaces = new Set(filters.namespaces || []);
  const labelFilter = filters.labels ? parseLabelFilter(filters.labels) : null;

  const groups: AppGroup[] = [];
  const visible = new Set<string>();
  for (const group of topology.groups.values()) {
    if (group.type === "unused" && !filters.showUnused) continue;
    if (
      namespaces.size > 0 &&
      group.namespace !== CLUSTER_NAMESPACE &&
      !namespaces.has(group.namespace)
    ) {
      continue;
    }
    if (filters.problemsOnly && !isProblem(group.health)) continue;
    const members = group.nodeIds.map((id) => topology.nodes.get(id)!);
    if (
      labelFilter &&
      !members.some((node) => !node.missing && labelFilter(node.labels))
    ) {
      continue;
    }

    let count = 0;
    for (const node of members) {
      if (hiddenCategories.has(node.category)) continue;
      if (node.parent) {
        if (!expansion.expanded.has(node.parent)) continue;
        if (node.old && !expansion.history.has(node.parent)) continue;
      }
      visible.add(node.id);
      count++;
    }
    if (count > 0) groups.push(group);
  }

  const nodes = [...visible].map((id) => topology.nodes.get(id)!);
  const edges = topology.edges.filter(
    (edge) => visible.has(edge.source) && visible.has(edge.target)
  );
  return { nodes, edges, groups };
}

/* --------------------------------------------------------- neighbourhood -- */

/**
 * Everything upstream (transitively pointing at `id`) and downstream
 * (transitively reachable from `id`), plus the edges on those paths.
 */
export function traceNeighbourhood(
  edges: TopoEdge[],
  id: string
): { nodes: Set<string>; edges: Set<string> } {
  const outgoing = new Map<string, TopoEdge[]>();
  const incoming = new Map<string, TopoEdge[]>();
  for (const edge of edges) {
    push(outgoing, edge.source, edge);
    push(incoming, edge.target, edge);
  }
  const nodes = new Set<string>([id]);
  const litEdges = new Set<string>();
  const walk = (
    start: string,
    index: Map<string, TopoEdge[]>,
    next: (edge: TopoEdge) => string
  ) => {
    const seen = new Set<string>([start]);
    const queue = [start];
    while (queue.length) {
      const current = queue.shift()!;
      for (const edge of index.get(current) || []) {
        litEdges.add(edge.id);
        const other = next(edge);
        if (seen.has(other)) continue;
        seen.add(other);
        nodes.add(other);
        queue.push(other);
      }
    }
  };
  walk(id, outgoing, (edge) => edge.target);
  walk(id, incoming, (edge) => edge.source);
  return { nodes, edges: litEdges };
}

/* -------------------------------------------------------------- summary -- */

export interface HealthSummary {
  apps: number;
  healthy: number;
  degraded: number;
  failing: number;
}

/** Application counts by health (shared / unused groups are not apps). */
export function summarize(groups: Iterable<AppGroup>): HealthSummary {
  const summary: HealthSummary = { apps: 0, healthy: 0, degraded: 0, failing: 0 };
  for (const group of groups) {
    if (group.type !== "app") continue;
    summary.apps++;
    if (group.health === "error") summary.failing++;
    else if (group.health === "warning") summary.degraded++;
    else summary.healthy++;
  }
  return summary;
}

/**
 * Stable fingerprint of a visible graph's structure (not its health), to
 * only re-layout when the topology changed.
 */
export function topologySignature(nodes: TopoNode[], edges: TopoEdge[]) {
  return (
    nodes
      .map((node) => node.id)
      .sort()
      .join("|") +
    "#" +
    edges
      .map((edge) => edge.id)
      .sort()
      .join("|")
  );
}

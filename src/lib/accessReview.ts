/*
 * The cluster side of the access review: RBAC objects of a context (listed
 * once, shared by the page and the side panels for a short while), the
 * self reviews the API server answers (SelfSubjectAccessReview, -RulesReview
 * and -Review for "who am I") and the pods that run as a service account.
 *
 * Everything goes through `kube_request` on explicit use: opening the
 * page, a side panel, or asking a question.
 */
import { shallowRef, ref, watch, onScopeDispose, type Ref } from "vue";
import { kubeGet, kubePost, queryString, type KubeTarget } from "@/lib/kubeApi";
import { report } from "@/lib/auth/center";
import { contextKey } from "@/lib/contextKey";
import type { BindingObject, Identity, PolicyRule, RbacSnapshot, RoleObject } from "@/lib/rbac";

const RBAC = "/apis/rbac.authorization.k8s.io/v1";

export const RBAC_KINDS = [
  { kind: "ClusterRole", plural: "clusterroles", key: "clusterRoles" },
  { kind: "ClusterRoleBinding", plural: "clusterrolebindings", key: "clusterRoleBindings" },
  { kind: "Role", plural: "roles", key: "roles" },
  { kind: "RoleBinding", plural: "rolebindings", key: "roleBindings" },
] as const;

export type RbacKind = (typeof RBAC_KINDS)[number]["kind"];

export interface RbacUnavailable {
  kind: RbacKind;
  plural: string;
  /** The API said no (403), or the request failed otherwise. */
  forbidden: boolean;
  message: string;
}

export interface RbacData {
  snapshot: RbacSnapshot;
  /** Kinds that couldn't be listed: their objects are missing. */
  unavailable: RbacUnavailable[];
  loadedAt: number;
}

/** The status code of an API error (`SerializableKubeError`). */
export const errorCode = (error: unknown): number | null =>
  typeof error === "object" && error && "code" in error ? Number((error as { code: unknown }).code) || null : null;

export const errorMessage = (error: unknown): string =>
  typeof error === "string"
    ? error
    : typeof error === "object" && error && "message" in error
      ? String((error as { message: unknown }).message)
      : String(error);

interface Listed {
  metadata?: Record<string, unknown>;
  [field: string]: unknown;
}

/* List items carry no kind / apiVersion; panels and links need both, plus the context. */
const tag = (items: Listed[], kind: string, target: KubeTarget) =>
  items.map((item) => ({
    ...item,
    apiVersion: "rbac.authorization.k8s.io/v1",
    kind,
    metadata: { ...item.metadata, context: target.context, kubeConfig: target.kubeConfig ?? "" },
  })) as unknown as (RoleObject & BindingObject)[];

async function fetchRbac(target: KubeTarget): Promise<RbacData> {
  const snapshot: RbacSnapshot = { roles: [], clusterRoles: [], roleBindings: [], clusterRoleBindings: [] };
  const unavailable: RbacUnavailable[] = [];
  await Promise.all(
    RBAC_KINDS.map(async ({ kind, plural, key }) => {
      try {
        const list = await kubeGet<{ items?: Listed[] }>(target, `${RBAC}/${plural}`);
        Object.assign(snapshot, { [key]: tag(list?.items ?? [], kind, target) });
      } catch (error) {
        // Sign-in problems go to the auth center (notice + toast).
        report({ context: target.context, kubeConfig: target.kubeConfig ?? "" }, error, "api");
        unavailable.push({ kind, plural, forbidden: errorCode(error) === 403, message: errorMessage(error) });
      }
    })
  );
  unavailable.sort((a, b) => RBAC_KINDS.findIndex((k) => k.kind === a.kind) - RBAC_KINDS.findIndex((k) => k.kind === b.kind));
  return { snapshot, unavailable, loadedAt: Date.now() };
}

/* Fresh enough to open a panel or switch tabs without asking again. */
const TTL_MS = 30_000;
const cache = new Map<string, { at: number; promise: Promise<RbacData> }>();

export function loadRbac(target: KubeTarget, options: { force?: boolean } = {}): Promise<RbacData> {
  const key = contextKey(target.context, target.kubeConfig ?? "");
  const cached = cache.get(key);
  if (cached && !options.force && Date.now() - cached.at < TTL_MS) return cached.promise;
  const promise = fetchRbac(target);
  cache.set(key, { at: Date.now(), promise });
  return promise;
}

/** The RBAC objects of a (reactive) context; reloads when it changes. */
export function useRbacData(target: Ref<KubeTarget | null>) {
  const data = shallowRef<RbacData | null>(null);
  const loading = ref(false);
  let generation = 0;

  const load = async (force = false) => {
    const current = target.value;
    const run = ++generation;
    if (!current?.context) {
      data.value = null;
      return;
    }
    loading.value = true;
    try {
      const result = await loadRbac(current, { force });
      if (run === generation) data.value = result;
    } finally {
      if (run === generation) loading.value = false;
    }
  };

  const stop = watch(
    () => (target.value ? contextKey(target.value.context, target.value.kubeConfig ?? "") : ""),
    (now, before) => {
      if (now !== before) data.value = null;
      load();
    },
    { immediate: true }
  );
  onScopeDispose(stop);

  return { data, loading, refresh: () => load(true) };
}

/* -------------------------------------------------------- self reviews -- */

export interface ReviewAttributes {
  verb: string;
  group?: string;
  resource?: string;
  subresource?: string;
  name?: string;
  namespace?: string;
  /** Non-resource requests (/healthz, /metrics). */
  path?: string;
}

export interface AccessDecision {
  allowed: boolean;
  denied?: boolean;
  reason?: string;
  evaluationError?: string;
}

/** "Can I …?", answered by the API server (all its authorizers, not just RBAC). */
export async function canI(target: KubeTarget, attributes: ReviewAttributes): Promise<AccessDecision> {
  const spec = attributes.path
    ? { nonResourceAttributes: { verb: attributes.verb, path: attributes.path } }
    : {
        resourceAttributes: {
          verb: attributes.verb,
          group: attributes.group ?? "",
          resource: attributes.resource,
          ...(attributes.subresource ? { subresource: attributes.subresource } : {}),
          ...(attributes.name ? { name: attributes.name } : {}),
          ...(attributes.namespace ? { namespace: attributes.namespace } : {}),
        },
      };
  const review = await kubePost<{ status?: AccessDecision }>(target, "/apis/authorization.k8s.io/v1/selfsubjectaccessreviews", {
    apiVersion: "authorization.k8s.io/v1",
    kind: "SelfSubjectAccessReview",
    spec,
  });
  return { allowed: false, ...review?.status };
}

export interface RulesReview {
  rules: PolicyRule[];
  /** Another authorizer (a webhook, cloud IAM) can't list its rules. */
  incomplete: boolean;
  evaluationError?: string;
}

/** Everything I can do in a namespace, as rules. */
export async function myRules(target: KubeTarget, namespace: string): Promise<RulesReview> {
  const review = await kubePost<{
    status?: { resourceRules?: PolicyRule[]; nonResourceRules?: PolicyRule[]; incomplete?: boolean; evaluationError?: string };
  }>(target, "/apis/authorization.k8s.io/v1/selfsubjectrulesreviews", {
    apiVersion: "authorization.k8s.io/v1",
    kind: "SelfSubjectRulesReview",
    spec: { namespace },
  });
  const status = review?.status ?? {};
  return {
    rules: [...(status.resourceRules ?? []), ...(status.nonResourceRules ?? [])],
    incomplete: !!status.incomplete,
    evaluationError: status.evaluationError || undefined,
  };
}

const whoAmICache = new Map<string, Promise<Identity | null>>();

/**
 * Who the cluster thinks I am (SelfSubjectReview, Kubernetes 1.28+; beta in
 * 1.27). null when the cluster can't tell.
 */
export function whoAmI(target: KubeTarget): Promise<Identity | null> {
  const key = contextKey(target.context, target.kubeConfig ?? "");
  let pending = whoAmICache.get(key);
  if (!pending) {
    pending = (async () => {
      for (const version of ["v1", "v1beta1"]) {
        try {
          const review = await kubePost<{ status?: { userInfo?: { username?: string; groups?: string[] } } }>(
            target,
            `/apis/authentication.k8s.io/${version}/selfsubjectreviews`,
            { apiVersion: `authentication.k8s.io/${version}`, kind: "SelfSubjectReview" }
          );
          const user = review?.status?.userInfo;
          if (user) return { username: user.username, groups: user.groups ?? [] };
        } catch (error) {
          if (errorCode(error) !== 404) break;
        }
      }
      whoAmICache.delete(key);
      return null;
    })();
    whoAmICache.set(key, pending);
  }
  return pending;
}

/* ------------------------------------------------- service accounts run -- */

export interface WorkloadRef {
  kind: string;
  name: string;
  namespace: string;
  pods: number;
}

/**
 * The workloads behind pods: a ReplicaSet's Deployment (its name minus the
 * pod-template-hash), else the direct owner, else the pod itself.
 */
export interface PodLike {
  metadata?: {
    name?: string;
    namespace?: string;
    labels?: Record<string, string>;
    ownerReferences?: { kind: string; name: string; controller?: boolean }[];
    [field: string]: unknown;
  };
  [field: string]: unknown;
}

export function workloadsOf(pods: PodLike[]): WorkloadRef[] {
  const workloads = new Map<string, WorkloadRef>();
  for (const pod of pods) {
    const namespace = pod.metadata?.namespace ?? "";
    const owner = (pod.metadata?.ownerReferences ?? []).find((o) => o.controller) ?? pod.metadata?.ownerReferences?.[0];
    let kind = owner?.kind ?? "Pod";
    let name = owner?.name ?? pod.metadata?.name ?? "";
    const hash = pod.metadata?.labels?.["pod-template-hash"];
    if (kind === "ReplicaSet" && hash && name.endsWith(`-${hash}`)) {
      kind = "Deployment";
      name = name.slice(0, -hash.length - 1);
    }
    const key = `${kind}/${namespace}/${name}`;
    const entry = workloads.get(key) ?? { kind, name, namespace, pods: 0 };
    entry.pods++;
    workloads.set(key, entry);
  }
  return [...workloads.values()].sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));
}

/** The pods that run as a service account. */
export async function podsOfServiceAccount(target: KubeTarget, namespace: string, name: string): Promise<PodLike[]> {
  const list = await kubeGet<{ items?: PodLike[] }>(
    target,
    `/api/v1/namespaces/${encodeURIComponent(namespace)}/pods${queryString({ fieldSelector: `spec.serviceAccountName=${name}` })}`
  );
  return (list?.items ?? []).map((pod) => ({
    ...pod,
    apiVersion: "v1",
    kind: "Pod",
    metadata: { ...pod.metadata, context: target.context, kubeConfig: target.kubeConfig ?? "" },
  }));
}

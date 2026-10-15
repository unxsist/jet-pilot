/*
 * Where the GitOps page may list each kind in a context. The page lists all
 * namespaces, but access is often granted per namespace (an assumed IAM
 * role or SSO group bound to a few namespaces): a list across all of them
 * is then forbidden, while the namespaces Argo CD and Flux keep their
 * objects in are readable. The API server says which (SelfSubjectAccessReview,
 * which covers every authorizer, EKS access policies included), before
 * anything is listed:
 *
 * - "all" when the kind may be listed cluster-wide (or the question can't
 *   be asked: the list then reports what's wrong itself);
 * - else the readable namespaces among the context's selected ones, the
 *   controllers' usual namespaces and, when namespaces can be listed, the
 *   cluster's (all of them in small clusters, GitOps-looking names in big
 *   ones);
 * - [] when none of those is readable.
 *
 * Answers are kept for the session (permissions rarely change); a retry asks
 * again.
 */
import { computed, shallowRef, watch, type Ref } from "vue";
import { canI } from "@/lib/accessReview";
import { kubeGet } from "@/lib/kubeApi";
import { runLimited } from "@/lib/discovery";
import type { ContextTarget } from "@/composables/useWatchedList";
import { DELIVERY_KINDS, type WatchedKind } from "./kinds";

export type KindScope = "all" | string[];

/** Where Argo CD and Flux install by default. */
export const CONTROLLER_NAMESPACES = ["argocd", "argo-cd", "flux-system"];
/* Clusters with more namespaces only get their GitOps-looking ones checked. */
const MAX_CHECKED_NAMESPACES = 40;
const GITOPS_NAME = /argo|flux|gitops/i;
const CONCURRENCY = 8;

/** Can `kind` be listed (in `namespace`, else cluster-wide)? null: couldn't ask. */
export type AskList = (kind: WatchedKind, namespace?: string) => Promise<boolean | null>;

/** The namespaces worth checking when a cluster-wide list is forbidden. */
export function candidateNamespaces(selected: string[], clusterNamespaces: string[] | null): string[] {
  const names = new Set([...selected.filter((n) => n && n !== "all"), ...CONTROLLER_NAMESPACES]);
  if (clusterNamespaces) {
    const checked =
      clusterNamespaces.length <= MAX_CHECKED_NAMESPACES
        ? clusterNamespaces
        : clusterNamespaces.filter((name) => GITOPS_NAME.test(name));
    for (const name of checked) names.add(name);
  }
  return [...names];
}

/** The scope of every kind in one context. */
export async function resolveScopes(
  kinds: WatchedKind[],
  ask: AskList,
  candidates: () => Promise<string[]>
): Promise<Map<string, KindScope>> {
  const scopes = new Map<string, KindScope>();
  const cluster = await Promise.all(kinds.map((kind) => ask(kind)));
  const narrowed = kinds.filter((kind, index) => {
    if (cluster[index] === false) return true;
    scopes.set(kind.kind, "all");
    return false;
  });
  if (!narrowed.length) return scopes;

  const namespaces = await candidates();
  const checks = narrowed.flatMap((kind) => namespaces.map((namespace) => ({ kind, namespace })));
  const answers = await runLimited(
    checks.map(({ kind, namespace }) => () => ask(kind, namespace)),
    CONCURRENCY
  );
  for (const kind of narrowed) scopes.set(kind.kind, []);
  checks.forEach(({ kind, namespace }, index) => {
    const answer = answers[index];
    // Couldn't ask about this one namespace: list it, the list tells.
    if (answer.status === "fulfilled" && answer.value === false) return;
    (scopes.get(kind.kind) as string[]).push(namespace);
  });
  return scopes;
}

/* ------------------------------------------------------- composable -- */

const cache = new Map<string, Promise<Map<string, KindScope>>>();

const keyOf = (target: ContextTarget, kinds: WatchedKind[]) =>
  JSON.stringify([target.kubeConfig, target.context, [...target.namespaces].sort(), kinds.map((k) => k.kind)]);

function scopesFor(target: ContextTarget, kinds: WatchedKind[]): Promise<Map<string, KindScope>> {
  const key = keyOf(target, kinds);
  let scopes = cache.get(key);
  if (!scopes) {
    const ask: AskList = (kind, namespace) =>
      canI(target, { verb: "list", group: kind.group, resource: kind.plural, namespace }).then(
        (decision) => decision.allowed,
        () => null
      );
    const candidates = async () => {
      let names: string[] | null = null;
      try {
        const list = await kubeGet<{ items?: { metadata?: { name?: string } }[] }>(target, "/api/v1/namespaces");
        names = (list?.items ?? []).map((n) => n.metadata?.name ?? "").filter(Boolean);
      } catch {
        // Namespaces can't be listed either: the selection and the usual ones.
      }
      return candidateNamespaces(target.namespaces, names);
    };
    scopes = resolveScopes(kinds, ask, candidates);
    cache.set(key, scopes);
    // A failure is asked again next time.
    scopes.catch(() => cache.delete(key));
  }
  return scopes;
}

/** A context whose deliveries can only be listed in some namespaces. */
export interface LimitedScope {
  context: string;
  /** Readable namespaces of the delivery kinds ([] = none). */
  namespaces: string[];
}

export function useGitOpsScopes(contexts: Ref<{ target: ContextTarget; kinds: WatchedKind[] }[]>) {
  const resolved = shallowRef(new Map<string, Map<string, KindScope>>());

  const resolve = () => {
    const keys = new Set<string>();
    for (const { target, kinds } of contexts.value) {
      const key = keyOf(target, kinds);
      keys.add(key);
      if (resolved.value.has(key)) continue;
      scopesFor(target, kinds).then(
        (scopes) => {
          if (!contexts.value.some((c) => keyOf(c.target, c.kinds) === key)) return;
          resolved.value = new Map(resolved.value).set(key, scopes);
        },
        () => {
          // Couldn't work it out: list everything, the list reports why.
          const all = new Map(kinds.map((kind) => [kind.kind, "all" as KindScope]));
          resolved.value = new Map(resolved.value).set(key, all);
        }
      );
    }
    // Forget contexts that went away.
    if ([...resolved.value.keys()].some((key) => !keys.has(key))) {
      resolved.value = new Map([...resolved.value].filter(([key]) => keys.has(key)));
    }
  };
  watch(() => contexts.value.map((c) => keyOf(c.target, c.kinds)).join("\n"), resolve, { immediate: true });

  /** The scope of `kind` in `target`; null while it's being worked out. */
  const scopeOf = (target: ContextTarget, kinds: WatchedKind[], kind: string): KindScope | null =>
    resolved.value.get(keyOf(target, kinds))?.get(kind) ?? null;

  return {
    scopeOf,
    checking: computed(() => contexts.value.some((c) => !resolved.value.has(keyOf(c.target, c.kinds)))),
    /** Contexts whose deliveries aren't readable in every namespace. */
    limited: computed<LimitedScope[]>(() =>
      contexts.value.flatMap(({ target, kinds }) => {
        const scopes = resolved.value.get(keyOf(target, kinds));
        const deliveries = kinds.filter((kind) => Object.values(DELIVERY_KINDS).includes(kind));
        const narrowed = deliveries.map((kind) => scopes?.get(kind.kind)).filter((s): s is string[] => Array.isArray(s));
        if (!narrowed.length) return [];
        return [{ context: target.context, namespaces: [...new Set(narrowed.flat())].sort() }];
      })
    ),
    /** Ask again (after a permission change). */
    reset: () => {
      cache.clear();
      resolved.value = new Map();
      resolve();
    },
  };
}

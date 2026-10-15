/*
 * Every delivery (Flux Kustomizations and HelmReleases, Argo CD
 * Applications) of every active context, live: one WatchHub subscription per
 * kind, only for the contexts whose discovery serves it. Flux sources are
 * watched too: their URL names the repository and their status explains
 * many failures.
 *
 * The page lists all namespaces of a context, whatever namespaces are
 * selected: deliveries live in their controller's namespace (flux-system,
 * argocd), not in the namespaces they deliver to. With access to some
 * namespaces only, it lists those it may read (see ./scope).
 */
import { computed } from "vue";
import { flattenResources } from "@/lib/discovery";
import { injectStrict } from "@/lib/utils";
import { SettingsContextStateKey } from "@/providers/SettingsContextProvider";
import { useWatchedList } from "@/composables/useWatchedList";
import { kubectlGetForContext, kubectlPollingForced } from "@/lib/multicontext";
import { useGitOpsDetection } from "./detect";
import { pendingFor } from "./actions";
import { useGitOpsScopes } from "./scope";
import {
  DELIVERY_KINDS,
  SOURCE_KINDS,
  WATCHED_KINDS,
  detectGitOps,
  qualifiedName,
  toDelivery,
  withPending,
  type Delivery,
  type ObjectRef,
  type WatchedKind,
} from "./model";

export const sourceKey = (context: string, ref: ObjectRef) =>
  [context, ref.kind, ref.namespace, ref.name].join("\u0000");

export function useGitOps() {
  const { settings } = injectStrict(SettingsContextStateKey);
  const detection = useGitOpsDetection();
  /* Which kinds each active context serves. */
  const detections = computed(() =>
    detection.entries.value.map(({ target, entry }) => ({
      target,
      detection: detectGitOps(flattenResources(entry.snapshot.value)),
    }))
  );

  /* Where each served kind may be listed, per context. */
  const served = computed(() =>
    detections.value.map(({ target, detection }) => ({
      target,
      kinds: WATCHED_KINDS.filter((kind) => detection.served.has(kind.kind)),
    }))
  );
  const scopes = useGitOpsScopes(served);

  const watchKind = (kind: WatchedKind) => ({
    kind,
    ...useWatchedList<any>({
      resource: () => qualifiedName(kind),
      kind: () => kind.kind,
      targets: () =>
        served.value.flatMap(({ target, kinds }) => {
          if (!kinds.includes(kind)) return [];
          const scope = scopes.scopeOf(target, kinds, kind.kind);
          if (!scope || !scope.length) return [];
          return [{ ...target, namespaces: scope === "all" ? ["all"] : scope }];
        }),
      fallback: (resource, target) =>
        kubectlGetForContext<any>(resource, target.context, target.kubeConfig, target.namespaces),
      forcePolling: () => kubectlPollingForced(settings.value),
    }),
  });
  const lists = WATCHED_KINDS.map(watchKind);
  const deliveryLists = lists.filter((l) => Object.values(DELIVERY_KINDS).includes(l.kind));
  const sourceLists = lists.filter((l) => Object.values(SOURCE_KINDS).includes(l.kind));

  const sources = computed(() => {
    const index = new Map<string, any>();
    for (const list of sourceLists) {
      for (const row of list.items.value) {
        const { context = "", namespace = "", name = "" } = row.metadata ?? {};
        index.set(sourceKey(context, { kind: list.kind.kind, namespace, name }), row);
      }
    }
    return index;
  });

  const deliveries = computed<Delivery[]>(() => {
    const now = Date.now();
    const index = sources.value;
    const result: Delivery[] = [];
    for (const list of deliveryLists) {
      for (const row of list.items.value) {
        const context = row.metadata?.context ?? "";
        const delivery = toDelivery(row, (ref) => index.get(sourceKey(context, ref)), now);
        if (!delivery) continue;
        result.push(withPending(delivery, pendingFor(row)));
      }
    }
    return result;
  });

  /* Lists that couldn't load (forbidden, unreachable): named per kind. */
  const errors = computed(() =>
    deliveryLists
      .filter((l) => l.error.value)
      .map((l) => ({ kind: l.kind.kind, message: l.error.value!.message }))
  );

  const loading = computed(
    () =>
      detection.discovering.value ||
      scopes.checking.value ||
      deliveryLists.some((l) => l.loading.value && l.items.value.length === 0)
  );

  return {
    ...detection,
    detections,
    deliveries,
    sources,
    errors,
    loading,
    /** Contexts where only some namespaces are readable. */
    limited: scopes.limited,
    retry: () => {
      scopes.reset();
      lists.forEach((l) => l.retry());
    },
  };
}

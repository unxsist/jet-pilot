/*
 * Live data for the side panels: the panel's object kept up to date (an
 * inline edit, a cordon or a rollout shows right away) and related lists
 * (a node's pods, a Service's EndpointSlices), all from the backend's
 * watches.
 *
 * Lists use the active namespace selection when it covers the object, so
 * they share the watcher of the table behind the panel instead of opening
 * one of their own.
 */
import { computed, ref, type ComputedRef } from "vue";
import { useIntervalFn } from "@vueuse/core";
import { injectStrict } from "@/lib/utils";
import { KubeContextStateKey } from "@/providers/KubeContextProvider";
import { SettingsContextStateKey } from "@/providers/SettingsContextProvider";
import { useWatchedList } from "@/composables/useWatchedList";
import { kubectlGetForContext, kubectlPollingForced } from "@/lib/multicontext";
import { useDiscovery } from "@/lib/discovery";
import { kindInfo, watchResource } from "@/lib/resources/kinds";
import type { PanelTarget } from "@/lib/resources/open";

/** The cluster a panel object came from (tagged rows), else the primary context. */
export function usePanelTarget(resource: () => any): ComputedRef<PanelTarget> {
  const { context, kubeConfig, contextKubeConfigMapping } = injectStrict(KubeContextStateKey);
  return computed(() => {
    const metadata = resource()?.metadata ?? {};
    const ctx: string = metadata.context || context.value;
    return {
      context: ctx,
      kubeConfig: metadata.kubeConfig || contextKubeConfigMapping.value.get(ctx) || (metadata.context ? "" : kubeConfig.value),
    };
  });
}

/**
 * A watched list of a built-in kind in one cluster. `namespaces`: the
 * namespaces to cover (null: don't watch; ignored for cluster-scoped
 * kinds; ["all"] for every namespace).
 */
export function useRelatedList<T = any>(
  kind: () => string | null | undefined,
  target: () => PanelTarget,
  namespaces: () => string[] | null
) {
  const { contexts } = injectStrict(KubeContextStateKey);
  const { settings } = injectStrict(SettingsContextStateKey);
  const info = computed(() => kindInfo(kind() ?? undefined));

  /* The table's selection when it covers what we need: one shared watcher. */
  const scope = (context: string, wanted: string[]): string[] => {
    const active = contexts.value.get(context);
    if (!active?.length) return wanted;
    const all = active.includes("all") || active.includes("");
    if (all || wanted.every((ns) => active.includes(ns))) return [...active];
    return wanted;
  };

  const list = useWatchedList<any>({
    resource: () => (info.value ? watchResource(info.value) : ""),
    kind: () => info.value?.kind,
    targets: () => {
      const wanted = namespaces();
      const t = target();
      if (!info.value || !wanted || !t.context) return [];
      const ns = info.value.namespaced ? (wanted.includes("all") ? ["all"] : scope(t.context, wanted)) : ["all"];
      return [{ context: t.context, kubeConfig: t.kubeConfig, namespaces: ns }];
    },
    fallback: (resource, t) => kubectlGetForContext(resource, t.context, t.kubeConfig, t.namespaces),
    forcePolling: () => kubectlPollingForced(settings.value),
  });

  /* Only the namespaces asked for (the shared watcher may cover more). */
  const items = computed<T[]>(() => {
    const wanted = namespaces();
    if (!wanted || !info.value?.namespaced || wanted.includes("all")) return list.items.value as T[];
    return list.items.value.filter((item: any) => wanted.includes(item.metadata?.namespace)) as T[];
  });
  return { items, loading: list.loading };
}

/**
 * The panel's object, live: the watched version of it (matched by uid),
 * or the object the panel was opened with until that arrives / for kinds
 * that aren't watched here.
 */
export function useLiveObject(resource: () => any) {
  const target = usePanelTarget(resource);
  const watched = computed(() => {
    const object = resource();
    // Events change all the time and aren't edited here.
    return object?.kind && object.kind !== "Event" && kindInfo(object.kind) ? object.kind : null;
  });
  const { items } = useRelatedList(
    () => watched.value,
    () => target.value,
    () => (resource()?.metadata?.namespace ? [resource().metadata.namespace] : ["all"])
  );
  const live = computed(() => {
    const object = resource();
    const uid = object?.metadata?.uid;
    const found = uid ? items.value.find((item: any) => item.metadata?.uid === uid) : undefined;
    return found ?? object;
  });
  return { live, target };
}

/** The current time, ticking (for "3m ago" and next runs). */
export function useNow(interval = 30_000) {
  const now = ref(Date.now());
  useIntervalFn(() => (now.value = Date.now()), interval);
  return now;
}

/** Whether the cluster serves a kind (optional APIs like Gateway API), from discovery. */
export function useServed(target: () => PanelTarget, kind: string, group: string) {
  const { resources } = useDiscovery(
    computed(() => target().context),
    computed(() => target().kubeConfig)
  );
  return computed(() => resources.value.some((r) => r.kind === kind && r.group === group));
}

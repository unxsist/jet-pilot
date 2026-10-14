/*
 * Is Flux or Argo CD installed in an active context? Answered from the
 * shared discovery service (cached on disk, revalidated in the background),
 * so the navigation knows right away whether to offer the GitOps page.
 * Kept tiny: the navigation loads it at startup (the kinds are in kinds.ts).
 */
import { computed, shallowRef, watch } from "vue";
import { KubeContextStateKey } from "@/providers/KubeContextProvider";
import { injectStrict } from "@/lib/utils";
import { discoveryKey, getDiscoveryService, type DiscoveryEntry } from "@/lib/discovery";
import { activeTargets } from "@/lib/multicontext";
import type { ContextTarget } from "@/composables/useWatchedList";

export interface ContextDiscovery {
  target: ContextTarget;
  entry: DiscoveryEntry;
}

/* Discovery groups are keyed by API group name. */
const hasFlux = (entry: DiscoveryEntry) =>
  Object.keys(entry.snapshot.value?.groups ?? {}).some((group) => group.endsWith(".toolkit.fluxcd.io"));
const hasArgo = (entry: DiscoveryEntry) =>
  (entry.snapshot.value?.groups?.["argoproj.io"] ?? []).some((r) => r.kind === "Application");

export function useGitOpsDetection() {
  const { contexts, contextKubeConfigMapping } = injectStrict(KubeContextStateKey);
  const service = getDiscoveryService();

  const targets = computed(() => activeTargets(contexts.value, contextKubeConfigMapping.value));
  const entries = shallowRef<ContextDiscovery[]>([]);
  watch(
    () => targets.value.map((t) => discoveryKey(t.context, t.kubeConfig)).join("\n"),
    () => {
      entries.value = targets.value.map((target) => ({
        target,
        entry: service.get(target.context, target.kubeConfig),
      }));
    },
    { immediate: true }
  );

  const flux = computed(() => entries.value.some(({ entry }) => hasFlux(entry)));
  const argo = computed(() => entries.value.some(({ entry }) => hasArgo(entry)));
  return {
    entries,
    flux,
    argo,
    installed: computed(() => flux.value || argo.value),
    /* A context's first discovery hasn't answered yet. */
    discovering: computed(() =>
      entries.value.some(({ entry }) => !entry.snapshot.value && entry.status.value === "loading")
    ),
  };
}

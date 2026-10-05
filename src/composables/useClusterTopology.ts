import { Ref, onScopeDispose, ref, shallowRef, watch } from "vue";
import { log as logInfo } from "@/lib/logger";
import { DiscoveryService, getDiscoveryService } from "@/lib/discovery";
import { WatchTransport, tauriWatchTransport } from "@/lib/watch";
import {
  ContextTarget,
  WatchedListController,
} from "@/composables/useWatchedList";
import {
  DiscoveredResource,
  GraphObject,
  Topology,
  TopologyChange,
  buildTopology,
  qualifiedResourceName,
  reconcileTopology,
} from "@/lib/clusterGraph";
import {
  graphResourcesOf,
  isHelmReleaseSecret,
  isMetadataOnly,
  namespaceTargets,
  parseSecretMetadata,
  prepareListed,
  secretMetadataArgs,
} from "@/lib/clusterGraphSources";

/** kubectl polling interval of the fallback path. */
export const GRAPH_REFRESH_INTERVAL = 15_000;
/** Show what has loaded when some kinds take longer than this. */
const INITIAL_LOAD_TIMEOUT = 20_000;
/** Minimum gap between two model rebuilds of live updates. */
const MIN_BUILD_GAP = 120;

export interface GraphScope {
  context: string;
  kubeConfig: string;
  /** Namespaces to show; [] = all namespaces. */
  namespaces: string[];
}

export interface GraphTimings {
  /** Discovery + first snapshot of every kind. */
  fetchMs: number;
  /** Last model build (buildTopology + reconcile). */
  buildMs: number;
  objects: number;
  /** Model builds so far (live updates included). */
  builds: number;
}

export interface GraphSourceOptions {
  /** kubectl polling for every kind (settings.experimental.useKubectlPolling). */
  forcePolling?: () => boolean;
  transport?: WatchTransport;
  discovery?: DiscoveryService;
  /** Runs kubectl (fallback path); the backend command by default. */
  kubectl?: (args: string[]) => Promise<string>;
  pollInterval?: number;
}

/** How the graph gets its data: live watches, kubectl polling or both. */
export type GraphSourceMode = "watch" | "poll" | "mixed";

const defaultKubectl = async (args: string[]) => {
  const { Kubernetes } = await import("@/services/Kubernetes");
  return Kubernetes.kubectl(args);
};

/*
 * Cache key of metadata-only Secret rows in the watched-list row cache:
 * distinct from the Secrets list (full objects), so neither picks up the
 * other's rows.
 */
const METADATA_KIND = "Secret:metadata";

const sameItems = (a: GraphObject[], b: GraphObject[]) => {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
};

interface KindSource {
  resource: DiscoveredResource;
  controller: WatchedListController<GraphObject>;
  /** Rows of the last build (compared by identity). */
  items: GraphObject[];
}

/**
 * The topology of a scope, live: the graphable kinds come from the shared
 * discovery service, each kind is a WatchHub subscription (snapshot +
 * batched deltas) per namespace scope with a per-kind fallback to kubectl
 * polling (watch unavailable / forbidden, or forced by the setting).
 * Secrets are always listed metadata-only with kubectl.
 *
 * Changes are coalesced into model rebuilds, which only happen when rows
 * actually changed; reconcileTopology keeps unchanged nodes, edges and
 * groups identical, so views redraw only what changed (`change`).
 */
export function useClusterTopology(
  scope: Ref<GraphScope | null>,
  options: GraphSourceOptions = {}
) {
  const transport = options.transport ?? tauriWatchTransport;
  const kubectl = options.kubectl ?? defaultKubectl;
  const pollInterval = options.pollInterval ?? GRAPH_REFRESH_INTERVAL;
  const discovery = () => options.discovery ?? getDiscoveryService();

  const topology = shallowRef<Topology | null>(null);
  /** What the last model update changed. */
  const change = shallowRef<TopologyChange | null>(null);
  /** First load of a scope (the graph is empty meanwhile). */
  const loading = ref(false);
  /** A manual refresh is running. */
  const refreshing = ref(false);
  const progress = ref({ done: 0, total: 0 });
  /** Resources that failed to load. */
  const failedResources = ref<DiscoveredResource[]>([]);
  /** Nothing could be loaded (first load) / live updates are failing. */
  const loadError = ref<string | null>(null);
  const refreshError = ref<string | null>(null);
  const lastUpdated = ref<Date | null>(null);
  const timings = ref<GraphTimings | null>(null);
  const paused = ref(false);
  const mode = ref<GraphSourceMode>("watch");

  let sources: KindSource[] = [];
  let generation = 0;
  let startedAt = 0;
  let buildTimer: ReturnType<typeof setTimeout> | undefined;
  let initialTimer: ReturnType<typeof setTimeout> | undefined;
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  let buildQueued = false;
  let lastBuildAt = -Infinity;
  let lastBuildMs = 0;
  let builds = 0;
  let failedKey = "";
  let initialTimedOut = false;

  /* -------------------------------------------------------- fallback -- */

  const listOne = async (
    resource: DiscoveredResource,
    target: ContextTarget,
    namespace: string | null
  ): Promise<GraphObject[]> => {
    const tag = { context: target.context, kubeConfig: target.kubeConfig };
    if (isMetadataOnly(resource)) {
      const output = await kubectl(
        secretMetadataArgs(target.context, target.kubeConfig, namespace)
      );
      return parseSecretMetadata(output, tag).filter(
        (secret) => !isHelmReleaseSecret(secret)
      );
    }
    const args = [
      "get",
      qualifiedResourceName(resource),
      "--context",
      target.context,
      "-o",
      "json",
      "--request-timeout=30s",
    ];
    if (target.kubeConfig) args.push("--kubeconfig", target.kubeConfig);
    if (resource.namespaced !== false) {
      if (namespace) args.push("--namespace", namespace);
      else args.push("--all-namespaces");
    }
    const items: GraphObject[] = JSON.parse(await kubectl(args)).items || [];
    return prepareListed(items, resource, tag);
  };

  const listResource = async (
    resource: DiscoveredResource,
    target: ContextTarget
  ): Promise<GraphObject[]> => {
    const namespaces = target.namespaces.includes("all")
      ? [null]
      : target.namespaces;
    const lists = await Promise.all(
      namespaces.map((namespace) => listOne(resource, target, namespace))
    );
    return lists.flat();
  };

  /* ----------------------------------------------------------- build -- */

  const now = () => performance.now();

  const schedule = () => {
    if (buildQueued) return;
    buildQueued = true;
    const gap = topology.value
      ? Math.max(MIN_BUILD_GAP, lastBuildMs * 4)
      : 0;
    const wait = Math.max(0, lastBuildAt + gap - now());
    // A timeout even when due: coalesces the kinds updated in this tick.
    buildTimer = setTimeout(build, wait);
  };

  const build = () => {
    buildQueued = false;
    const current = scope.value;
    if (!current || sources.length === 0) return;
    const initial = topology.value === null;

    let done = 0;
    for (const source of sources) {
      if (!source.controller.loading()) done++;
    }
    progress.value = { done, total: sources.length };
    if (initial && done < sources.length && !initialTimedOut) return;
    if (paused.value && !initial) return;

    const failed: DiscoveredResource[] = [];
    let firstError = "";
    const loadedKinds = new Set<string>();
    for (const source of sources) {
      const error = source.controller.error();
      if (error) {
        failed.push(source.resource);
        firstError ||= error.message;
      } else if (!source.controller.loading()) {
        loadedKinds.add(source.resource.kind);
      }
    }
    if (failed.length === sources.length) {
      const message = `Failed to fetch any resources of this cluster${firstError ? `: ${firstError}` : ""}`;
      if (initial) {
        loadError.value = message;
        loading.value = false;
      } else {
        refreshError.value = message;
      }
      return;
    }
    refreshError.value = null;
    loadError.value = null;

    let changed = initial;
    for (const source of sources) {
      const items = source.controller.items();
      if (!sameItems(items, source.items)) {
        source.items = items;
        changed = true;
      }
    }
    const nextFailedKey = failed.map(qualifiedResourceName).join(",");
    if (nextFailedKey !== failedKey) {
      failedKey = nextFailedKey;
      failedResources.value = failed;
      changed = true;
    }

    let watching = 0;
    let polling = 0;
    for (const source of sources) {
      if (isMetadataOnly(source.resource)) continue;
      for (const sourceMode of source.controller.modes().values()) {
        if (sourceMode === "watch") watching++;
        else polling++;
      }
    }
    mode.value = polling === 0 ? "watch" : watching === 0 ? "poll" : "mixed";

    lastUpdated.value = new Date();
    if (!changed) return;

    const started = now();
    const wanted = new Set(current.namespaces);
    const seen = new Set<string>();
    const objects: GraphObject[] = [];
    for (const source of sources) {
      for (const object of source.items) {
        if (!object?.metadata) continue;
        const uid = object.metadata.uid;
        if (uid) {
          if (seen.has(uid)) continue;
          seen.add(uid);
        }
        const namespace = object.metadata.namespace;
        if (namespace && wanted.size > 0 && !wanted.has(namespace)) continue;
        objects.push(
          object.kind
            ? object
            : { ...object, kind: source.resource.kind }
        );
      }
    }
    const built = buildTopology(objects, {
      loadedKinds,
      namespaceInScope: (namespace) =>
        wanted.size === 0 || wanted.has(namespace),
    });
    const result = reconcileTopology(topology.value, built);
    lastBuildMs = now() - started;
    lastBuildAt = now();
    builds++;

    if (result.topology !== topology.value) {
      change.value = result.change;
      topology.value = result.topology;
    }
    timings.value = {
      fetchMs: initial ? now() - startedAt : (timings.value?.fetchMs ?? 0),
      buildMs: lastBuildMs,
      objects: objects.length,
      builds,
    };
    loading.value = false;
    refreshing.value = false;
  };

  /* ------------------------------------------------------- lifecycle -- */

  const stop = () => {
    for (const source of sources) source.controller.dispose();
    sources = [];
    clearTimeout(buildTimer);
    clearTimeout(initialTimer);
    clearTimeout(refreshTimer);
    buildQueued = false;
  };

  const start = async (mode: "reload" | "rediscover" | "restart") => {
    stop();
    const thisGeneration = ++generation;
    const current = scope.value;
    if (mode !== "restart") {
      topology.value = null;
      change.value = null;
      failedResources.value = [];
      failedKey = "";
    }
    loadError.value = null;
    refreshError.value = null;
    if (!current?.context) {
      loading.value = false;
      return;
    }
    loading.value = topology.value === null;
    progress.value = { done: 0, total: 0 };
    startedAt = now();
    lastBuildAt = -Infinity;
    builds = 0;
    initialTimedOut = false;

    const service = discovery();
    const snapshot = await service
      .load(current.context, current.kubeConfig, {
        force: mode === "rediscover",
      })
      .catch(() => null);
    if (thisGeneration !== generation) return;
    if (!snapshot) {
      const reason = service.get(current.context, current.kubeConfig).error
        .value;
      loadError.value = `API discovery failed${reason ? `: ${reason}` : ""}`;
      loading.value = false;
      return;
    }
    const resources = graphResourcesOf(snapshot);
    if (resources.length === 0) {
      topology.value = buildTopology([]);
      loading.value = false;
      return;
    }

    const forcePolling = options.forcePolling?.() ?? false;
    progress.value = { done: 0, total: resources.length };
    sources = resources.map((resource) => {
      const metadataOnly = isMetadataOnly(resource);
      return {
        resource,
        items: [],
        controller: new WatchedListController<GraphObject>(
          {
            resource: qualifiedResourceName(resource),
            kind: metadataOnly ? METADATA_KIND : resource.kind,
            fallback: (target) => listResource(resource, target),
            fallbackInterval: pollInterval,
            forcePolling: forcePolling || metadataOnly,
            transport,
          },
          () => {
            if (thisGeneration === generation) schedule();
          }
        ),
      };
    });
    for (const source of sources) {
      source.controller.setTargets([
        {
          context: current.context,
          kubeConfig: current.kubeConfig,
          namespaces: namespaceTargets(source.resource, current.namespaces),
        },
      ]);
    }
    initialTimer = setTimeout(() => {
      if (thisGeneration !== generation || topology.value) return;
      const pending = sources
        .filter((source) => source.controller.loading())
        .map((source) => qualifiedResourceName(source.resource));
      if (pending.length > 0) {
        logInfo(`Resource graph: still loading ${pending.join(", ")}, showing what has loaded`);
      }
      initialTimedOut = true;
      schedule();
    }, INITIAL_LOAD_TIMEOUT);
  };

  const onVisibility = () => {
    for (const source of sources) source.controller.visibilityChanged();
  };
  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", onVisibility);
  }

  const scopeKey = () =>
    scope.value
      ? JSON.stringify([
          scope.value.kubeConfig,
          scope.value.context,
          scope.value.namespaces,
        ])
      : "";
  watch(scopeKey, () => start("reload"), { immediate: true });
  watch(
    () => options.forcePolling?.() ?? false,
    () => start("restart")
  );
  watch(paused, (value) => {
    if (!value) schedule();
  });

  onScopeDispose(() => {
    generation++;
    stop();
    if (typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", onVisibility);
    }
  });

  return {
    topology,
    change,
    loading,
    refreshing,
    progress,
    failedResources,
    loadError,
    refreshError,
    lastUpdated,
    timings,
    paused,
    mode,
    /** Re-poll / reconnect now, keeping the graph. */
    refresh: () => {
      if (sources.length === 0) {
        start("restart");
        return;
      }
      refreshing.value = true;
      for (const source of sources) source.controller.retry();
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => (refreshing.value = false), 1200);
      schedule();
    },
    /** Retry after an error: rediscover the API and load again. */
    retry: () => start("rediscover"),
  };
}

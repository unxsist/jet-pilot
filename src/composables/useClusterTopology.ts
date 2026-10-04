import { Ref, shallowRef, ref, watch, onMounted, onBeforeUnmount } from "vue";
import type { V1APIResource } from "@kubernetes/client-node";
import { Kubernetes } from "@/services/Kubernetes";
import { error as logError } from "@/lib/logger";
import {
  DiscoveredResource,
  GraphObject,
  Topology,
  buildTopology,
  dedupeResources,
  mapWithConcurrency,
  qualifiedResourceName,
  selectGraphResources,
  GRAPH_RESOURCES,
} from "@/lib/clusterGraph";

/** Maximum number of concurrent kubectl processes. */
const MAX_CONCURRENT_REQUESTS = 6;
/** Live refresh interval of the graph. */
export const GRAPH_REFRESH_INTERVAL = 15_000;

export interface GraphScope {
  context: string;
  kubeConfig: string;
  /** Namespaces to show; [] = all namespaces. */
  namespaces: string[];
}

export interface GraphTimings {
  fetchMs: number;
  buildMs: number;
  objects: number;
}

/*
 * API discovery is slow (one call per API group) and rarely changes: cache
 * the graphable resources per context for the session.
 */
const discoveryCache = new Map<string, Promise<DiscoveredResource[]>>();

const GRAPH_GROUPS = new Set(GRAPH_RESOURCES.map((resource) => resource.group));

async function discoverGraphResources(
  context: string,
  kubeConfig: string
): Promise<DiscoveredResource[]> {
  const toDiscovered = (group: string) => (resource: V1APIResource) => ({
    name: resource.name,
    group,
    kind: resource.kind,
    namespaced: resource.namespaced,
  });
  const resources: DiscoveredResource[] = [];

  const versions = await Kubernetes.getCoreApiVersions(context, kubeConfig);
  for (const version of versions) {
    const core = await Kubernetes.getCoreApiResources(
      context,
      version,
      kubeConfig
    );
    resources.push(
      ...core.filter((r) => !r.name.includes("/")).map(toDiscovered(""))
    );
  }

  // Only the API groups the graph knows how to relate.
  const groups = (await Kubernetes.getApiGroups(context, kubeConfig)).filter(
    (group) => GRAPH_GROUPS.has(group.name)
  );
  const results = await mapWithConcurrency(
    groups,
    MAX_CONCURRENT_REQUESTS,
    (group) =>
      Kubernetes.getApiGroupResources(
        context,
        group.preferredVersion?.groupVersion || "",
        kubeConfig
      )
  );
  results.forEach((result, i) => {
    if (result.status === "rejected") {
      logError(
        `Error fetching resources for group ${groups[i].name}: ${result.reason}`
      );
      return;
    }
    resources.push(
      ...result.value
        .filter((r) => !r.name.includes("/"))
        .map(toDiscovered(groups[i].name))
    );
  });

  return selectGraphResources(dedupeResources(resources));
}

function discover(context: string, kubeConfig: string, fresh: boolean) {
  const cacheKey = `${kubeConfig}\n${context}`;
  if (fresh || !discoveryCache.has(cacheKey)) {
    const pending = discoverGraphResources(context, kubeConfig);
    // A failed discovery is retried next time.
    pending.catch(() => discoveryCache.delete(cacheKey));
    discoveryCache.set(cacheKey, pending);
  }
  return discoveryCache.get(cacheKey)!;
}

/* Secrets Helm keeps its release history in: big, never graphed. */
const isHelmReleaseSecret = (object: GraphObject) =>
  object.kind === "Secret" &&
  String(object.type || "").startsWith("helm.sh/release");

async function fetchResource(
  resource: DiscoveredResource,
  scope: GraphScope,
  namespace: string | null
): Promise<GraphObject[]> {
  const args = [
    "get",
    qualifiedResourceName(resource),
    "--context",
    scope.context,
    "-o",
    "json",
    "--request-timeout=30s",
  ];
  if (scope.kubeConfig) args.push("--kubeconfig", scope.kubeConfig);
  if (resource.namespaced !== false) {
    if (namespace) args.push("--namespace", namespace);
    else args.push("--all-namespaces");
  }

  const items: GraphObject[] =
    JSON.parse(await Kubernetes.kubectl(args)).items || [];
  const result: GraphObject[] = [];
  for (const item of items) {
    if (!item.metadata) continue;
    // kubectl lists do not always carry the kind of their items.
    item.kind = item.kind || resource.kind;
    if (isHelmReleaseSecret(item)) continue;
    // Managed fields are large and never shown.
    delete item.metadata.managedFields;
    // Tag objects with their origin so actions target the right cluster.
    item.metadata.context = scope.context;
    item.metadata.kubeConfig = scope.kubeConfig;
    result.push(item);
  }
  return result;
}

/**
 * Fetches the graphable objects of a scope and builds the topology, live:
 * a full load when the scope changes, background refreshes every
 * GRAPH_REFRESH_INTERVAL (paused while the window is hidden; a refresh is
 * skipped while one is in flight). Newer loads supersede older ones.
 */
export function useClusterTopology(scope: Ref<GraphScope | null>) {
  const topology = shallowRef<Topology | null>(null);
  /** First load of a scope (the graph is empty meanwhile). */
  const loading = ref(false);
  /** A background refresh is running. */
  const refreshing = ref(false);
  const progress = ref({ done: 0, total: 0 });
  /** Resources that failed to load in the last load. */
  const failedResources = ref<DiscoveredResource[]>([]);
  /** Nothing could be loaded (first load) / the last refresh failed. */
  const loadError = ref<string | null>(null);
  const refreshError = ref<string | null>(null);
  const lastUpdated = ref<Date | null>(null);
  const timings = ref<GraphTimings | null>(null);
  const paused = ref(false);

  let generation = 0;
  let inFlight = false;

  const load = async (
    mode: "reload" | "refresh" | "manual" | "rediscover"
  ) => {
    const current = scope.value;
    if (mode === "refresh" && (inFlight || paused.value)) return;
    if (mode === "manual") {
      if (inFlight) return;
      mode = "refresh";
    }
    const thisGeneration = ++generation;
    const isCurrent = () => thisGeneration === generation;

    if (!current?.context) {
      topology.value = null;
      loading.value = false;
      return;
    }

    inFlight = true;
    if (mode !== "refresh") {
      loading.value = topology.value === null || mode === "reload";
      loadError.value = null;
      progress.value = { done: 0, total: 0 };
      if (mode === "reload") topology.value = null;
    }
    refreshing.value = true;

    const started = performance.now();
    try {
      const resources = await discover(
        current.context,
        current.kubeConfig,
        mode === "rediscover"
      );
      if (!isCurrent()) return;

      // One call per namespace when a few are selected (works with
      // namespace-scoped RBAC), one --all-namespaces call otherwise.
      const namespaces: (string | null)[] =
        current.namespaces.length > 0 && current.namespaces.length <= 4
          ? current.namespaces
          : [null];
      const tasks = resources.flatMap((resource) =>
        resource.namespaced === false
          ? [{ resource, namespace: null }]
          : namespaces.map((namespace) => ({ resource, namespace }))
      );
      if (mode !== "refresh") progress.value = { done: 0, total: tasks.length };

      const results = await mapWithConcurrency(
        tasks,
        MAX_CONCURRENT_REQUESTS,
        async (task) => {
          try {
            return await fetchResource(task.resource, current, task.namespace);
          } finally {
            if (isCurrent() && mode !== "refresh") progress.value.done++;
          }
        }
      );
      if (!isCurrent()) return;
      const fetchMs = performance.now() - started;

      const failed = new Map<string, DiscoveredResource>();
      const loadedKinds = new Set<string>();
      const objects: GraphObject[] = [];
      const seen = new Set<string>();
      const wanted = new Set(current.namespaces);
      results.forEach((result, i) => {
        const { resource } = tasks[i];
        if (result.status === "rejected") {
          failed.set(qualifiedResourceName(resource), resource);
          logError(
            `Failed to fetch ${qualifiedResourceName(resource)}: ${result.reason}`
          );
          return;
        }
        for (const object of result.value) {
          const uid = object.metadata.uid;
          if (uid) {
            if (seen.has(uid)) continue;
            seen.add(uid);
          }
          const namespace = object.metadata.namespace;
          if (namespace && wanted.size > 0 && !wanted.has(namespace)) continue;
          objects.push(object);
        }
      });
      for (const resource of resources) {
        if (!failed.has(qualifiedResourceName(resource))) {
          loadedKinds.add(resource.kind);
        }
      }

      if (resources.length > 0 && failed.size === resources.length) {
        throw new Error("Failed to fetch any resources of this cluster");
      }

      const buildStarted = performance.now();
      const built = buildTopology(objects, {
        loadedKinds,
        namespaceInScope: (namespace) =>
          wanted.size === 0 || wanted.has(namespace),
      });
      const buildMs = performance.now() - buildStarted;

      topology.value = built;
      failedResources.value = [...failed.values()];
      timings.value = { fetchMs, buildMs, objects: objects.length };
      lastUpdated.value = new Date();
      refreshError.value = null;
      loadError.value = null;
    } catch (e) {
      if (!isCurrent()) return;
      const message = e instanceof Error ? e.message : String(e);
      logError(`Failed to load the resource graph: ${message}`);
      if (topology.value) refreshError.value = message;
      else loadError.value = message;
    } finally {
      if (isCurrent()) {
        inFlight = false;
        loading.value = false;
        refreshing.value = false;
      }
    }
  };

  /* Polling, paused while the document is hidden. */
  let timer: ReturnType<typeof setInterval> | null = null;
  const stop = () => {
    if (timer) clearInterval(timer);
    timer = null;
  };
  const start = () => {
    stop();
    if (document.hidden) return;
    timer = setInterval(() => load("refresh"), GRAPH_REFRESH_INTERVAL);
  };
  const onVisibility = () => {
    if (document.hidden) {
      stop();
    } else {
      load("refresh");
      start();
    }
  };

  onMounted(() => {
    document.addEventListener("visibilitychange", onVisibility);
    load("reload");
    start();
  });
  onBeforeUnmount(() => {
    document.removeEventListener("visibilitychange", onVisibility);
    stop();
    generation++;
  });

  const scopeKey = () =>
    scope.value
      ? `${scope.value.kubeConfig}\n${scope.value.context}\n${scope.value.namespaces.join(",")}`
      : "";
  watch(scopeKey, () => {
    load("reload");
    start();
  });

  return {
    topology,
    loading,
    refreshing,
    progress,
    failedResources,
    loadError,
    refreshError,
    lastUpdated,
    timings,
    paused,
    /** Refresh now, keeping the graph. */
    refresh: () => load("manual"),
    /** Retry after an error: rediscover the API and load again. */
    retry: () => {
      load("rediscover");
      start();
    },
  };
}

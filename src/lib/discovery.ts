/**
 * Shared API discovery service: one discovery per (kubeconfig, context).
 *
 * - In-memory cache + on-disk cache (`discovery-cache.json` in the app config
 *   dir), so the navigation (and anything else listing kinds) renders
 *   instantly on start and when switching back to a context.
 * - Stale-while-revalidate: cached data is returned right away; it is
 *   revalidated in the background when it came from disk (once per session)
 *   or is older than `ttlMs`. Concurrent requests share one fetch.
 * - Bounded fan-out: the default fetcher runs at most `concurrency` discovery
 *   requests per context at a time.
 * - Partial failures keep the previously known resources of the failed
 *   groups; a total failure keeps the whole cached snapshot (status "error").
 *
 * Usage in components: `useDiscovery(contextRef, kubeConfigRef)`.
 * Elsewhere: `getDiscoveryService().load(context, kubeConfig)`.
 * The fetcher is pluggable (`createDiscoveryService({ fetcher })`), e.g. for
 * an aggregated-discovery (apidiscovery.k8s.io/v2) backend command.
 */
import {
  computed,
  onScopeDispose,
  ref,
  shallowRef,
  watch,
  type Ref,
  type ShallowRef,
} from "vue";

/** A slim, serializable API resource (subset of V1APIResource). */
export interface DiscoveredResource {
  /** Plural resource name, e.g. "deployments". */
  name: string;
  kind: string;
  namespaced: boolean;
  /** "" for the core group. */
  group: string;
  version: string;
  verbs: string[];
  shortNames?: string[];
  singularName?: string;
}

/**
 * Resources grouped like the navigation expects: core resources under their
 * group version ("v1"), others under the API group name ("apps",
 * "networking.k8s.io").
 */
export type DiscoveryGroups = Record<string, DiscoveredResource[]>;

export interface DiscoverySnapshot {
  context: string;
  kubeConfig: string;
  /** Epoch ms of the (last successful) fetch. */
  fetchedAt: number;
  groups: DiscoveryGroups;
}

export type DiscoveryStatus =
  /** Nothing known yet, nothing in flight. */
  | "idle"
  /** Fetching without anything cached. */
  | "loading"
  /** Showing cached data, revalidating in the background. */
  | "revalidating"
  /** Up to date (fetched this session, within the TTL). */
  | "fresh"
  /** The last fetch failed; `snapshot` (if any) is the last known data. */
  | "error";

export interface DiscoveryFetchResult {
  groups: DiscoveryGroups;
  /** Group keys that failed to load (their previous data is kept). */
  failedGroups?: string[];
}

export type DiscoveryFetcher = (
  context: string,
  kubeConfig: string
) => Promise<DiscoveryFetchResult>;

export interface DiscoveryStorage {
  load(): Promise<DiscoverySnapshot[] | null>;
  save(snapshots: DiscoverySnapshot[]): Promise<void>;
}

export interface DiscoveryEntry {
  readonly key: string;
  readonly snapshot: ShallowRef<DiscoverySnapshot | null>;
  readonly status: Ref<DiscoveryStatus>;
  readonly error: Ref<string | null>;
}

export interface DiscoveryServiceOptions {
  fetcher: DiscoveryFetcher;
  storage?: DiscoveryStorage;
  /** Revalidate data older than this (ms). Default 5 minutes. */
  ttlMs?: number;
  /** Contexts kept in memory and on disk (least recently used dropped). */
  maxEntries?: number;
  /** Debounce of disk writes (ms). */
  persistDebounceMs?: number;
  now?: () => number;
  onError?: (message: string) => void;
}

export const discoveryKey = (context: string, kubeConfig: string) =>
  `${kubeConfig}\u0000${context}`;

export function createDiscoveryService(options: DiscoveryServiceOptions) {
  const {
    fetcher,
    storage,
    ttlMs = 5 * 60_000,
    maxEntries = 24,
    persistDebounceMs = 500,
    now = () => Date.now(),
    onError = () => {},
  } = options;

  const entries = new Map<string, DiscoveryEntry>();
  /** Keys fetched successfully in this session (disk data is "stale"). */
  const fetchedThisSession = new Set<string>();
  const inFlight = new Map<string, Promise<DiscoverySnapshot | null>>();
  /** Most recently used last. */
  const lru: string[] = [];

  const touch = (key: string) => {
    const index = lru.indexOf(key);
    if (index >= 0) lru.splice(index, 1);
    lru.push(key);
    while (lru.length > maxEntries) {
      const evicted = lru.shift()!;
      entries.delete(evicted);
      fetchedThisSession.delete(evicted);
    }
  };

  const entryFor = (key: string): DiscoveryEntry => {
    let entry = entries.get(key);
    if (!entry) {
      entry = {
        key,
        snapshot: shallowRef(null),
        status: ref("idle"),
        error: ref(null),
      };
      entries.set(key, entry);
    }
    touch(key);
    return entry;
  };

  /* ------------------------------------------------------------ disk -- */

  let persistTimer: ReturnType<typeof setTimeout> | null = null;
  let persistQueue: Promise<void> = Promise.resolve();

  const persist = () => {
    if (!storage) return;
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      persistTimer = null;
      const snapshots = lru
        .map((key) => entries.get(key)?.snapshot.value)
        .filter((s): s is DiscoverySnapshot => !!s);
      persistQueue = persistQueue
        .then(() => storage.save(snapshots))
        .catch((e) => onError(`Failed to save the discovery cache: ${e}`));
    }, persistDebounceMs);
  };

  const hydrated: Promise<void> = storage
    ? storage
        .load()
        .then((snapshots) => {
          for (const snapshot of snapshots || []) {
            if (!isSnapshot(snapshot)) continue;
            const entry = entryFor(
              discoveryKey(snapshot.context, snapshot.kubeConfig)
            );
            // Never replace data fetched while the disk was being read.
            if (!entry.snapshot.value) {
              entry.snapshot.value = snapshot;
            }
          }
        })
        .catch((e) => onError(`Failed to read the discovery cache: ${e}`))
    : Promise.resolve();

  /* ----------------------------------------------------------- fetch -- */

  const isFresh = (key: string) => {
    const snapshot = entries.get(key)?.snapshot.value;
    return (
      !!snapshot &&
      fetchedThisSession.has(key) &&
      now() - snapshot.fetchedAt < ttlMs
    );
  };

  const fetchEntry = (
    context: string,
    kubeConfig: string
  ): Promise<DiscoverySnapshot | null> => {
    const key = discoveryKey(context, kubeConfig);
    const running = inFlight.get(key);
    if (running) return running;

    const entry = entryFor(key);
    entry.status.value = entry.snapshot.value ? "revalidating" : "loading";

    const promise = fetcher(context, kubeConfig)
      .then((result) => {
        const previous = entry.snapshot.value?.groups || {};
        const groups: DiscoveryGroups = { ...result.groups };
        for (const failed of result.failedGroups || []) {
          if (!groups[failed] && previous[failed]) {
            groups[failed] = previous[failed];
          }
        }

        const snapshot: DiscoverySnapshot = {
          context,
          kubeConfig,
          fetchedAt: now(),
          groups,
        };
        entry.snapshot.value = snapshot;
        entry.status.value = "fresh";
        entry.error.value = null;
        fetchedThisSession.add(key);
        persist();
        return snapshot;
      })
      .catch((e) => {
        const message = e instanceof Error ? e.message : String(e);
        entry.status.value = "error";
        entry.error.value = message;
        onError(`Discovery failed for ${context}: ${message}`);
        return entry.snapshot.value;
      })
      .finally(() => {
        inFlight.delete(key);
      });

    inFlight.set(key, promise);
    return promise;
  };

  /**
   * The (reactive) entry of a context. Starts a background revalidation
   * when the data is missing, from disk, or older than the TTL.
   */
  const get = (context: string, kubeConfig: string): DiscoveryEntry => {
    const key = discoveryKey(context, kubeConfig);
    const entry = entryFor(key);
    if (!context) return entry;

    if (!entry.snapshot.value && !inFlight.has(key)) {
      entry.status.value = "loading";
    }

    hydrated.then(() => {
      if (!isFresh(key)) {
        fetchEntry(context, kubeConfig);
      } else if (entry.status.value !== "fresh" && !inFlight.has(key)) {
        entry.status.value = "fresh";
      }
    });
    return entry;
  };

  /**
   * Resolves with up-to-date data: cached data within the TTL, otherwise
   * the result of a fetch (`force` always fetches). Resolves with the last
   * known data (or null) when the fetch fails.
   */
  const load = async (
    context: string,
    kubeConfig: string,
    { force = false } = {}
  ): Promise<DiscoverySnapshot | null> => {
    await hydrated;
    const key = discoveryKey(context, kubeConfig);
    entryFor(key);
    if (!force && isFresh(key)) {
      return entries.get(key)!.snapshot.value;
    }
    return fetchEntry(context, kubeConfig);
  };

  /** Cached data without triggering a fetch. */
  const peek = (context: string, kubeConfig: string) =>
    entries.get(discoveryKey(context, kubeConfig))?.snapshot.value ?? null;

  /** Marks a context's data stale (e.g. after installing CRDs). */
  const invalidate = (context: string, kubeConfig: string) => {
    fetchedThisSession.delete(discoveryKey(context, kubeConfig));
  };

  return { get, load, peek, invalidate, hydrated };
}

export type DiscoveryService = ReturnType<typeof createDiscoveryService>;

function isSnapshot(value: unknown): value is DiscoverySnapshot {
  const s = value as DiscoverySnapshot;
  return (
    !!s &&
    typeof s.context === "string" &&
    typeof s.kubeConfig === "string" &&
    typeof s.fetchedAt === "number" &&
    !!s.groups &&
    typeof s.groups === "object"
  );
}

/* --------------------------------------------------------- helpers -- */

/** Every resource of a snapshot (top-level only, no subresources). */
export function flattenResources(
  snapshot: DiscoverySnapshot | null | undefined
): DiscoveredResource[] {
  if (!snapshot) return [];
  return Object.values(snapshot.groups)
    .flat()
    .filter((resource) => !resource.name.includes("/"));
}

/**
 * Finds a resource by plural name, singular name, kind or short name
 * (case-insensitive), e.g. "deploy", "Deployment", "deployments".
 * Core and well-known groups win over CRDs with the same name.
 */
export function findResource(
  snapshot: DiscoverySnapshot | null | undefined,
  query: string
): DiscoveredResource | undefined {
  const q = query.trim().toLowerCase();
  if (!q) return undefined;
  const matches = flattenResources(snapshot).filter(
    (r) =>
      r.name.toLowerCase() === q ||
      r.kind.toLowerCase() === q ||
      r.singularName?.toLowerCase() === q ||
      r.shortNames?.some((s) => s.toLowerCase() === q)
  );
  return matches.sort((a, b) => groupRank(a.group) - groupRank(b.group))[0];
}

const groupRank = (group: string) =>
  group === "" ? 0 : !group.includes(".") || group.endsWith(".k8s.io") ? 1 : 2;

/** Maps a V1APIResource-like object of `groupVersion` to the slim shape. */
export function toDiscoveredResource(
  resource: {
    name: string;
    kind: string;
    namespaced?: boolean;
    verbs?: string[];
    shortNames?: string[];
    singularName?: string;
    group?: string;
    version?: string;
  },
  groupVersion: string
): DiscoveredResource {
  const [group, version] = groupVersion.includes("/")
    ? groupVersion.split("/")
    : ["", groupVersion];
  return {
    name: resource.name,
    kind: resource.kind,
    namespaced: !!resource.namespaced,
    group: resource.group || group,
    version: resource.version || version,
    verbs: resource.verbs || [],
    ...(resource.shortNames?.length ? { shortNames: resource.shortNames } : {}),
    ...(resource.singularName ? { singularName: resource.singularName } : {}),
  };
}

/** Runs `tasks` with at most `concurrency` of them in flight. */
export async function runLimited<T>(
  tasks: (() => Promise<T>)[],
  concurrency: number
): Promise<PromiseSettledResult<T>[]> {
  const results: PromiseSettledResult<T>[] = new Array(tasks.length);
  let next = 0;
  const worker = async () => {
    while (next < tasks.length) {
      const index = next++;
      try {
        results[index] = { status: "fulfilled", value: await tasks[index]() };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, tasks.length) }, worker)
  );
  return results;
}

/* --------------------------------------------- app singleton (Tauri) -- */

const CACHE_FILE = "discovery-cache.json";
const CACHE_VERSION = 1;

/** Discovery through the existing backend commands, max 6 requests at once. */
export const commandDiscoveryFetcher: DiscoveryFetcher = async (
  context,
  kubeConfig
) => {
  const { Kubernetes } = await import("@/services/Kubernetes");
  const [versions, apiGroups] = await Promise.allSettled([
    Kubernetes.getCoreApiVersions(context, kubeConfig),
    Kubernetes.getApiGroups(context, kubeConfig),
  ]);
  if (versions.status === "rejected" && apiGroups.status === "rejected") {
    throw versions.reason;
  }

  const requests: { key: string; groupVersion: string }[] = [
    ...(versions.status === "fulfilled" ? versions.value : []).map(
      (version) => ({ key: version, groupVersion: version })
    ),
    ...(apiGroups.status === "fulfilled" ? apiGroups.value : []).map(
      (group) => ({
        key: group.name,
        groupVersion: group.preferredVersion?.groupVersion ?? "",
      })
    ),
  ].filter((r) => r.groupVersion);

  const results = await runLimited(
    requests.map(({ key, groupVersion }) => () =>
      (key === groupVersion && !groupVersion.includes("/")
        ? Kubernetes.getCoreApiResources(context, groupVersion, kubeConfig)
        : Kubernetes.getApiGroupResources(context, groupVersion, kubeConfig)
      ).then((resources) =>
        resources.map((r) => toDiscoveredResource(r as any, groupVersion))
      )
    ),
    6
  );

  const groups: DiscoveryGroups = {};
  const failedGroups: string[] = [];
  results.forEach((result, index) => {
    if (result.status === "fulfilled") {
      groups[requests[index].key] = result.value;
    } else {
      failedGroups.push(requests[index].key);
    }
  });
  if (requests.length > 0 && failedGroups.length === requests.length) {
    throw (results[0] as PromiseRejectedResult).reason;
  }
  return { groups, failedGroups };
};

/** The on-disk cache in the app config directory. */
export const appConfigDiscoveryStorage: DiscoveryStorage = {
  async load() {
    const { BaseDirectory, exists, readTextFile } = await import(
      "@tauri-apps/plugin-fs"
    );
    if (!(await exists(CACHE_FILE, { baseDir: BaseDirectory.AppConfig }))) {
      return null;
    }
    const data = JSON.parse(
      await readTextFile(CACHE_FILE, { baseDir: BaseDirectory.AppConfig })
    );
    return data?.version === CACHE_VERSION && Array.isArray(data.entries)
      ? data.entries
      : null;
  },
  async save(snapshots) {
    const { BaseDirectory, exists, mkdir, writeTextFile } = await import(
      "@tauri-apps/plugin-fs"
    );
    if (!(await exists("", { baseDir: BaseDirectory.AppConfig }))) {
      await mkdir("", { baseDir: BaseDirectory.AppConfig, recursive: true });
    }
    await writeTextFile(
      CACHE_FILE,
      JSON.stringify({ version: CACHE_VERSION, entries: snapshots }),
      { baseDir: BaseDirectory.AppConfig }
    );
  },
};

let service: DiscoveryService | null = null;

/** The app-wide discovery service (created on first use). */
export function getDiscoveryService(): DiscoveryService {
  if (!service) {
    service = createDiscoveryService({
      fetcher: commandDiscoveryFetcher,
      storage: appConfigDiscoveryStorage,
      onError: (message) =>
        import("@/lib/logger").then(({ error }) => error(message)),
    });
  }
  return service;
}

/**
 * Discovery of a (reactive) context for components. Follows context /
 * kubeconfig changes; `refresh()` forces a re-fetch (e.g. after login).
 */
export function useDiscovery(
  context: Ref<string>,
  kubeConfig: Ref<string>,
  discovery: DiscoveryService = getDiscoveryService()
) {
  const entry = shallowRef<DiscoveryEntry>(
    discovery.get(context.value, kubeConfig.value)
  );
  const stop = watch([context, kubeConfig], ([c, k]) => {
    entry.value = discovery.get(c, k);
  });
  onScopeDispose(stop);

  const snapshot = computed(() =>
    context.value ? entry.value.snapshot.value : null
  );

  return {
    snapshot,
    status: computed(() => entry.value.status.value),
    error: computed(() => entry.value.error.value),
    resources: computed(() => flattenResources(snapshot.value)),
    refresh: () =>
      discovery.load(context.value, kubeConfig.value, { force: true }),
  };
}

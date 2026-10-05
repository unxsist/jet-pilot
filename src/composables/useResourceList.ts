import { nextTick, ref, shallowRef, WatchSource } from "vue";
import { useDataRefresher } from "./refresher";
import { error as logError } from "@/lib/logger";
import { markFirstData } from "@/lib/perf";

export interface ContextFailure {
  context: string;
  reason: unknown;
}

export interface ResourceListResult<T> {
  items: T[];
  /** Contexts that failed to load (unhandled failures only). */
  failures?: ContextFailure[];
  /** Number of contexts a fetch was attempted for. */
  attempted?: number;
}

export interface ResourceListError {
  message: string;
  /** Nothing could be loaded: polling is stopped until retried. */
  fatal: boolean;
}

const reasonToString = (reason: unknown) =>
  reason instanceof Error ? reason.message : String(reason);

/**
 * Turns per-context failures into a single error: fatal when every attempted
 * context failed, a (non-fatal) warning when only some of them did.
 */
export function describeFailures(
  failures: ContextFailure[],
  attempted: number
): ResourceListError | null {
  if (failures.length === 0) {
    return null;
  }

  if (failures.length >= attempted) {
    return {
      fatal: true,
      message:
        failures.length === 1
          ? reasonToString(failures[0].reason)
          : `Failed to load from any of the active contexts (${failures
              .map((f) => f.context)
              .join(", ")})`,
    };
  }

  return {
    fatal: false,
    message:
      failures.length === 1
        ? `Failed to load from ${failures[0].context}: ${reasonToString(
            failures[0].reason
          )}`
        : `Failed to load from ${failures.map((f) => f.context).join(", ")}`,
  };
}

export type LoadMode = "reload" | "refresh" | "retry";

/**
 * Shared list-view data handling (GenericResource, Pods, Helm):
 *
 * - `reload` clears the list and shows the loading state; `refresh` (interval
 *   ticks) is skipped while a fetch is in flight; `retry` fetches right away
 *   and keeps the (stale) rows visible.
 * - Newer fetches supersede older ones (generation counter), so stale results
 *   never overwrite fresh ones.
 * - Errors are exposed (not toasted) so the view can show a persistent banner;
 *   when everything failed, polling stops until `retry`.
 */
export function useResourceList<T>(
  load: (isCurrent: () => boolean) => Promise<ResourceListResult<T>>,
  options: { interval: number; dependencies?: (WatchSource | object)[] }
) {
  const items = shallowRef<T[]>([]);
  const loading = ref(false);
  const error = ref<ResourceListError | null>(null);
  const lastUpdated = ref<Date | null>(null);

  let generation = 0;
  let inFlight = false;

  const fetchData = async (mode: LoadMode) => {
    if (mode === "refresh" && inFlight) {
      return;
    }

    const current = ++generation;
    const isCurrent = () => current === generation;
    inFlight = true;

    if (mode === "reload") {
      items.value = [];
      error.value = null;
      lastUpdated.value = null;
    }
    if (mode !== "refresh") {
      loading.value = true;
    }

    try {
      const result = await load(isCurrent);
      if (!isCurrent()) {
        return;
      }

      const failure = describeFailures(
        result.failures || [],
        result.attempted ?? 1
      );

      // On a fatal failure keep showing the last known rows (marked stale).
      if (!failure?.fatal) {
        items.value = result.items;
        lastUpdated.value = new Date();
        if (result.items.length > 0) nextTick(markFirstData);
      }

      error.value = failure;
      if (failure?.fatal) {
        stopRefreshing();
      }
    } catch (e) {
      if (!isCurrent()) {
        return;
      }

      logError(`Failed to load resources: ${e}`);
      error.value = { message: reasonToString(e), fatal: true };
      stopRefreshing();
    } finally {
      if (isCurrent()) {
        inFlight = false;
        loading.value = false;
      }
    }
  };

  const { startRefreshing, stopRefreshing, isRefreshing } = useDataRefresher(
    (refresh) => fetchData(refresh ? "refresh" : "reload"),
    options.interval,
    options.dependencies
  );

  /** Fetch immediately (keeping the current rows) and resume polling. */
  const retry = () => {
    fetchData("retry");
    startRefreshing();
  };

  /** Clear, fetch and (re)start polling, e.g. after switching resources. */
  const reload = () => {
    fetchData("reload");
    startRefreshing();
  };

  return {
    items,
    loading,
    error,
    lastUpdated,
    isRefreshing,
    retry,
    reload,
    refresh: () => fetchData("refresh"),
    startRefreshing,
    stopRefreshing,
  };
}

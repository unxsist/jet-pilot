import { nextTick, onScopeDispose, ref, shallowRef, WatchSource } from "vue";
import { useDataRefresher } from "./refresher";
import { error as logError } from "@/lib/logger";
import { markFirstData } from "@/lib/perf";
import { contextKey } from "@/lib/contextKey";
import { onRecovered, report } from "@/lib/auth/center";

export interface ContextFailure {
  context: string;
  /**
   * The context's kubeconfig. With it, failures a sign-in fixes go to the
   * auth center (notice + toast) instead of the error banner, and the list
   * reloads once signed in.
   */
  kubeConfig?: string;
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
 * - Failures a sign-in fixes are reported to the auth center instead (see
 *   ContextFailure.kubeConfig) and retried once the credential recovered.
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

  /* Contexts waiting for a sign-in: reload once it succeeded. */
  const signInWaits = new Map<string, () => void>();
  const withoutSignInFailures = (failures: ContextFailure[]) => {
    const waiting = new Set<string>();
    const rest = failures.filter((failure) => {
      if (failure.kubeConfig === undefined) return true;
      const target = { context: failure.context, kubeConfig: failure.kubeConfig };
      if (!report(target, failure.reason, "kubectl")) return true;
      const key = contextKey(target.context, target.kubeConfig);
      waiting.add(key);
      if (!signInWaits.has(key)) signInWaits.set(key, onRecovered(target, () => retry()));
      return false;
    });
    for (const [key, stop] of signInWaits) {
      if (waiting.has(key)) continue;
      stop();
      signInWaits.delete(key);
    }
    return rest;
  };
  onScopeDispose(() => {
    for (const stop of signInWaits.values()) stop();
    signInWaits.clear();
  });

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
        withoutSignInFailures(result.failures || []),
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

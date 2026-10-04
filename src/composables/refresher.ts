import { watch, onMounted, onBeforeUnmount, ref, WatchSource } from "vue";
import { useIsActiveView } from "@/lib/activeView";

/**
 * Periodically calls `method(true)` (a background refresh) every `interval`
 * ms, after an initial `method(false)` (a full load) on mount.
 *
 * - `startRefreshing` is idempotent: it always clears a running interval
 *   before starting a new one. `startRefreshing(true)` fetches immediately.
 * - A change in any of the `dependencies` triggers a full load and (re)starts
 *   polling, also when polling was stopped (e.g. after an error).
 * - Polling pauses while the document is hidden and refreshes right away when
 *   it becomes visible again.
 * - Same for hidden kept-alive views (see @/lib/activeView): no polling while
 *   deactivated; dependency changes in the meantime only mark the data
 *   stale and it is reloaded on activation (otherwise refreshed right away,
 *   keeping the rows).
 */
export function useDataRefresher(
  method: (refresh: boolean) => void,
  interval: number,
  dependencies: (WatchSource | object)[] = []
) {
  let refreshInterval: ReturnType<typeof setInterval> | null = null;
  const isRefreshing = ref(false);
  const active = useIsActiveView();
  let stale = false;

  const clearTimer = () => {
    if (refreshInterval !== null) {
      clearInterval(refreshInterval);
      refreshInterval = null;
    }
  };

  const startTimer = () => {
    clearTimer();
    if (typeof document !== "undefined" && document.hidden) {
      return;
    }
    if (!active.value) {
      return;
    }
    refreshInterval = setInterval(() => {
      method(true);
    }, interval);
  };

  const startRefreshing = (fetchNow = false) => {
    isRefreshing.value = true;
    startTimer();
    if (fetchNow && active.value) {
      method(true);
    }
  };

  const stopRefreshing = () => {
    clearTimer();
    isRefreshing.value = false;
  };

  const handleVisibilityChange = () => {
    if (!isRefreshing.value || !active.value) {
      return;
    }

    if (document.hidden) {
      clearTimer();
    } else {
      method(true);
      startTimer();
    }
  };

  watch(active, (isActive) => {
    if (!isActive) {
      clearTimer();
      return;
    }
    if (stale) {
      stale = false;
      method(false);
      startRefreshing();
    } else if (isRefreshing.value) {
      method(true);
      startTimer();
    }
  });

  onMounted(() => {
    document.addEventListener("visibilitychange", handleVisibilityChange);
    if (!active.value) {
      stale = true;
      isRefreshing.value = true;
      return;
    }
    method(false); // Initial fetch
    startRefreshing();
  });

  onBeforeUnmount(() => {
    document.removeEventListener("visibilitychange", handleVisibilityChange);
    stopRefreshing();
  });

  // React to changes in dependencies: reload and restart polling.
  dependencies.forEach((dep) => {
    watch(dep as WatchSource, () => {
      if (!active.value) {
        stale = true;
        return;
      }
      method(false);
      startRefreshing();
    });
  });

  return { startRefreshing, stopRefreshing, isRefreshing };
}

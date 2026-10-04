import { watch, onMounted, onBeforeUnmount, ref, WatchSource } from "vue";

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
 */
export function useDataRefresher(
  method: (refresh: boolean) => void,
  interval: number,
  dependencies: (WatchSource | object)[] = []
) {
  let refreshInterval: ReturnType<typeof setInterval> | null = null;
  const isRefreshing = ref(false);

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
    refreshInterval = setInterval(() => {
      method(true);
    }, interval);
  };

  const startRefreshing = (fetchNow = false) => {
    isRefreshing.value = true;
    startTimer();
    if (fetchNow) {
      method(true);
    }
  };

  const stopRefreshing = () => {
    clearTimer();
    isRefreshing.value = false;
  };

  const handleVisibilityChange = () => {
    if (!isRefreshing.value) {
      return;
    }

    if (document.hidden) {
      clearTimer();
    } else {
      method(true);
      startTimer();
    }
  };

  onMounted(() => {
    document.addEventListener("visibilitychange", handleVisibilityChange);
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
      method(false);
      startRefreshing();
    });
  });

  return { startRefreshing, stopRefreshing, isRefreshing };
}

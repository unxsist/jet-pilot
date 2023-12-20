import { watch, onMounted, onBeforeUnmount, ref } from "vue";

export function useDataRefresher(
  method: (refresh: boolean) => void,
  interval: number,
  dependencies: any[] = []
) {
  let refreshInterval: NodeJS.Timer;

  const startRefreshing = () => {
    refreshInterval = setInterval(() => {
      method(true);
    }, interval);
  };

  const stopRefreshing = () => {
    clearInterval(refreshInterval);
  };

  onMounted(() => {
    method(false); // Initial fetch
    startRefreshing();
  });

  onBeforeUnmount(() => {
    stopRefreshing();
  });

  // React to changes in dependencies
  dependencies.forEach((dep) => {
    watch(dep, () => {
      method(false); // Refresh on dependency change
    });
  });

  return { startRefreshing, stopRefreshing };
}

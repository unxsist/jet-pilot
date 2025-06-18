import { watch, onMounted, onBeforeUnmount, ref } from "vue";

export function useDataRefresher(
  method: (refresh: boolean) => void,
  interval: number,
  dependencies: any[] = []
) {
  let refreshInterval: NodeJS.Timer;
  const isRefreshing = ref(false);

  const startRefreshing = () => {
    refreshInterval = setInterval(() => {
      method(true);
    }, interval);
    isRefreshing.value = true;
  };

  const stopRefreshing = () => {
    clearInterval(refreshInterval);
    isRefreshing.value = false;
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
      console.log("Dependency changed, refreshing data");
    });
  });

  return { startRefreshing, stopRefreshing, isRefreshing };
}

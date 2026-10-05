/*
 * Cluster metadata in components (and, through the runtime settings, in
 * table cell renderers and other non-component code).
 */
import { computed } from "vue";
import { injectStrict } from "@/lib/utils";
import { SettingsContextStateKey } from "@/providers/SettingsContextProvider";
import { runtimeSettings } from "@/lib/settings/runtime";
import {
  resolveCluster,
  updateRecords,
  type ClusterMeta,
  type ResolvedCluster,
} from "./meta";

export function useClusters() {
  const { settings } = injectStrict(SettingsContextStateKey);
  const records = computed(() => settings.value.clusters ?? []);

  return {
    records,
    resolve: (context: string, kubeConfig?: string): ResolvedCluster =>
      resolveCluster(records.value, context, kubeConfig),
    update(context: string, kubeConfig: string, patch: Partial<ClusterMeta>) {
      settings.value.clusters = updateRecords(records.value, context, kubeConfig, patch);
    },
    /** One patch for several clusters (bulk edit). */
    updateMany(targets: { context: string; kubeConfig: string }[], patch: Partial<ClusterMeta>) {
      let next = records.value;
      for (const target of targets) next = updateRecords(next, target.context, target.kubeConfig, patch);
      settings.value.clusters = next;
    },
  };
}

/** For code outside components (reads the live settings). */
export function resolveClusterNow(context: string, kubeConfig?: string): ResolvedCluster {
  return resolveCluster(runtimeSettings()?.clusters, context, kubeConfig);
}

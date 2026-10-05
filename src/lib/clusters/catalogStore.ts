/*
 * Cloud accounts and their catalog, shared by the Clusters hub (Accounts,
 * Available) and the add-cluster flow. Loaded on first use; reloads when the
 * backend says the catalog changed (`catalog://changed`).
 */
import { shallowRef } from "vue";
import { listen } from "@tauri-apps/api/event";
import {
  catalogGet,
  catalogRefresh,
  listConnections,
  type CatalogCluster,
  type CloudConnection,
} from "./cloud";
import { initialDiscovery, reduceDiscovery, type DiscoveryState } from "./cloudModel";

export const connections = shallowRef<CloudConnection[] | null>(null);
export const catalog = shallowRef<CatalogCluster[] | null>(null);
export const catalogRefreshedAt = shallowRef<number | null>(null);
/** The refresh in progress (null when idle). */
export const discovery = shallowRef<DiscoveryState | null>(null);
export const cloudError = shallowRef<string | null>(null);

let loading: Promise<void> | null = null;
export function loadCloud(): Promise<void> {
  loading ??= Promise.all([listConnections(), catalogGet()])
    .then(([list, current]) => {
      connections.value = list;
      catalog.value = current.clusters;
      catalogRefreshedAt.value = current.refreshedAt ?? null;
      cloudError.value = null;
    })
    .catch((e) => {
      connections.value ??= [];
      catalog.value ??= [];
      cloudError.value = typeof e === "object" && e && "message" in e ? String(e.message) : String(e);
    })
    .finally(() => (loading = null));
  return loading;
}

/** Asks the clouds again (all accounts, or some), streaming progress into `discovery`. */
export async function refreshCloud(connectionIds: string[] | null = null): Promise<DiscoveryState> {
  let state = initialDiscovery();
  discovery.value = state;
  try {
    await catalogRefresh(connectionIds, (event) => {
      state = reduceDiscovery(state, event);
      discovery.value = state;
    });
  } finally {
    discovery.value = null;
    await loadCloud();
  }
  return state;
}

let listening = false;
/** Keeps the store current while the app runs (idempotent). */
export function watchCloud() {
  if (listening) return;
  listening = true;
  void listen("catalog://changed", () => void loadCloud()).catch(() => (listening = false));
}

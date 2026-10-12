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

const messageOf = (e: unknown) => (typeof e === "object" && e && "message" in e ? String(e.message) : String(e));

/*
 * Accounts and catalog load independently: an unreadable catalog must not
 * hide the accounts (they can still be signed in to or removed). A load
 * asked for while one runs runs again afterwards: it may have started
 * before the change it should show.
 */
let loading: Promise<void> | null = null;
let again = false;
export function loadCloud(): Promise<void> {
  if (loading) {
    again = true;
    return loading;
  }
  loading = (async () => {
    do {
      again = false;
      const [list, current] = await Promise.allSettled([listConnections(), catalogGet()]);
      const errors: string[] = [];
      if (list.status === "fulfilled") connections.value = list.value;
      else {
        connections.value ??= [];
        errors.push(messageOf(list.reason));
      }
      if (current.status === "fulfilled") {
        catalog.value = current.value.clusters;
        catalogRefreshedAt.value = current.value.refreshedAt ?? null;
      } else {
        catalog.value ??= [];
        errors.push(messageOf(current.reason));
      }
      cloudError.value = errors.length ? errors.join("\n") : null;
    } while (again);
  })().finally(() => (loading = null));
  return loading;
}

/*
 * Asks the clouds again (all accounts, or some), streaming progress into
 * `discovery`. Refreshes run one after another (the backend does too), so
 * one's progress never shows as another's.
 */
let queue: Promise<unknown> = Promise.resolve();
export function refreshCloud(connectionIds: string[] | null = null): Promise<DiscoveryState> {
  const run = queue.then(
    () => runRefresh(connectionIds),
    () => runRefresh(connectionIds)
  );
  queue = run.catch(() => undefined);
  return run;
}

async function runRefresh(connectionIds: string[] | null): Promise<DiscoveryState> {
  let state = initialDiscovery();
  discovery.value = state;
  try {
    await catalogRefresh(connectionIds, (event) => {
      state = reduceDiscovery(state, event);
      discovery.value = state;
    });
  } finally {
    // The results first, then the progress goes (no flash of an empty list).
    await loadCloud();
    if (discovery.value === state) discovery.value = null;
  }
  return state;
}

let listening = false;
/** Keeps the store current while the app runs (idempotent). */
export function watchCloud() {
  if (listening) return;
  listening = true;
  void listen("catalog://changed", () => void loadCloud()).catch(() => (listening = false));
  // Whether a catalog cluster is added comes from JET Pilot's kubeconfig.
  void listen("clusters://managed-changed", () => void loadCloud()).catch(() => undefined);
}

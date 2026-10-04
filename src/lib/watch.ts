import { Channel, invoke } from "@tauri-apps/api/core";

/*
 * Client side of the Rust WatchHub (src-tauri/src/watch) and the metrics
 * service (src-tauri/src/metrics.rs).
 *
 * A subscription streams a `snapshot` per namespace scope once the scope is
 * synced, then batched `delta`s and `status` changes. Watchers are shared and
 * kept warm by the backend for 60 s after the last unsubscribe, so
 * re-subscribing (navigating back to a list) gets a snapshot right away.
 */

export type WatchState =
  | "syncing"
  | "ready"
  | "relisting"
  | "error"
  | "forbidden"
  | "unauthorized"
  | "failed";

export interface WatchStatusMessage {
  type: "status";
  /** Namespace of the watcher, "" for all namespaces / cluster scoped. */
  scope: string;
  state: WatchState;
  message?: string;
  code?: number;
  reason?: string;
}

export interface WatchSnapshotMessage<T> {
  type: "snapshot";
  scope: string;
  items: T[];
}

export interface WatchDeltaMessage<T> {
  type: "delta";
  scope: string;
  added: T[];
  modified: T[];
  /** uids */
  deleted: string[];
}

export type WatchMessage<T> =
  | WatchStatusMessage
  | WatchSnapshotMessage<T>
  | WatchDeltaMessage<T>;

export interface WatchRequest {
  kubeConfig: string;
  context: string;
  /** kubectl resource name: `pods`, `deployments.apps`, CRD plurals, ... */
  resource: string;
  kind?: string;
  /** ["all"] (or empty) = all namespaces. */
  namespaces: string[];
}

export interface WatchSubscription {
  id: number;
  /** The scopes messages will arrive for; synced once all are ready. */
  scopes: string[];
  namespaced: boolean;
  apiVersion: string;
  kind: string;
}

export interface WatchHandle {
  subscription: WatchSubscription;
  unsubscribe: () => void;
  /** Reconnects watchers that are not ready (retry / after a re-login). */
  restart: () => Promise<void>;
}

export interface WatchTransport {
  subscribe<T>(
    request: WatchRequest,
    onMessage: (message: WatchMessage<T>) => void
  ): Promise<WatchHandle>;
}

let initialized: Promise<void> | null = null;

/*
 * Once per page load: drop subscriptions a previous load of the webview left
 * behind (their channels are gone) and pause delivery while the window is
 * hidden - the backend keeps watching and flushes coalesced changes on resume.
 */
function init(): Promise<void> {
  if (!initialized) {
    initialized = Promise.all([
      invoke("watch_reset"),
      invoke("metrics_reset"),
    ]).then(
      () => undefined,
      () => undefined
    );

    if (typeof document !== "undefined") {
      const sync = () =>
        invoke("watch_set_paused", { paused: document.hidden }).catch(
          () => undefined
        );
      document.addEventListener("visibilitychange", sync);
      if (document.hidden) {
        sync();
      }
    }
  }
  return initialized;
}

export const tauriWatchTransport: WatchTransport = {
  async subscribe<T>(
    request: WatchRequest,
    onMessage: (message: WatchMessage<T>) => void
  ): Promise<WatchHandle> {
    await init();
    const channel = new Channel<WatchMessage<T>>();
    channel.onmessage = onMessage;
    const subscription = await invoke<WatchSubscription>("watch_subscribe", {
      request,
      onEvent: channel,
    });

    let active = true;
    return {
      subscription,
      unsubscribe: () => {
        if (!active) return;
        active = false;
        channel.onmessage = () => undefined;
        invoke("watch_unsubscribe", { id: subscription.id }).catch(
          () => undefined
        );
      },
      restart: () =>
        invoke<void>("watch_restart", { id: subscription.id }).catch(
          () => undefined
        ),
    };
  },
};

/** The full cached object for `uid` from a running watcher. */
export function getWatchedObject<T = unknown>(uid: string): Promise<T> {
  return invoke<T>("watch_get", { uid });
}

/* ------------------------------------------------------------- metrics -- */

export type MetricsState =
  | "syncing"
  | "ready"
  | "unavailable"
  | "forbidden"
  | "error";

/** [timestamp ms, cpu millicores, memory bytes] */
export type MetricsPoint = [number, number, number];

export type MetricsMessage<P = any, N = any> =
  | { type: "status"; state: MetricsState; message?: string | null }
  | { type: "sample"; timestamp: number; pods: P[]; nodes: N[] }
  | {
      type: "history";
      pods: Record<string, MetricsPoint[]>;
      nodes: Record<string, MetricsPoint[]>;
    };

export interface MetricsRequest {
  kubeConfig: string;
  context: string;
  namespaces: string[];
}

export async function subscribeMetrics<P = any, N = any>(
  request: MetricsRequest,
  onMessage: (message: MetricsMessage<P, N>) => void
): Promise<() => void> {
  await init();
  const channel = new Channel<MetricsMessage<P, N>>();
  channel.onmessage = onMessage;
  const id = await invoke<number>("metrics_subscribe", {
    request,
    onEvent: channel,
  });

  let active = true;
  return () => {
    if (!active) return;
    active = false;
    channel.onmessage = () => undefined;
    invoke("metrics_unsubscribe", { id }).catch(() => undefined);
  };
}

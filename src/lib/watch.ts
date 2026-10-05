import { Channel } from "@tauri-apps/api/core";
import { Kubernetes } from "@/services/Kubernetes";

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
  /** "" = the selected kubeconfig. */
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
      Kubernetes.watchReset(),
      Kubernetes.metricsReset(),
    ]).then(
      () => undefined,
      () => undefined
    );

    if (typeof document !== "undefined") {
      const sync = () =>
        Kubernetes.watchSetPaused(document.hidden).catch(
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
    const subscription = await Kubernetes.watchSubscribe(request, channel);

    let active = true;
    return {
      subscription,
      unsubscribe: () => {
        if (!active) return;
        active = false;
        channel.onmessage = () => undefined;
        Kubernetes.watchUnsubscribe(subscription.id).catch(
          () => undefined
        );
      },
      restart: () =>
        Kubernetes.watchRestart(subscription.id).catch(() => undefined),
    };
  },
};

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
  const id = await Kubernetes.metricsSubscribe(request, channel);

  let active = true;
  return () => {
    if (!active) return;
    active = false;
    channel.onmessage = () => undefined;
    Kubernetes.metricsUnsubscribe(id).catch(() => undefined);
  };
}

import { provide, reactive, InjectionKey, toRefs, ToRefs } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-shell";
import { error as logError } from "@/lib/logger";

export const PortForwardingStateKey: InjectionKey<
  ToRefs<PortForwardingState>
> = Symbol("PortForwardingStateKey");

export const PortForwardingAddPortForwarding: InjectionKey<
  (
    portForwarding: PortForwarding,
    openInBrowser: boolean
  ) => Promise<ActivePortForwarding>
> = Symbol("PortForwardingAddPortForwarding");
export const PortForwardingRemovePortForwarding: InjectionKey<
  (portForwarding: ActivePortForwarding) => void
> = Symbol("PortForwardingRemovePortForwarding");

export interface PortForwarding {
  kubeConfig: string;
  context: string;
  namespace: string;
  objectType: "pod" | "deployment" | "service";
  objectName: string;
  objectPort: number;
  localPort: number;
  address: string;
  /** Auto-stop the forward after this many seconds. `null`/`undefined` = keep running. */
  ttlSeconds?: number | null;
}

export type ForwardStatus = "starting" | "ready" | "error";

/** A forward as tracked by the Rust side (id + lifecycle status). */
export interface ActivePortForwarding extends PortForwarding {
  id: string;
  status: ForwardStatus;
  error: string | null;
  startedAtMs: number;
  expiresAtMs: number | null;
}

export interface PortForwardingState {
  activePortForwardings: ActivePortForwarding[];
}

interface PendingForward {
  resolve: (portForwarding: ActivePortForwarding) => void;
  reject: (error: Error) => void;
  openInBrowser: boolean;
}

export default {
  name: "PortForwardingProvider",
  setup() {
    const state: PortForwardingState = reactive({
      activePortForwardings: [],
    });

    // Resolves/rejects the promise returned by `addPortForwarding` once the
    // back-end reports the forward as ready (or failed).
    const pendingForwards = new Map<string, PendingForward>();

    provide(PortForwardingStateKey, toRefs(state));

    const upsertForward = (portForwarding: ActivePortForwarding) => {
      const index = state.activePortForwardings.findIndex(
        (pf) => pf.id === portForwarding.id
      );
      if (index >= 0) {
        state.activePortForwardings.splice(index, 1, portForwarding);
      } else {
        state.activePortForwardings.push(portForwarding);
      }
    };

    const removeForward = (id: string) => {
      state.activePortForwardings = state.activePortForwardings.filter(
        (pf) => pf.id !== id
      );
    };

    const settleForward = (portForwarding: ActivePortForwarding) => {
      const pending = pendingForwards.get(portForwarding.id);
      if (!pending) {
        return;
      }
      pendingForwards.delete(portForwarding.id);
      if (portForwarding.status === "error") {
        pending.reject(
          new Error(portForwarding.error ?? "Port forwarding failed")
        );
      } else {
        if (pending.openInBrowser) {
          open(
            `http://${portForwarding.address}:${portForwarding.localPort}`
          ).catch((e) => logError(e));
        }
        pending.resolve(portForwarding);
      }
    };

    // Lifecycle events emitted by the Rust port-forward manager. Registered
    // once, before anything is started, so no event can be missed.
    const unlisteners: Array<() => void> = [];
    Promise.all([
      listen<ActivePortForwarding>("port_forward_started", (event) => {
        upsertForward(event.payload);
      }),
      listen<ActivePortForwarding>("port_forward_ready", (event) => {
        upsertForward(event.payload);
        settleForward(event.payload);
      }),
      listen<ActivePortForwarding>("port_forward_error", (event) => {
        upsertForward(event.payload);
        settleForward(event.payload);
      }),
      listen<{
        id: string;
        reason: "user" | "ttl" | "exited";
        exitCode: number | null;
      }>("port_forward_stopped", (event) => {
        const { id, reason, exitCode } = event.payload;
        removeForward(id);
        const pending = pendingForwards.get(id);
        if (pending) {
          pendingForwards.delete(id);
          pending.reject(
            new Error(
              reason === "exited"
                ? `Port forwarding exited (exit code: ${
                    exitCode ?? "unknown"
                  })`
                : "Port forwarding was stopped before it became available"
            )
          );
        }
      }),
    ]).then((unlisten) => unlisteners.push(...unlisten));

    // Re-sync with the Rust side in case the webview reloaded while forwards
    // were still running (e.g. Vite dev HMR).
    invoke<ActivePortForwarding[]>("list_port_forwards")
      .then((portForwardings) => {
        state.activePortForwardings = portForwardings;
      })
      .catch((e) => logError(`Failed to list port forwards: ${e}`));

    const addPortForwarding = async (
      portForwarding: PortForwarding,
      openInBrowser: boolean
    ): Promise<ActivePortForwarding> => {
      let info: ActivePortForwarding;
      try {
        info = await invoke<ActivePortForwarding>("start_port_forward", {
          spec: portForwarding,
        });
      } catch (e) {
        throw new Error(
          typeof e === "string" ? e : e instanceof Error ? e.message : String(e)
        );
      }
      upsertForward(info);

      return new Promise<ActivePortForwarding>((resolve, reject) => {
        // The back-end may have emitted ready/error before we stored the
        // resolver (events and the invoke reply are independent IPC messages).
        // Make sure the dialog does not hang in that case.
        const current = state.activePortForwardings.find(
          (pf) => pf.id === info.id
        );
        if (current && current.status !== "starting") {
          if (current.status === "error") {
            reject(new Error(current.error ?? "Port forwarding failed"));
          } else {
            if (openInBrowser) {
              open(`http://${current.address}:${current.localPort}`).catch(
                (e) => logError(e)
              );
            }
            resolve(current);
          }
          return;
        }

        pendingForwards.set(info.id, { resolve, reject, openInBrowser });
      });
    };

    const removePortForwarding = (
      activePortForwarding: ActivePortForwarding
    ) => {
      removeForward(activePortForwarding.id);
      invoke("stop_port_forward", { id: activePortForwarding.id }).catch((e) =>
        logError(
          `Failed to stop port forward ${activePortForwarding.id}: ${e}`
        )
      );
    };

    provide(PortForwardingAddPortForwarding, addPortForwarding);
    provide(PortForwardingRemovePortForwarding, removePortForwarding);
  },
  render(): any {
    return this.$slots.default();
  },
};

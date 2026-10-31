import {
  computed,
  provide,
  reactive,
  InjectionKey,
  toRefs,
  ToRefs,
  type ComputedRef,
} from "vue";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-shell";
import { error as logError } from "@/lib/logger";
import { injectStrict } from "@/lib/utils";
import { SettingsContextStateKey } from "@/providers/SettingsContextProvider";
import { isSameContext } from "@/lib/contextKey";
import { credentialView, onRecovered, report } from "@/lib/auth/center";
import {
  createProfile,
  isProfileRunning,
  parseProfiles,
  profileId,
  profilesToAutoStart,
  toSpec,
  upsertProfile,
  type PortForwardProfile,
} from "@/lib/portForwardProfiles";
import {
  forwardUrl,
  parsePortMemory,
  rememberPort,
  targetKey,
  type ForwardTarget,
} from "@/lib/portForwardLocal";
import { isMainWindow } from "@/lib/windows";

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

export interface PortForwardActions {
  /** Starts a forward again (same local port), e.g. after an error. */
  restart(portForwarding: ActivePortForwarding): Promise<void>;
  /** Re-reads every forward from the back end (fresh traffic counters). */
  refresh(): Promise<void>;
  openInBrowser(portForwarding: ActivePortForwarding): void;
  /** The local port last used for a target. */
  rememberedPort(target: ForwardTarget): number | undefined;
  rememberPort(target: ForwardTarget, port: number): void;
}
export const PortForwardingActionsKey: InjectionKey<PortForwardActions> =
  Symbol("PortForwardingActions");

export interface PortForwardProfiles {
  profiles: ComputedRef<PortForwardProfile[]>;
  /** Saves (or updates) the profile of a forward spec. */
  save(
    spec: PortForwarding,
    options?: { name?: string; autoStart?: boolean }
  ): PortForwardProfile;
  remove(id: string): void;
  setAutoStart(id: string, autoStart: boolean): void;
  isRunning(profile: PortForwardProfile): boolean;
  /** Starts the profile unless it is running already. */
  start(id: string, openInBrowser?: boolean): Promise<void>;
}
export const PortForwardingProfilesKey: InjectionKey<PortForwardProfiles> =
  Symbol("PortForwardingProfiles");

export interface PortForwarding {
  kubeConfig: string;
  context: string;
  namespace: string;
  objectType: "pod" | "deployment" | "service";
  objectName: string;
  objectPort: number;
  /** The remote port's name ("http"), shown next to the number. */
  portName?: string;
  localPort: number;
  address: string;
  /** Auto-stop the forward after this many seconds. `null`/`undefined` = keep running. */
  ttlSeconds?: number | null;
}

export type ForwardStatus = "starting" | "ready" | "reconnecting" | "error";

export interface ForwardTraffic {
  openConnections: number;
  connections: number;
  bytesSent: number;
  bytesReceived: number;
}

/** A forward as tracked by the Rust side (id + lifecycle status). */
export interface ActivePortForwarding extends PortForwarding {
  id: string;
  status: ForwardStatus;
  error: string | null;
  /** What a starting or reconnecting forward waits for. */
  reason: string | null;
  /** The pod the forward currently talks to. */
  pod: string | null;
  /** `kubectl` when the cluster refused native (WebSocket) forwarding. */
  engine: "native" | "kubectl";
  reconnects: number;
  lastReconnect: { atMs: number; reason: string } | null;
  startedAtMs: number;
  expiresAtMs: number | null;
  traffic: ForwardTraffic;
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
    const { settings } = injectStrict(SettingsContextStateKey);

    const state: PortForwardingState = reactive({
      activePortForwardings: [],
    });

    // Resolves/rejects the promise returned by `addPortForwarding` once the
    // back-end reports the forward as ready (or failed).
    const pendingForwards = new Map<string, PendingForward>();

    provide(PortForwardingStateKey, toRefs(state));

    const openInBrowser = (pf: ActivePortForwarding) => {
      open(forwardUrl(pf)).catch((e) => logError(e));
    };

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
        if (pending.openInBrowser) openInBrowser(portForwarding);
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
      // A pod went away; the forward heals itself (the port stays open).
      listen<ActivePortForwarding>("port_forward_reconnecting", (event) => {
        upsertForward(event.payload);
      }),
      // What it waits for, its pod, or kubectl taking over.
      listen<ActivePortForwarding>("port_forward_updated", (event) => {
        upsertForward(event.payload);
      }),
      listen<ActivePortForwarding>("port_forward_error", (event) => {
        upsertForward(event.payload);
        settleForward(event.payload);
        waitForSignIn(event.payload);
      }),
      listen<{
        id: string;
        reason: "user" | "ttl" | "exited" | "error";
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

    const refresh = () =>
      invoke<ActivePortForwarding[]>("list_port_forwards").then(
        (portForwardings) => {
          state.activePortForwardings = portForwardings;
        }
      );

    // Re-sync with the Rust side in case the webview reloaded while forwards
    // were still running (e.g. Vite dev HMR).
    refresh()
      .catch((e) => logError(`Failed to list port forwards: ${e}`))
      .finally(() => {
        // Pop-out windows show the forwards; the main window starts them.
        if (!isMainWindow()) return;
        // Profiles marked "start automatically" (not already running).
        for (const profile of profilesToAutoStart(
          profiles.value,
          state.activePortForwardings
        )) {
          profileApi
            .start(profile.id)
            .catch((e) =>
              logError(`Failed to auto-start ${profile.name}: ${e}`)
            );
        }
      });

    /** Waits for a started (or restarted) forward to become ready. */
    const whenReady = (
      info: ActivePortForwarding,
      openWhenReady: boolean
    ): Promise<ActivePortForwarding> => {
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
            if (openWhenReady) openInBrowser(current);
            resolve(current);
          }
          return;
        }
        pendingForwards.set(info.id, {
          resolve,
          reject,
          openInBrowser: openWhenReady,
        });
      });
    };

    const errorOf = (e: unknown) =>
      new Error(
        typeof e === "string" ? e : e instanceof Error ? e.message : String(e)
      );

    const addPortForwarding = async (
      portForwarding: PortForwarding,
      openWhenReady: boolean
    ): Promise<ActivePortForwarding> => {
      let info: ActivePortForwarding;
      try {
        info = await invoke<ActivePortForwarding>("start_port_forward", {
          spec: portForwarding,
        });
      } catch (e) {
        throw errorOf(e);
      }
      return whenReady(info, openWhenReady);
    };

    const restart = async (portForwarding: ActivePortForwarding) => {
      let info: ActivePortForwarding;
      try {
        info = await invoke<ActivePortForwarding>("restart_port_forward", {
          id: portForwarding.id,
        });
      } catch (e) {
        throw errorOf(e);
      }
      await whenReady(info, false);
    };

    /*
     * Forwards that failed because the cluster needs a sign-in (their error
     * says so, or the backend reported the cluster) start again once it
     * succeeded: the backend doesn't restart them.
     */
    const failedOnAuth = new Map<string, PortForwarding>();
    const waitForSignIn = (pf: ActivePortForwarding) => {
      if (!pf.error) return;
      if (report(pf, pf.error, "portForward") || credentialView(pf).needsSignIn) {
        failedOnAuth.set(pf.id, { ...toSpec(pf), ttlSeconds: pf.ttlSeconds });
      }
    };
    onRecovered("*", (target) => {
      for (const [id, spec] of failedOnAuth) {
        if (!isSameContext(spec, target)) continue;
        failedOnAuth.delete(id);
        // Still listed (it had worked before): restart it in place.
        const errored = state.activePortForwardings.find((pf) => pf.id === id);
        if (errored) {
          restart(errored).catch((e) =>
            logError(`Failed to restart port forward ${spec.objectName}: ${e}`)
          );
          continue;
        }
        // Started again by hand meanwhile.
        const key = profileId(toSpec(spec));
        if (
          state.activePortForwardings.some(
            (pf) => pf.status !== "error" && profileId(toSpec(pf)) === key
          )
        ) {
          continue;
        }
        addPortForwarding(spec, false).catch((e) =>
          logError(`Failed to restart port forward ${spec.objectName}: ${e}`)
        );
      }
    });

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

    /* -------------------------------------------------- port memory -- */

    const portMemory = computed(() =>
      parsePortMemory(settings.value.portForwardPorts)
    );
    const actions: PortForwardActions = {
      restart,
      refresh: () =>
        refresh().catch((e) => logError(`Failed to list port forwards: ${e}`)),
      openInBrowser,
      rememberedPort: (target) => portMemory.value[targetKey(target)],
      rememberPort: (target, port) => {
        const key = targetKey(target);
        if (portMemory.value[key] === port) return;
        settings.value.portForwardPorts = rememberPort(
          portMemory.value,
          key,
          port
        );
      },
    };
    provide(PortForwardingActionsKey, actions);

    /* ------------------------------------------------------ profiles -- */

    const profiles = computed(() =>
      parseProfiles(settings.value.portForwardProfiles)
    );
    const setProfiles = (next: PortForwardProfile[]) => {
      settings.value.portForwardProfiles = next;
    };

    const profileApi: PortForwardProfiles = {
      profiles,
      save: (spec, options) => {
        const existing = profiles.value.find(
          (p) => p.id === createProfile(spec).id
        );
        const profile = createProfile(spec, {
          name: options?.name ?? existing?.name,
          autoStart: options?.autoStart ?? existing?.autoStart,
        });
        setProfiles(upsertProfile(profiles.value, profile));
        return profile;
      },
      remove: (id) => setProfiles(profiles.value.filter((p) => p.id !== id)),
      setAutoStart: (id, autoStart) =>
        setProfiles(
          profiles.value.map((p) => (p.id === id ? { ...p, autoStart } : p))
        ),
      isRunning: (profile) =>
        isProfileRunning(profile, state.activePortForwardings),
      start: async (id, openWhenReady = false) => {
        const profile = profiles.value.find((p) => p.id === id);
        if (!profile || profileApi.isRunning(profile)) return;
        await addPortForwarding({ ...profile.spec }, openWhenReady);
      },
    };
    provide(PortForwardingProfilesKey, profileApi);

    provide(PortForwardingAddPortForwarding, addPortForwarding);
    provide(PortForwardingRemovePortForwarding, removePortForwarding);
  },
  render(): any {
    return this.$slots.default();
  },
};

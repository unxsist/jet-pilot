import { provide, reactive, InjectionKey, toRefs, ToRefs } from "vue";
import { Child, Command } from "@tauri-apps/api/shell";
import { open } from "@tauri-apps/api/shell";

export const PortForwardingStateKey: InjectionKey<ToRefs<PortForwardingState>> =
  Symbol("PortForwardingStateKey");

export const PortForwardingAddPortForwarding: InjectionKey<
  (
    portForwarding: PortForwarding,
    openInBrowser: boolean
  ) => Promise<ActivePortForwarding>
> = Symbol("PortForwardingAddPortForwarding");
export const PortForwardingRemovePortForwarding: InjectionKey<
  (portForwarding: ActivePortForwarding) => void
> = Symbol("PortForwardingAddPortForwarding");

export interface PortForwarding {
  kubeConfig: string;
  context: string;
  namespace: string;
  objectType: "pod" | "deployment" | "service";
  objectName: string;
  objectPort: number;
  localPort: number;
  address: string;
}

export interface ActivePortForwarding extends PortForwarding {
  pid: number;
  child: Child;
}

export interface PortForwardingState {
  activePortForwardings: ActivePortForwarding[];
}

export default {
  name: "PortForwardingProvider",
  setup() {
    const state: PortForwardingState = reactive({
      activePortForwardings: [],
    });

    provide(PortForwardingStateKey, toRefs(state));

    const addPortForwarding = (
      portForwarding: PortForwarding,
      openInBrowser: boolean
    ): Promise<ActivePortForwarding> => {
      return new Promise((resolve, reject) => {
        const args = [
          "port-forward",
          "--context",
          portForwarding.context,
          "--namespace",
          portForwarding.namespace,
          "--kubeconfig",
          portForwarding.kubeConfig,
          `${portForwarding.objectType}/${portForwarding.objectName}`,
          `${portForwarding.localPort}:${portForwarding.objectPort}`,
          `--address=${portForwarding.address}`,
        ];
        const command = new Command("kubectl", args);

        let child: Child | null = null;

        command.stdout.on("data", async (data: string) => {
          if (child !== null) {
            if (
              state.activePortForwardings.find((pf) => pf.pid === child?.pid)
            ) {
              return;
            }

            state.activePortForwardings.push({
              ...portForwarding,
              pid: child.pid,
              child,
            });

            if (openInBrowser) {
              open(
                `http://${portForwarding.address}:${portForwarding.localPort}`
              );
            }

            resolve(
              state.activePortForwardings[
                state.activePortForwardings.length - 1
              ]
            );
          }
        });

        command.stderr.on("data", (data: string) => {
          child?.kill();
          reject(data);
        });

        command.spawn().then((childProcess: Child) => {
          child = childProcess;
        });
      });
    };

    const removePortForwarding = (
      activePortForwarding: ActivePortForwarding
    ) => {
      activePortForwarding.child.kill();
      state.activePortForwardings = state.activePortForwardings.filter(
        (pf) => pf.pid !== activePortForwarding.pid
      );
    };

    provide(PortForwardingAddPortForwarding, addPortForwarding);
    provide(PortForwardingRemovePortForwarding, removePortForwarding);
  },
  render(): any {
    return this.$slots.default();
  },
};

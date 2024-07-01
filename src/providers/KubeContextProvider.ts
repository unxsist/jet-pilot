import { Kubernetes } from "@/services/Kubernetes";
import { provide, reactive, InjectionKey, toRefs, ToRefs } from "vue";
import { SettingsContextStateKey } from "@/providers/SettingsContextProvider";
import { injectStrict } from "@/lib/utils";

export const KubeContextStateKey: InjectionKey<ToRefs<KubeContextState>> =
  Symbol("KubeContextState");

export const KubeContextSetContextKey: InjectionKey<
  (context: { context: string; kubeConfig: string }) => void
> = Symbol("KubeContextSetContext");
export const KubeContextSetNamespaceKey: InjectionKey<
  (namespace: string) => void
> = Symbol("KubeContextSetNamespace");

export interface KubeContextState {
  context: string;
  namespace: string | "all";
}

export default {
  name: "KubeContextProvider",
  setup() {
    const { settings } = injectStrict(SettingsContextStateKey);

    const state: KubeContextState = reactive({
      context: settings.value.lastContext || "",
      namespace: settings.value.lastNamespace || "",
    });

    provide(KubeContextStateKey, toRefs(state));

    const setContext = (context: { context: string; kubeConfig: string }) => {
      Kubernetes.setCurrentKubeConfig(context.kubeConfig);
      settings.value.lastKubeConfig = context.kubeConfig;

      state.context = context.context;
      settings.value.lastContext = context.context;
    };

    const setNamespace = (namespace: string) => {
      state.namespace = namespace;
      settings.value.lastNamespace = namespace;
    };

    provide(KubeContextSetContextKey, setContext);
    provide(KubeContextSetNamespaceKey, setNamespace);

    if (state.context.length === 0) {
      Kubernetes.getCurrentContext().then((context) => {
        setContext({
          context,
          kubeConfig: settings.value.lastKubeConfig || "",
        });
        setNamespace("");
      });
    } else {
      Kubernetes.setCurrentKubeConfig(settings.value.lastKubeConfig || "");
    }
  },
  render(): any {
    return this.$slots.default();
  },
};

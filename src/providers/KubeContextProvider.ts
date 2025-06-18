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
export const KubeContextSetActiveNamespacesKey: InjectionKey<
  (context: string, kubeConfig: string, namespaces: string[]) => void
> = Symbol("KubeContextSetNamespaces");
export const KubeContextIsContextActiveKey: InjectionKey<
  (context: string) => boolean
> = Symbol("KubeContextIsContextActive");
export const KubeContextIsNamespaceActiveKey: InjectionKey<
  (context: string, namespace: string) => boolean
> = Symbol("KubeContextIsNamespaceActive");

export interface KubeContextState {
  context: string;
  namespace: string | "all";
  kubeConfig: string;
  authenticated: boolean;

  contextKubeConfigMapping: Map<string, string>;
  contexts: Map<string, string[]>;
}

export default {
  name: "KubeContextProvider",
  setup() {
    const { settings } = injectStrict(SettingsContextStateKey);

    const state: KubeContextState = reactive({
      context: settings.value.lastContext || "",
      namespace: settings.value.lastNamespace || "",
      kubeConfig: settings.value.lastKubeConfig || "",
      authenticated: true,

      contextKubeConfigMapping: new Map<string, string>(),
      contexts: new Map<string, string[]>(),
    });

    provide(KubeContextStateKey, toRefs(state));

    const setContext = (context: { context: string; kubeConfig: string }) => {
      Kubernetes.setCurrentKubeConfig(context.kubeConfig);
      settings.value.lastKubeConfig = context.kubeConfig;

      state.kubeConfig = context.kubeConfig;
      state.context = context.context;
      settings.value.lastContext = context.context;
    };

    const setNamespace = (namespace: string) => {
      state.namespace = namespace;
      settings.value.lastNamespace = namespace;
    };

    provide(KubeContextSetContextKey, setContext);
    provide(KubeContextSetNamespaceKey, setNamespace);

    const setActiveNamespaces = (
      context: string,
      kubeConfig: string,
      namespaces: string[]
    ) => {
      if (namespaces.length === 0) {
        state.contexts.delete(context);
        state.contextKubeConfigMapping.delete(context);
        return;
      }

      if (!state.contexts.has(context)) {
        state.contexts.set(context, []);
      }

      if (!state.contextKubeConfigMapping.has(context)) {
        state.contextKubeConfigMapping.set(context, kubeConfig);
      }

      state.contexts.set(context, namespaces);
    };
    provide(KubeContextSetActiveNamespacesKey, setActiveNamespaces);

    const isContextActive = (context: string): boolean => {
      return state.contexts.has(context);
    };
    provide(KubeContextIsContextActiveKey, isContextActive);

    const isNamespaceActive = (context: string, namespace: string): boolean => {
      if (!state.contexts.has(context)) {
        return false;
      }

      return (
        state.contexts.get(context)?.includes(namespace) ||
        state.contexts.get(context)?.includes("all") ||
        false
      );
    };
    provide(KubeContextIsNamespaceActiveKey, isNamespaceActive);

    if (state.context.length === 0) {
      Kubernetes.getCurrentContext().then((context) => {
        setContext({
          context,
          kubeConfig: settings.value.lastKubeConfig || "",
        });
        setNamespace("");
      });
    } else {
      state.kubeConfig = settings.value.lastKubeConfig || "";
      Kubernetes.setCurrentKubeConfig(settings.value.lastKubeConfig || "");
    }
  },
  render(): any {
    return this.$slots.default();
  },
};

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

/**
 * Set (upsert) or remove the active namespaces for a context.
 *
 * - Passing an empty array deactivates the context entirely.
 * - Pass `["all"]` for "all namespaces" (per context).
 */
export const KubeContextSetActiveNamespacesKey: InjectionKey<
  (context: string, kubeConfig: string, namespaces: string[]) => void
> = Symbol("KubeContextSetActiveNamespaces");

export const KubeContextSwitchContextKey: InjectionKey<
  (context: string, kubeConfig: string, namespace: string) => void
> = Symbol("KubeContextSwitchContext");

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

  /** context -> list of active namespaces; ["all"] means all namespaces. */
  contexts: Map<string, string[]>;
  /** context -> kubeconfig the context was activated with. */
  contextKubeConfigMapping: Map<string, string>;
}

export default {
  name: "KubeContextProvider",
  setup() {
    const { settings } = injectStrict(SettingsContextStateKey);

    const state: KubeContextState = reactive({
      context: settings.value.lastContext || "",
      namespace: settings.value.lastNamespace || "",
      kubeConfig:
        settings.value.lastKubeConfig || settings.value.kubeConfigs[0] || "",
      authenticated: true,
      contexts: new Map<string, string[]>(),
      contextKubeConfigMapping: new Map<string, string>(),
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

    /*
     * The single `context` / `namespace` / `kubeConfig` state is still read by
     * everything that is not (yet) multi-context aware: API discovery in the
     * navigation, the cluster overview, events, the create button and the
     * NoContext gate. It follows the "primary" context: the most recently
     * changed active context. An empty namespace means all (or several)
     * namespaces.
     */
    const setPrimary = (context: string, kubeConfig: string) => {
      const namespaces = state.contexts.get(context) || [];
      setContext({ context, kubeConfig });
      setNamespace(
        namespaces.length === 1 && namespaces[0] !== "all" ? namespaces[0] : ""
      );
    };

    const persistActivation = () => {
      settings.value.activeContexts = [...state.contexts.entries()].map(
        ([context, namespaces]) => ({
          context,
          kubeConfig: state.contextKubeConfigMapping.get(context) || "",
          namespaces: [...namespaces],
        })
      );
    };

    const setActiveNamespaces = (
      context: string,
      kubeConfig: string,
      namespaces: string[]
    ) => {
      if (namespaces.length === 0) {
        state.contexts.delete(context);
        state.contextKubeConfigMapping.delete(context);
        persistActivation();

        if (state.context === context) {
          const next = state.contexts.keys().next();
          if (!next.done) {
            setPrimary(
              next.value,
              state.contextKubeConfigMapping.get(next.value) || ""
            );
          } else {
            state.context = "";
            state.namespace = "";
            settings.value.lastContext = null;
            settings.value.lastNamespace = null;
          }
        }
        return;
      }

      state.contexts.set(context, namespaces);
      state.contextKubeConfigMapping.set(context, kubeConfig);
      persistActivation();
      setPrimary(context, kubeConfig);
    };
    provide(KubeContextSetActiveNamespacesKey, setActiveNamespaces);

    /**
     * Single-context switch (command palette): deactivate every other context
     * and activate only `context` with `namespace` ("" = all namespaces).
     */
    const switchContext = (
      context: string,
      kubeConfig: string,
      namespace: string
    ) => {
      state.contexts.clear();
      state.contextKubeConfigMapping.clear();
      setActiveNamespaces(context, kubeConfig, [namespace || "all"]);
    };
    provide(KubeContextSwitchContextKey, switchContext);

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

    /*
     * Restore the multi-context activation state from the previous session.
     * Older settings files only know the last single context: seed that one
     * so the single-context UX keeps working ("" namespace -> ["all"]).
     */
    const restoreActivation = () => {
      for (const entry of settings.value.activeContexts || []) {
        if (entry.context && entry.namespaces.length > 0) {
          state.contexts.set(entry.context, [...entry.namespaces]);
          state.contextKubeConfigMapping.set(entry.context, entry.kubeConfig);
        }
      }

      if (state.context && !state.contexts.has(state.context)) {
        state.contexts.set(
          state.context,
          state.namespace ? [state.namespace] : ["all"]
        );
        state.contextKubeConfigMapping.set(state.context, state.kubeConfig);
      }
    };

    if (state.context.length === 0) {
      Kubernetes.getCurrentContext().then((context) => {
        setContext({ context, kubeConfig: state.kubeConfig });
        setNamespace("");
        restoreActivation();
      });
    } else {
      Kubernetes.setCurrentKubeConfig(state.kubeConfig);
      restoreActivation();
    }
  }, 
  render(): any {
    return this.$slots.default();
  },
};

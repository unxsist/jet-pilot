import { Kubernetes } from "@/services/Kubernetes";
import { provide, reactive, InjectionKey, toRefs, ToRefs } from "vue";

export const KubeContextStateKey: InjectionKey<ToRefs<KubeContextState>> =
  Symbol("KubeContextState");

export const KubeContextSetContextKey: InjectionKey<(context: string) => void> =
  Symbol("KubeContextSetContext");
export const KubeContextSetNamespaceKey: InjectionKey<
  (namespace: string) => void
> = Symbol("KubeContextSetNamespace");

export interface KubeContextState {
  context: string;
  namespace: string | "all";
}

export default {
  setup() {
    const state: KubeContextState = reactive({
      context: "",
      namespace: "all",
    });

    provide(KubeContextStateKey, toRefs(state));

    const setContext = (context: string) => {
      state.context = context;
    };

    const setNamespace = (namespace: string) => {
      state.namespace = namespace;
    };

    provide(KubeContextSetContextKey, setContext);
    provide(KubeContextSetNamespaceKey, setNamespace);

    Kubernetes.getCurrentContext().then((context) => {
      setContext(context);
      setNamespace("tms");
    });
  },
  render(): any {
    return this.$slots.default();
  },
};

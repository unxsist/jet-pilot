/*
 * Side panel helpers of the operator views: opening a related object's
 * panel (a route's Service, a certificate's Secret, a node claim's Node) and
 * keeping the shown object fresh after an action.
 */
import { defineAsyncComponent, onScopeDispose, shallowRef, watch, type ShallowRef } from "vue";
import { toast } from "@/components/ui/toast";
import { apiPath, kubeGet, type KubeTarget } from "@/lib/kubeApi";
import { formatResourceKind } from "@/lib/utils";

export interface ObjectRef {
  apiVersion: string;
  kind: string;
  name: string;
  namespace?: string;
}

/* The object's cluster (rows and panel objects carry it in their metadata). */
export const targetOf = (object: any): KubeTarget => ({
  context: object?.metadata?.context ?? "",
  kubeConfig: object?.metadata?.kubeConfig,
});

const pathOf = (ref: ObjectRef) =>
  apiPath({
    apiVersion: ref.apiVersion,
    resource: formatResourceKind(ref.kind).toLowerCase(),
    namespace: ref.namespace,
    name: ref.name,
  });

/** Fetches an object, tagged with its cluster like table rows are. */
export async function fetchObject(target: KubeTarget, ref: ObjectRef): Promise<any> {
  const object = await kubeGet(target, pathOf(ref));
  return {
    ...object,
    metadata: { ...object?.metadata, context: target.context, kubeConfig: target.kubeConfig },
  };
}

type SetSidePanel = (panel: any) => void;

/** Opens the side panel of a related object. */
export async function openObjectPanel(
  setSidePanelComponent: SetSidePanel,
  target: KubeTarget,
  ref: ObjectRef
): Promise<void> {
  try {
    const object = await fetchObject(target, ref);
    setSidePanelComponent({
      title: `${ref.kind}: ${ref.name}`,
      icon: formatResourceKind(ref.kind).toLowerCase(),
      component: defineAsyncComponent(() => import("@/views/panels/Resource.vue")),
      props: { resource: object },
    });
  } catch (error) {
    const notFound = (error as { code?: number })?.code === 404;
    toast({
      title: notFound ? `${ref.kind} ${ref.name} doesn't exist` : `Couldn't open ${ref.kind} ${ref.name}`,
      description: notFound ? undefined : ((error as { message?: string })?.message ?? String(error)),
      variant: notFound ? "warning" : "destructive",
      autoDismiss: true,
    });
  }
}

/* After an action the controller needs a moment: look again a few times. */
const SETTLE_DELAYS = [1200, 3500, 8000];

/**
 * The panel's object, refetched after an action (the panel's own copy is
 * the table row it was opened from).
 */
export function useLiveObject(resource: () => any): {
  object: ShallowRef<any>;
  settle: () => void;
} {
  const object = shallowRef(resource());
  watch(resource, (value) => (object.value = value));

  let timers: ReturnType<typeof setTimeout>[] = [];
  const clear = () => {
    timers.forEach(clearTimeout);
    timers = [];
  };
  onScopeDispose(clear);

  const refresh = async () => {
    const current = object.value;
    if (!current?.metadata?.name || !current.apiVersion) return;
    try {
      object.value = await fetchObject(targetOf(current), {
        apiVersion: current.apiVersion,
        kind: current.kind,
        name: current.metadata.name,
        namespace: current.metadata.namespace,
      });
    } catch {
      // Gone or unreachable: keep showing what we had.
    }
  };

  const settle = () => {
    clear();
    timers = SETTLE_DELAYS.map((delay) => setTimeout(refresh, delay));
  };

  return { object, settle };
}

/*
 * Following a reference from a side panel (an owner, a node, a claim, a
 * Service's pods): the referenced object opens in the same panel, which
 * remembers where you came from so Back returns there. Opening a panel any
 * other way (a table row, the graph) starts a fresh trail.
 */
import { defineAsyncComponent, markRaw } from "vue";
import { toast } from "@/components/ui/toast";
import { formatResourceKind } from "@/lib/utils";
import { apiPath, kubeGet, type KubeTarget } from "@/lib/kubeApi";
import { flattenResources, getDiscoveryService } from "@/lib/discovery";
import type { SidePanel } from "@/providers/PanelProvider";
import { refPath, type ObjectRef } from "./kinds";
import { followPanel } from "./panelTrail";

const ResourcePanel = markRaw(defineAsyncComponent(() => import("@/views/panels/Resource.vue")));

export interface PanelTarget {
  context: string;
  kubeConfig: string;
}

/** Tags an object with the cluster it came from, like the tables' rows. */
export const tagged = <T extends { metadata?: object }>(object: T, target: PanelTarget): T => ({
  ...object,
  metadata: { ...object.metadata, context: target.context, kubeConfig: target.kubeConfig },
});

/** The API path of any reference: built-in kinds directly, others through discovery. */
export async function pathOf(target: PanelTarget, ref: ObjectRef): Promise<string | null> {
  const known = refPath(ref);
  if (known) return known;
  const discovery = getDiscoveryService();
  const snapshot =
    discovery.peek(target.context, target.kubeConfig) ??
    (await discovery.load(target.context, target.kubeConfig).catch(() => null));
  const group = ref.apiVersion?.includes("/") ? ref.apiVersion.split("/")[0] : undefined;
  const served = flattenResources(snapshot).find(
    (r) => r.kind === ref.kind && (group === undefined || r.group === group)
  );
  if (!served) return null;
  return apiPath({
    apiVersion: served.group ? `${served.group}/${served.version}` : served.version,
    resource: served.name,
    namespace: served.namespaced ? ref.namespace : undefined,
    name: ref.name,
  });
}

/** Fetches a referenced object (tagged with its cluster); null when it doesn't exist. */
export async function fetchRef(target: PanelTarget, ref: ObjectRef): Promise<any | null> {
  const path = await pathOf(target, ref);
  if (!path) return null;
  const kubeTarget: KubeTarget = { context: target.context, kubeConfig: target.kubeConfig || undefined };
  try {
    return tagged(await kubeGet<any>(kubeTarget, path), target);
  } catch (e) {
    if ((e as { code?: number })?.code === 404) return null;
    throw e;
  }
}

const panelFor = (object: any): SidePanel => ({
  title: `${object.kind}: ${object.metadata?.name}`,
  icon: formatResourceKind(object.kind ?? "").toLowerCase(),
  component: ResourcePanel,
  props: { resource: object },
});

/** Opens `object` in the side panel, remembering the current panel for Back. */
export function openInPanel(
  setSidePanel: (panel: SidePanel | null) => void,
  current: SidePanel | null,
  object: any
) {
  const next = panelFor(object);
  followPanel(current, next);
  setSidePanel(next);
}

/**
 * Fetches a reference and opens it in the panel; tells (a toast) when it
 * doesn't exist or can't be read.
 */
export async function followRef(
  setSidePanel: (panel: SidePanel | null) => void,
  current: SidePanel | null,
  target: PanelTarget,
  ref: ObjectRef
) {
  try {
    const object = await fetchRef(target, ref);
    if (!object) {
      toast({
        title: `${ref.kind} ${ref.name} doesn't exist`,
        description: ref.namespace ? `Not in namespace ${ref.namespace} (anymore).` : "Not in the cluster (anymore).",
        variant: "warning",
      });
      return;
    }
    openInPanel(setSidePanel, current, object);
  } catch (e) {
    toast({
      title: `Couldn't open ${ref.kind} ${ref.name}`,
      description: (e as { message?: string })?.message ?? String(e),
      variant: "destructive",
    });
  }
}

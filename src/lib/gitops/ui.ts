/*
 * Shared UI entry points of the GitOps feature: the delivery side panel, the
 * Argo CD sync dialog and jumping to a delivered resource.
 */
import { defineAsyncComponent, markRaw } from "vue";
import type { Router } from "vue-router";
import { toast } from "@/components/ui/toast";
import { formatResourceKind } from "@/lib/utils";
import { allowed, rowTargets } from "@/lib/guardrails/guard";
import { apiPath, kubeGet } from "@/lib/kubeApi";
import { getDiscoveryService } from "@/lib/discovery";
import type { BaseDialogInterface } from "@/providers/DialogProvider";
import type { SidePanel } from "@/providers/PanelProvider";
import type { DeliveredResource } from "./model";

/* One component for every delivery: Resource.vue renders the delivery panel per object. */
const ResourcePanel = markRaw(defineAsyncComponent(() => import("@/views/panels/Resource.vue")));
const SyncDialog = markRaw(defineAsyncComponent(() => import("@/views/dialogs/SyncApplication.vue")));

export function openDeliveryPanel(
  setSidePanelComponent: (panel: SidePanel | null) => void,
  object: { kind?: string; metadata?: { name?: string } }
) {
  setSidePanelComponent({
    title: `${object.kind}: ${object.metadata?.name}`,
    icon: formatResourceKind(object.kind ?? "").toLowerCase(),
    component: ResourcePanel,
    props: { resource: object },
  });
}

/** Argo CD sync: a small dialog (prune is an explicit choice), read-only clusters blocked first. */
export function openSyncDialog(spawnDialog: (dialog: BaseDialogInterface) => void, app: any) {
  if (!allowed("sync", rowTargets([app]))) return;
  spawnDialog({
    title: `Sync ${app.metadata?.name}?`,
    message: "Argo CD applies what is in Git to the cluster.",
    component: SyncDialog,
    props: { app },
  });
}

/**
 * Opens the list of a delivered resource's kind with the resource
 * highlighted (looked up for its uid). Tells when it doesn't exist.
 */
export async function openDeliveredResource(
  router: Router,
  target: { context: string; kubeConfig?: string },
  resource: Pick<DeliveredResource, "kind" | "group" | "version" | "namespace" | "name">
) {
  const discovery = getDiscoveryService();
  const snapshot =
    discovery.peek(target.context, target.kubeConfig ?? "") ??
    (await discovery.load(target.context, target.kubeConfig ?? "").catch(() => null));
  const served = Object.values(snapshot?.groups ?? {})
    .flat()
    .find((r) => r.kind === resource.kind && r.group === resource.group && !r.name.includes("/"));
  const version = served?.version ?? resource.version ?? "v1";
  const plural = formatResourceKind(resource.kind).toLowerCase();
  let uid: string | undefined;
  try {
    const object = await kubeGet<any>(
      { context: target.context, kubeConfig: target.kubeConfig || undefined },
      apiPath({
        apiVersion: resource.group ? `${resource.group}/${version}` : version,
        resource: served?.name ?? plural,
        namespace: served?.namespaced === false ? undefined : resource.namespace || undefined,
        name: resource.name,
      })
    );
    uid = object?.metadata?.uid;
  } catch (e) {
    const notFound = (e as { code?: number })?.code === 404;
    toast({
      title: notFound
        ? `${resource.kind} ${resource.name} doesn't exist in the cluster`
        : `Couldn't open ${resource.kind} ${resource.name}`,
      description: notFound ? "It is in Git, but not (or no longer) in the cluster." : (e as { message?: string })?.message ?? String(e),
      variant: notFound ? "warning" : "destructive",
    });
    return;
  }
  await router.push({ path: `/${plural}`, query: { resource: plural, kind: resource.kind, ...(uid ? { uid } : {}) } });
}

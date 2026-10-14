/*
 * GitOps actions: reconcile / suspend / resume Flux deliveries, sync and
 * refresh Argo CD applications. Every change runs the guardrails first and
 * goes through the raw API (`kubePatch`); the delivery then shows as
 * "Reconciling" / "Syncing" until its controller answers, which a small
 * watch of the object detects (wherever the action started), followed by a
 * toast with the result.
 */
import { shallowReactive } from "vue";
import { toast } from "@/components/ui/toast";
import { apiPath, kubePatch, type KubeTarget } from "@/lib/kubeApi";
import { guard, rowTargets } from "@/lib/guardrails/guard";
import type { ActionKind } from "@/lib/guardrails/policy";
import { getDiscoveryService } from "@/lib/discovery";
import { kubectlGetForContext, kubectlPollingForced } from "@/lib/multicontext";
import { runtimeSettings } from "@/lib/settings/runtime";
import { tauriWatchTransport } from "@/lib/watch";
import { WatchedListController, centerWatchAuth } from "@/composables/useWatchedList";
import {
  DELIVERY_KINDS,
  RECONCILE_ANNOTATION,
  REFRESH_ANNOTATION,
  SOURCE_KINDS,
  argoState,
  deliveryKindOf,
  fluxSource,
  fluxState,
  pendingSettled,
  qualifiedName,
  readableMessage,
  type ObjectRef,
  type PendingAction,
  type WatchedKind,
} from "./model";

/** A delivery row as the lists deliver it (tagged with its context). */
export interface DeliveryObject {
  apiVersion?: string;
  kind?: string;
  metadata: {
    name?: string;
    namespace?: string;
    uid?: string;
    resourceVersion?: string;
    context: string;
    kubeConfig: string;
    annotations?: Record<string, string>;
  };
  spec?: any;
  status?: any;
}

const keyOf = (object: { metadata?: { context?: string; uid?: string } }) =>
  `${object.metadata?.context ?? ""}/${object.metadata?.uid ?? ""}`;

/* --------------------------------------------------------- pending -- */

/* Shallow: entries are compared by identity (a deep proxy would never equal `pending`). */
const pendingActions = shallowReactive(new Map<string, PendingAction>());

/** The action JET Pilot is waiting on for this object, if any. */
export const pendingFor = (object: { metadata?: { context?: string; uid?: string } }) =>
  pendingActions.get(keyOf(object));

/** No answer at all after this long: the controller probably isn't running. */
const PICKUP_MS = 45_000;
/** A reconcile with health checks or a sync with hooks can take this long. */
const MAX_WAIT_MS = 15 * 60_000;

const errorMessage = (e: unknown) =>
  (e as { message?: string })?.message ?? (typeof e === "string" ? e : String(e));

const targetOf = (object: DeliveryObject): KubeTarget => ({
  context: object.metadata.context,
  kubeConfig: object.metadata.kubeConfig || undefined,
});

function announceResult(object: any, pending: PendingAction) {
  const name = object.metadata?.name ?? "";
  if (pending.action === "reconcile") {
    const state = fluxState(object);
    if (state.category === "healthy") {
      toast({ title: `${name} is ready`, description: state.message, variant: "success", autoDismiss: true });
    } else if (state.category === "failing" || state.category === "attention") {
      toast({ title: `${name}: ${state.label.toLowerCase()}`, description: state.message, variant: "destructive", duration: 15000 });
    }
    return;
  }
  if (pending.action === "sync") {
    const operation = object.status?.operationState;
    if (operation?.phase === "Succeeded") {
      toast({ title: `Synced ${name}`, description: readableMessage(operation.message), variant: "success", autoDismiss: true });
    } else {
      toast({ title: `Sync of ${name} failed`, description: readableMessage(operation?.message), variant: "destructive", duration: 15000 });
    }
    return;
  }
  const state = argoState(object);
  toast({ title: `Refreshed ${name}`, description: `${state.label}.`, variant: "default", autoDismiss: true });
}

/*
 * Waits for the controller's answer with a watch of the object's kind in its
 * namespace (the backend shares watchers, so this costs nothing while the
 * GitOps page or a table already watches it).
 */
function track(object: DeliveryObject, kind: WatchedKind, started: PendingAction) {
  const key = keyOf(object);
  const pending: PendingAction = {
    ...started,
    category: (kind.tool === "argo" ? argoState(object) : fluxState(object)).category,
  };
  pendingActions.set(key, pending);
  const resource = qualifiedName(kind);
  let latest: any = object;
  let done = false;

  const finish = (answered: boolean) => {
    if (done) return;
    done = true;
    clearTimeout(pickup);
    clearTimeout(expire);
    controller.dispose();
    if (pendingActions.get(key) === pending) pendingActions.delete(key);
    if (answered) announceResult(latest, pending);
  };

  const controller = new WatchedListController<any>(
    {
      resource,
      kind: kind.kind,
      fallback: (target) => kubectlGetForContext(resource, target.context, target.kubeConfig, target.namespaces),
      fallbackInterval: 3000,
      forcePolling: kubectlPollingForced(runtimeSettings()),
      auth: centerWatchAuth,
      transport: tauriWatchTransport,
    },
    () => {
      const found = controller?.items().find((row) => row.metadata?.uid === object.metadata.uid);
      if (!found || done) return;
      latest = found;
      if (pendingSettled(found, pending)) finish(true);
    }
  );

  /* No sign of the controller: say so instead of spinning forever. */
  const pickup = setTimeout(() => {
    const busy =
      pending.action === "reconcile"
        ? fluxState(latest).category === "progressing"
        : pending.action === "sync"
          ? !latest.operation && latest.status?.operationState?.startedAt !== pending.previousOperation
          : false;
    if (busy) return;
    finish(false);
    const tool = pending.action === "reconcile" ? "Flux" : "Argo CD";
    toast({
      title: `${tool} hasn't picked up ${object.metadata.name} yet`,
      description: `The request is in place; ${tool} acts on it once its controller gets to it. Is the controller running?`,
      variant: "warning",
      duration: 15000,
    });
  }, PICKUP_MS);
  const expire = setTimeout(() => finish(false), MAX_WAIT_MS);

  controller.setTargets([
    {
      context: object.metadata.context,
      kubeConfig: object.metadata.kubeConfig,
      namespaces: [object.metadata.namespace ?? "all"],
    },
  ]);
}

/* ---------------------------------------------------------- helpers -- */

const objectPath = (object: { apiVersion?: string; metadata: { namespace?: string; name?: string } }, plural: string) =>
  apiPath({
    apiVersion: object.apiVersion ?? "v1",
    resource: plural,
    namespace: object.metadata.namespace,
    name: object.metadata.name,
  });

/** The served version of a Flux source kind in a context (discovery), `v1` otherwise. */
function sourcePath(context: string, kubeConfig: string, ref: ObjectRef): string | null {
  const kind = SOURCE_KINDS[ref.kind];
  if (!kind) return null;
  const served = Object.values(getDiscoveryService().peek(context, kubeConfig)?.groups ?? {})
    .flat()
    .find((r) => r.kind === kind.kind && r.group === kind.group);
  return apiPath({
    apiVersion: `${kind.group}/${served?.version ?? "v1"}`,
    resource: kind.plural,
    namespace: ref.namespace,
    name: ref.name,
  });
}

async function run(kind: ActionKind, object: DeliveryObject, failure: string, action: () => Promise<void>) {
  if (!(await guard(kind, rowTargets([object])))) return false;
  try {
    await action();
    return true;
  } catch (e) {
    toast({ title: failure, description: errorMessage(e), variant: "destructive", duration: 15000 });
    return false;
  }
}

/* --------------------------------------------------------- actions -- */

/**
 * Flux reconcile: the `reconcile.fluxcd.io/requestedAt` annotation. With
 * the source, its source objects (repository, Helm chart) are annotated
 * first, so a new commit / chart version is fetched before the apply.
 */
export async function reconcile(object: DeliveryObject, options: { withSource?: boolean } = {}) {
  const kind = deliveryKindOf(object);
  if (!kind || DELIVERY_KINDS[kind].tool !== "flux") return;
  const name = object.metadata.name ?? "";
  const token = new Date().toISOString();
  const annotation = { metadata: { annotations: { [RECONCILE_ANNOTATION]: token } } };
  await run("reconcile", object, `Couldn't reconcile ${name}`, async () => {
    const target = targetOf(object);
    if (options.withSource) {
      for (const ref of fluxSource(object).refs) {
        const path = sourcePath(object.metadata.context, object.metadata.kubeConfig, ref);
        if (path) await kubePatch(target, path, annotation);
      }
    }
    await kubePatch(target, objectPath(object, DELIVERY_KINDS[kind].plural), annotation);
    track(object, DELIVERY_KINDS[kind], { action: "reconcile", startedAt: Date.now(), token });
  });
}

/** Flux suspend / resume (`spec.suspend`). */
export async function setSuspended(object: DeliveryObject, suspend: boolean) {
  const kind = deliveryKindOf(object);
  if (!kind || DELIVERY_KINDS[kind].tool !== "flux") return;
  const name = object.metadata.name ?? "";
  const done = await run(suspend ? "suspend" : "resume", object, `Couldn't ${suspend ? "suspend" : "resume"} ${name}`, async () => {
    await kubePatch(targetOf(object), objectPath(object, DELIVERY_KINDS[kind].plural), { spec: { suspend } });
  });
  if (done) {
    toast({
      title: suspend ? `Suspended ${name}` : `Resumed ${name}`,
      description: suspend ? "Flux leaves it as it is until you resume it." : "Flux reconciles it again.",
      autoDismiss: true,
    });
  }
}

/**
 * Argo CD sync: the Application's `operation` field, which the application
 * controller picks up (what the Argo CD API server does on a sync).
 */
export async function sync(object: DeliveryObject, options: { prune?: boolean } = {}) {
  if (deliveryKindOf(object) !== "Application") return;
  const name = object.metadata.name ?? "";
  const previousOperation = object.status?.operationState?.startedAt;
  await run(options.prune ? "sync-prune" : "sync", object, `Couldn't sync ${name}`, async () => {
    await kubePatch(targetOf(object), objectPath(object, DELIVERY_KINDS.Application.plural), {
      operation: {
        initiatedBy: { username: "jet-pilot" },
        sync: { ...(options.prune ? { prune: true } : {}) },
      },
    });
    track(object, DELIVERY_KINDS.Application, { action: "sync", startedAt: Date.now(), previousOperation });
  });
}

/** Argo CD refresh: compare with Git again (`hard` also drops the manifest cache). */
export async function refresh(object: DeliveryObject, hard = false) {
  if (deliveryKindOf(object) !== "Application") return;
  const name = object.metadata.name ?? "";
  await run("refresh", object, `Couldn't refresh ${name}`, async () => {
    const patched = await kubePatch<any>(targetOf(object), objectPath(object, DELIVERY_KINDS.Application.plural), {
      metadata: { annotations: { [REFRESH_ANNOTATION]: hard ? "hard" : "normal" } },
    });
    track(object, DELIVERY_KINDS.Application, {
      action: "refresh",
      startedAt: Date.now(),
      patchedVersion: patched?.metadata?.resourceVersion,
    });
  });
}

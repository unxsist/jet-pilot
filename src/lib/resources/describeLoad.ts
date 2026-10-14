/*
 * Loads what the native describe shows, straight from the API: the object
 * (its kind resolved from the describe tab's `type`, e.g. "Pod" or
 * "deployment.apps"), its events, its owners, and for a node its pods, for
 * a Service its EndpointSlices. One request each, on open and on refresh.
 */
import { apiPath, kubeGet, type KubeTarget } from "@/lib/kubeApi";
import { flattenResources, getDiscoveryService } from "@/lib/discovery";
import { describeObject, type DescribeDoc } from "./describe";
import { fetchEvents } from "./events";
import { KINDS, type KindInfo } from "./kinds";
import { fetchRef, tagged, type PanelTarget } from "./open";
import { resolveOwners } from "./pod";

const groupOf = (apiVersion: string) => (apiVersion.includes("/") ? apiVersion.split("/")[0] : "");

/** The kind behind a describe type: built-in kinds first, then discovery (CRDs). */
export async function resolveKind(target: PanelTarget, type: string): Promise<KindInfo | null> {
  const [base = "", ...rest] = type.split(".");
  const group = rest.join(".");
  const name = base.toLowerCase();
  const builtin = Object.values(KINDS).find(
    (k) => (k.kind.toLowerCase() === name || k.plural === name) && (!group || groupOf(k.apiVersion) === group)
  );
  if (builtin) return builtin;
  const discovery = getDiscoveryService();
  const snapshot =
    discovery.peek(target.context, target.kubeConfig) ??
    (await discovery.load(target.context, target.kubeConfig).catch(() => null));
  const served = flattenResources(snapshot).find(
    (r) =>
      (r.kind.toLowerCase() === name || r.name === name || r.singularName === name) && (!group || r.group === group)
  );
  if (!served) return null;
  return {
    kind: served.kind,
    apiVersion: served.group ? `${served.group}/${served.version}` : served.version,
    plural: served.name,
    namespaced: served.namespaced,
  };
}

export async function loadDescribe(
  target: PanelTarget,
  type: string,
  name: string,
  namespace?: string
): Promise<{ doc: DescribeDoc; object: any }> {
  const info = await resolveKind(target, type);
  if (!info) throw new Error(`This cluster doesn't serve "${type}".`);
  const kubeTarget: KubeTarget = { context: target.context, kubeConfig: target.kubeConfig || undefined };
  const object = tagged(
    await kubeGet<any>(
      kubeTarget,
      apiPath({ apiVersion: info.apiVersion, resource: info.plural, namespace: info.namespaced ? namespace : undefined, name })
    ),
    target
  );
  // Related data is a bonus: the describe stands without it.
  const optional = <T>(promise: Promise<T>) => promise.catch(() => undefined);
  const [events, owners, pods, slices] = await Promise.all([
    optional(fetchEvents(target, object)),
    optional(resolveOwners(object, (ref) => fetchRef(target, ref))),
    info.kind === "Node"
      ? optional(
          kubeGet<any>(kubeTarget, apiPath({ apiVersion: "v1", resource: "pods", query: { fieldSelector: `spec.nodeName=${name}` } })).then(
            (list) => list?.items ?? []
          )
        )
      : undefined,
    info.kind === "Service"
      ? optional(
          kubeGet<any>(
            kubeTarget,
            apiPath({
              apiVersion: "discovery.k8s.io/v1",
              resource: "endpointslices",
              namespace,
              query: { labelSelector: `kubernetes.io/service-name=${name}` },
            })
          ).then((list) => list?.items ?? [])
        )
      : undefined,
  ]);
  return { object, doc: describeObject(object, { now: Date.now(), events, owners, pods, slices }) };
}

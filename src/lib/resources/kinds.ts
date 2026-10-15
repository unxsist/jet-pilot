/*
 * The built-in kinds the side panels and the native describe link to and
 * watch: their API version, plural and scope, so a reference (an owner, a
 * volume's claim, an ingress backend) becomes an API path or a watched list
 * without a discovery round trip. Other kinds go through discovery.
 */
import { apiPath } from "@/lib/kubeApi";

export interface KindInfo {
  kind: string;
  apiVersion: string;
  plural: string;
  namespaced: boolean;
}

const k = (kind: string, apiVersion: string, plural: string, namespaced = true): KindInfo => ({
  kind,
  apiVersion,
  plural,
  namespaced,
});

export const KINDS: Record<string, KindInfo> = Object.fromEntries(
  [
    k("Pod", "v1", "pods"),
    k("Node", "v1", "nodes", false),
    k("Namespace", "v1", "namespaces", false),
    k("Service", "v1", "services"),
    k("ConfigMap", "v1", "configmaps"),
    k("Secret", "v1", "secrets"),
    k("ServiceAccount", "v1", "serviceaccounts"),
    k("PersistentVolumeClaim", "v1", "persistentvolumeclaims"),
    k("PersistentVolume", "v1", "persistentvolumes", false),
    k("Event", "v1", "events"),
    k("ResourceQuota", "v1", "resourcequotas"),
    k("LimitRange", "v1", "limitranges"),
    k("Endpoints", "v1", "endpoints"),
    k("ReplicationController", "v1", "replicationcontrollers"),
    k("Deployment", "apps/v1", "deployments"),
    k("ReplicaSet", "apps/v1", "replicasets"),
    k("StatefulSet", "apps/v1", "statefulsets"),
    k("DaemonSet", "apps/v1", "daemonsets"),
    k("Job", "batch/v1", "jobs"),
    k("CronJob", "batch/v1", "cronjobs"),
    k("Ingress", "networking.k8s.io/v1", "ingresses"),
    k("IngressClass", "networking.k8s.io/v1", "ingressclasses", false),
    k("NetworkPolicy", "networking.k8s.io/v1", "networkpolicies"),
    k("StorageClass", "storage.k8s.io/v1", "storageclasses", false),
    k("HorizontalPodAutoscaler", "autoscaling/v2", "horizontalpodautoscalers"),
    k("PodDisruptionBudget", "policy/v1", "poddisruptionbudgets"),
    k("EndpointSlice", "discovery.k8s.io/v1", "endpointslices"),
    k("HTTPRoute", "gateway.networking.k8s.io/v1", "httproutes"),
    k("Gateway", "gateway.networking.k8s.io/v1", "gateways"),
  ].map((info) => [info.kind, info])
);

export const kindInfo = (kind: string | undefined): KindInfo | undefined =>
  kind ? KINDS[kind] : undefined;

/** The watch / kubectl resource name: `pods`, `deployments.apps`. */
export function watchResource(info: KindInfo): string {
  const group = info.apiVersion.includes("/") ? info.apiVersion.split("/")[0] : "";
  return group ? `${info.plural}.${group}` : info.plural;
}

/** A reference to an object in the same cluster. */
export interface ObjectRef {
  kind: string;
  name: string;
  namespace?: string;
  /** From an owner reference; the built-in table's version otherwise. */
  apiVersion?: string;
}

/** The API path of a referenced built-in object; null for unknown kinds. */
export function refPath(ref: ObjectRef): string | null {
  const info = kindInfo(ref.kind);
  if (!info) return null;
  // An owner reference's version wins only within the same group.
  const group = (v: string) => (v.includes("/") ? v.split("/")[0] : "");
  const apiVersion =
    ref.apiVersion && group(ref.apiVersion) === group(info.apiVersion) ? ref.apiVersion : info.apiVersion;
  return apiPath({
    apiVersion,
    resource: info.plural,
    namespace: info.namespaced ? ref.namespace : undefined,
    name: ref.name,
  });
}

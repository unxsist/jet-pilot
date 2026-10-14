/*
 * Sample objects for previews in the form editor ("Will run: kubectl
 * --context prod logs -f payments-api-7f9c4…"): realistic, with labels,
 * annotations and two containers where the kind has them.
 */
import type { PlanItem } from "./plan";

const LABELS = {
  app: "payments-api",
  "app.kubernetes.io/name": "payments-api",
  "app.kubernetes.io/instance": "payments",
};
const ANNOTATIONS = { "example.com/owner": "team-payments" };
const CONTAINERS = [
  { name: "api", image: "ghcr.io/acme/payments-api:v2.14.3" },
  { name: "envoy", image: "envoyproxy/envoy:v1.30.2" },
];
const WORKLOADS = ["Deployment", "StatefulSet", "DaemonSet", "ReplicaSet", "Job"];
const CLUSTER_SCOPED = ["Node", "Namespace", "PersistentVolume", "ClusterRole", "ClusterRoleBinding", "StorageClass", "CustomResourceDefinition"];

const API_VERSIONS: Record<string, string> = {
  Deployment: "apps/v1",
  StatefulSet: "apps/v1",
  DaemonSet: "apps/v1",
  ReplicaSet: "apps/v1",
  Job: "batch/v1",
  CronJob: "batch/v1",
  Ingress: "networking.k8s.io/v1",
};

/** A sample of `kind` (Kind.group allowed) on `context`. */
export function sampleItem(kindName: string, context: string): PlanItem {
  const [kind = "Pod", ...group] = kindName.split(".");
  const metadata: Record<string, unknown> = {
    name: "payments-api",
    labels: LABELS,
    annotations: ANNOTATIONS,
    uid: "6f1c2a9e-8b7d-4c3e-9a1f-2d4b5c6e7f80",
  };
  if (!CLUSTER_SCOPED.includes(kind)) metadata.namespace = "payments";
  const object: Record<string, any> = {
    apiVersion: group.length ? `${group.join(".")}/v1` : API_VERSIONS[kind] ?? "v1",
    kind,
    metadata,
  };
  if (kind === "Pod") {
    metadata.name = "payments-api-7f9c4d8b6-x2klq";
    object.spec = { containers: CONTAINERS };
  } else if (WORKLOADS.includes(kind)) {
    object.spec = { replicas: 3, template: { metadata: { labels: LABELS }, spec: { containers: CONTAINERS } } };
  } else if (kind === "CronJob") {
    object.spec = { schedule: "*/15 * * * *", jobTemplate: { spec: { template: { spec: { containers: CONTAINERS } } } } };
  } else if (kind === "Node") {
    metadata.name = "ip-10-0-12-34.eu-west-1.compute.internal";
  }
  return { object, context, kubeConfig: "" };
}

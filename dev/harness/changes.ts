/*
 * Change history fixtures (Health › Changes, the panels' Changes section,
 * likelyCause) and the recorder's commands (src-tauri/src/changes):
 * rollout history on the ReplicaSets, ControllerRevisions, managedFields,
 * more events, and records `changes_list` returns.
 *
 * The story on prod: Helm upgraded checkout to 3.2.0 three days ago;
 * checkout-flags was edited 25 min ago and checkout-api restarted 12 min
 * ago (it crash loops since: the likely cause is the edit, not the
 * restart); payments-worker's memory limit was lowered 2 h ago and it runs
 * out of memory; feature-flags is rolling out 0.22.0; ledger got a new env
 * var; postgres moved to 16.3; a node was cordoned, another is under disk
 * pressure. Staging has one Argo CD rollout.
 *
 * `?scenario=empty`: no records and no history.
 */
import { CLUSTERS, CONTEXTS, KUBECONFIG } from "./fixtures";
import { registerKubeRoutes } from "./kubeApi";

const NOW = Date.now();
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const PROD = CONTEXTS[0].name;
const STAGING = CONTEXTS[1].name;

let serial = 0;
const uid = () => `c4a9e7d2-${(++serial).toString(16).padStart(4, "0")}-4b1c-9f3e-6a5d8c2b1e0f`;
const hash = (seed: string) =>
  Array.from(seed + "xxxxxxxx", (c, i) => "bcdfghjklmnpqrstvwxz2456789"[(c.charCodeAt(0) * (i + 7)) % 27]).join("").slice(0, 9);

const find = (context: string, plural: string, name: string) =>
  ((CLUSTERS[context]?.[plural] ?? []) as any[]).find((o) => o.metadata?.name === name);

const container = (template: any) => template.spec.containers[0];
/*
 * ?scenario=empty: the lists the timeline reads once are empty too (routes
 * registered at import come before the generic ones).
 */
const SCENARIO = new URLSearchParams(location.search).get("scenario") || localStorage.getItem("harness-scenario") || "default";
if (SCENARIO === "empty") {
  registerKubeRoutes([
    {
      method: "GET",
      path: /^\/(?:api\/v1|apis\/apps\/v1)\/(?:namespaces\/[^/]+\/)?(?:controllerrevisions|deployments|statefulsets|daemonsets|configmaps|secrets)$/,
      handle: () => ({ kind: "List", apiVersion: "v1", items: [] }),
    },
  ]);
}

/* checkout-api's restart. */
const restartedAt = ago(12 * MIN);

/*
 * A Deployment's rollout history: the current ReplicaSet becomes the last
 * revision, earlier ones are added (scaled to zero) with their template.
 */
function rollouts(context: string, name: string, revisions: { revision: number; at: number; edit?: (template: any) => void }[]) {
  const deployment = find(context, "deployments", name);
  const cluster = CLUSTERS[context];
  const current = (cluster.replicasets as any[]).find((rs) => rs.metadata.ownerReferences?.[0]?.uid === deployment?.metadata.uid);
  if (!deployment || !current) return;
  // This history replaces the generic one setup.ts gives every Deployment.
  cluster.replicasets = cluster.replicasets.filter(
    (rs: any) => rs === current || rs.metadata.ownerReferences?.[0]?.uid !== deployment.metadata.uid
  );
  const list = cluster.replicasets as any[];
  const last = revisions[revisions.length - 1];
  deployment.metadata.annotations["deployment.kubernetes.io/revision"] = String(last.revision);
  const templateOf = (edit?: (template: any) => void) => {
    const template = structuredClone(deployment.spec.template);
    edit?.(template);
    return template;
  };
  for (const r of revisions) {
    const template = templateOf(r.edit);
    if (r === last) {
      current.metadata.creationTimestamp = ago(r.at);
      current.metadata.annotations = { ...current.metadata.annotations, "deployment.kubernetes.io/revision": String(r.revision) };
      current.spec.template = { ...template, metadata: { ...template.metadata, labels: { ...template.metadata.labels, "pod-template-hash": current.metadata.name.split("-").pop() } } };
      continue;
    }
    const rsName = `${name}-${hash(`${name}${r.revision}`)}`;
    list.push({
      apiVersion: "apps/v1",
      kind: "ReplicaSet",
      metadata: {
        name: rsName,
        namespace: deployment.metadata.namespace,
        uid: uid(),
        creationTimestamp: ago(r.at),
        labels: { ...current.metadata.labels },
        annotations: { "deployment.kubernetes.io/revision": String(r.revision) },
        ownerReferences: current.metadata.ownerReferences,
      },
      spec: { replicas: 0, template: { ...template, metadata: { ...template.metadata, labels: { ...template.metadata.labels, "pod-template-hash": rsName.split("-").pop() } } } },
      status: { replicas: 0 },
    });
  }
}

/* managedFields entries: (manager, when, what it owns, how). */
const write = (manager: string, at: number, fieldsV1: any, subresource?: string) => ({
  manager,
  operation: "Update",
  apiVersion: "v1",
  time: ago(at),
  fieldsType: "FieldsV1",
  fieldsV1,
  ...(subresource ? { subresource } : {}),
});
const owns = (object: any, ...entries: any[]) => {
  if (object) object.metadata.managedFields = [...(object.metadata.managedFields ?? []), ...entries];
};
const created = (object: any, manager: string) =>
  object && write(manager, NOW - Date.parse(object.metadata.creationTimestamp), { "f:metadata": { "f:labels": {} }, "f:spec": {} });

/*
 * The prod story. Runs after setup.ts gave every Deployment a generic
 * rollout history, which it replaces for the Deployments it is about.
 */
function addHistory() {
  // setup.ts' generic history (revisions 4 to 6, two to thirty days old)
  // would put a dozen identical rollouts on the timeline: older here.
  for (const cluster of Object.values(CLUSTERS)) {
    for (const rs of cluster.replicasets as any[]) {
      if (/-\d+b\d+f\d+c$/.test(rs.metadata.name)) {
        rs.metadata.creationTimestamp = new Date(Date.parse(rs.metadata.creationTimestamp) - 20 * DAY).toISOString();
      }
    }
  }

  rollouts(PROD, "checkout-api", [
    { revision: 5, at: 6 * DAY, edit: (t) => (container(t).image = "ghcr.io/acme/checkout-api:v3.1.4") },
    { revision: 6, at: 3 * DAY },
    { revision: 7, at: 12 * MIN, edit: (t) => (t.metadata.annotations = { "kubectl.kubernetes.io/restartedAt": restartedAt }) },
  ]);
  const checkoutApi = find(PROD, "deployments", "checkout-api");
  if (checkoutApi) checkoutApi.spec.template.metadata.annotations = { "kubectl.kubernetes.io/restartedAt": restartedAt };
  owns(
    checkoutApi,
    created(checkoutApi, "helm"),
    write("helm", 3 * DAY, { "f:spec": { "f:template": { "f:spec": { "f:containers": { 'k:{"name":"checkout-api"}': { "f:image": {} } } } } } }),
    write("kubectl-rollout", 12 * MIN, { "f:spec": { "f:template": { "f:metadata": { "f:annotations": { "f:kubectl.kubernetes.io/restartedAt": {} } } } } })
  );

  rollouts(PROD, "payments-worker", [
    { revision: 6, at: 5 * DAY, edit: (t) => (container(t).resources.limits.memory = "512Mi") },
    { revision: 7, at: 2 * HOUR },
  ]);
  owns(
    find(PROD, "deployments", "payments-worker"),
    write("kubectl-edit", 2 * HOUR, {
      "f:spec": { "f:template": { "f:spec": { "f:containers": { 'k:{"name":"payments-worker"}': { "f:resources": { "f:limits": { "f:memory": {} } } } } } } },
    })
  );

  rollouts(PROD, "payments-api", [
    { revision: 41, at: 2 * DAY, edit: (t) => (container(t).image = "ghcr.io/acme/payments-api:v2.14.2") },
    { revision: 42, at: 2 * HOUR + 2 * MIN },
  ]);

  rollouts(PROD, "feature-flags", [
    { revision: 1, at: 9 * HOUR, edit: (t) => (container(t).image = "ghcr.io/acme/feature-flags:v0.21.3") },
    { revision: 2, at: 9 * MIN },
  ]);

  // New 25 minutes ago: no history yet.
  rollouts(PROD, "image-resizer", [{ revision: 1, at: 25 * MIN }]);

  rollouts(PROD, "ledger", [
    { revision: 4, at: 20 * DAY },
    { revision: 5, at: 26 * HOUR, edit: (t) => container(t).env.push({ name: "LEDGER_V2_READS", value: "true" }) },
  ]);
  const ledger = find(PROD, "deployments", "ledger");
  if (ledger) container(ledger.spec.template).env.push({ name: "LEDGER_V2_READS", value: "true" });

  owns(find(PROD, "deployments", "cart-service"), write("kubectl-scale", 40 * MIN, { "f:spec": { "f:replicas": {} } }, "scale"));

  /* The ConfigMap checkout reads its flags from, edited by hand. */
  const flags = find(PROD, "configmaps", "checkout-flags");
  if (flags) {
    flags.data = { FAST_CHECKOUT: "true", NEW_CART: "false", ...flags.data };
    owns(flags, created(flags, "helm"), write("kubectl-edit", 25 * MIN, { "f:data": { "f:FAST_CHECKOUT": {} } }));
  }
  owns(find(PROD, "secrets", "payments-db"), write("external-secrets", 6 * HOUR, { "f:data": { "f:password": {} } }));

  /* postgres moved to 16.3 two days ago. */
  const postgres = find(PROD, "statefulsets", "postgres");
  if (postgres) {
    const revision = (n: number, at: number, image: string) => {
      const template = structuredClone(postgres.spec.template);
      container(template).image = image;
      return {
        apiVersion: "apps/v1",
        kind: "ControllerRevision",
        metadata: {
          name: `postgres-${hash(`pg${n}`)}`,
          namespace: postgres.metadata.namespace,
          uid: uid(),
          creationTimestamp: ago(at),
          labels: { ...postgres.spec.selector.matchLabels },
          ownerReferences: [{ apiVersion: "apps/v1", kind: "StatefulSet", name: "postgres", uid: postgres.metadata.uid, controller: true }],
        },
        revision: n,
        data: { spec: { template: { ...template, $patch: "replace" } } },
      };
    };
    CLUSTERS[PROD].controllerrevisions = [revision(1, 60 * DAY, "postgres:16.2"), revision(2, 2 * DAY, "postgres:16.3")];
  }

  /* Scaling, still in the cluster's events. */
  const hpaEvent = (name: string, namespace: string, at: number, message: string) => ({
    apiVersion: "v1",
    kind: "Event",
    metadata: { name: `${name}.${hash(name + at)}`, namespace, uid: uid(), creationTimestamp: ago(at) },
    involvedObject: { kind: "HorizontalPodAutoscaler", name, namespace, apiVersion: "autoscaling/v2" },
    type: "Normal",
    reason: "SuccessfulRescale",
    message,
    count: 1,
    source: { component: "horizontal-pod-autoscaler" },
    firstTimestamp: ago(at),
    lastTimestamp: ago(at),
  });
  CLUSTERS[PROD].events.push(hpaEvent("checkout-web", "checkout", 50 * MIN, "New size: 5; reason: cpu resource utilization (percentage of request) above target"));
}

/* What the recorder "saw", per context. */
function recordsOf(): Record<string, any[]> {
  const ref = (context: string, plural: string, name: string) => {
    const object = find(context, plural, name);
    return { name, namespace: object?.metadata.namespace ?? "", uid: object?.metadata.uid ?? "" };
  };
  const recordedEvent = (at: number, kind: string, name: string, namespace: string, type: string, reason: string, message: string, count: number, by: string) => ({
    id: `event:${uid()}`,
    at: ago(at),
    kind,
    name,
    namespace,
    action: "event",
    by,
    event: { type, reason, message, count, firstAt: ago(at + count * 30_000) },
  });
  const nodes = CLUSTERS[PROD].nodes as any[];

  return {
    [PROD]: [
      { id: "r-restart", at: ago(12 * MIN), kind: "Deployment", ...ref(PROD, "deployments", "checkout-api"), action: "updated", by: "kubectl-rollout", fields: [{ path: ["template", "metadata", "annotations", "kubectl.kubernetes.io/restartedAt"], to: restartedAt }] },
      { id: "r-flags", at: ago(25 * MIN), kind: "ConfigMap", ...ref(PROD, "configmaps", "checkout-flags"), action: "updated", by: "kubectl-edit", keys: { changed: ["FAST_CHECKOUT"] } },
      { id: "r-cart", at: ago(40 * MIN), kind: "Deployment", ...ref(PROD, "deployments", "cart-service"), action: "updated", by: "kubectl-scale", fields: [{ path: ["replicas"], from: 3, to: 2 }] },
      {
        id: "r-cordon",
        at: ago(50 * MIN),
        kind: "Node",
        name: nodes[3]?.metadata.name,
        uid: nodes[3]?.metadata.uid,
        action: "updated",
        by: "kubectl-cordon",
        fields: [{ path: ["unschedulable"], to: true }, { path: ["taints"], to: [{ key: "node.kubernetes.io/unschedulable", effect: "NoSchedule" }] }],
      },
      {
        id: "r-disk",
        at: (nodes[2]?.status.conditions ?? []).find((c: any) => c.type === "DiskPressure")?.lastTransitionTime ?? ago(2 * HOUR),
        kind: "Node",
        name: nodes[2]?.metadata.name,
        uid: nodes[2]?.metadata.uid,
        action: "condition",
        condition: { type: "DiskPressure", from: "False", to: "True", reason: "KubeletHasDiskPressure" },
      },
      recordedEvent(3 * HOUR, "HorizontalPodAutoscaler", "checkout-web", "checkout", "Normal", "SuccessfulRescale", "New size: 3; reason: All metrics below target", 1, "horizontal-pod-autoscaler"),
      recordedEvent(5 * HOUR, "Pod", "grafana-7c9f6d5b8-qx2lp", "monitoring", "Warning", "FailedMount", 'MountVolume.SetUp failed for volume "dashboards-extra" : configmap "grafana-dashboards-extra" not found', 3, "kubelet"),
      { id: "r-secret", at: ago(6 * HOUR), kind: "Secret", ...ref(PROD, "secrets", "payments-db"), action: "updated", by: "external-secrets", keys: { changed: ["password"] } },
      recordedEvent(27 * HOUR, "Pod", "ledger-5d8c7b9f6-m4k2t", "payments", "Warning", "Unhealthy", "Readiness probe failed: HTTP probe failed with statuscode: 503", 12, "kubelet"),
      { id: "r-old-flags", at: ago(28 * HOUR), kind: "ConfigMap", name: "checkout-flags-old", namespace: "checkout", uid: uid(), action: "deleted" },
    ],
    [STAGING]: [
      {
        id: "s-cart",
        at: ago(3 * HOUR),
        kind: "Deployment",
        ...ref(STAGING, "deployments", "cart-service"),
        action: "updated",
        by: "argocd-application-controller",
        fields: [{ path: ["template", "spec", "containers", "[cart-service]", "image"], from: "ghcr.io/acme/cart:v1.4.1", to: "ghcr.io/acme/cart:v1.4.2" }],
      },
    ],
  }
}

/* The recorder ran yesterday afternoon and since this morning. */
const SESSIONS = [
  { from: ago(31 * HOUR), to: ago(26 * HOUR) },
  { from: ago(6 * HOUR + 20 * MIN), to: ago(0) },
];

export function createChangesMocks(scenario: string) {
  addHistory();
  const RECORDS = recordsOf();
  const handlers: Record<string, (p: any) => unknown> = {
    changes_track: () => null,
    changes_list: ({ request }) =>
      (request?.targets ?? []).map((t: any) => {
        const since = request.since ? Date.parse(request.since) : 0;
        const objects: any[] = request.objects ?? [];
        const records = scenario === "empty" ? [] : (RECORDS[t.context] ?? []);
        return {
          context: t.context,
          kubeConfig: t.kubeConfig || KUBECONFIG,
          recording: true,
          sessions: scenario === "empty" ? [] : SESSIONS,
          records: records
            .filter((r) => Date.parse(r.at) >= since)
            .filter((r) => !objects.length || objects.some((o) => o.kind === r.kind && o.name === r.name && (o.namespace ?? "") === (r.namespace ?? ""))),
        };
      }),
  };
  return { handlers };
}

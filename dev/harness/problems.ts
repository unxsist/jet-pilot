/*
 * Health › Problems fixtures and mocks. Adds to the harness clusters on
 * import, next to what fixtures.ts already breaks (checkout-api crash
 * looping, payments-worker out of memory, image-resizer's image, a pending
 * alertmanager pod, redis waiting for its claim, report-generator's failed
 * run, disk pressure on ip-10-0-78-201):
 *
 * - checkout-api: managed by Argo CD app shop, its rollout past its
 *   deadline, revisions 5-7 (v3.1.2, v3.1.4, v3.2.0) to roll back to
 * - fraud-check: both pods miss a Secret (Helm release fraud-check)
 * - search-api: one pod failing its readiness probe (HTTP 503)
 * - payments-api: two evicted pods
 * - debug-toolbox: a bare pod stuck terminating behind a finalizer
 * - db-migrate-42: a failed Job
 * - staging (?contexts=2): a node that stopped responding
 *
 * Routes: a container's logs (`pods/<name>/log`, previous instances too),
 * creating a Job (Retry), deleting a pod. Dry-run and strategic patches are
 * handled by the PATCH route in panels.ts.
 */
import { CLUSTERS, CONTEXTS } from "./fixtures";
import { kubeError, registerKubeRoutes } from "./kubeApi";

const NOW = Date.now();
const MIN = 60;
const HOUR = 3600;
const DAY = 86400;
const ago = (seconds: number) => new Date(NOW - seconds * 1000).toISOString();

let counter = 0;
const uid = () => `c0ffee00-4b1d-4e5a-9c3f-${(++counter).toString(16).padStart(12, "0")}`;

const prod = CLUSTERS[CONTEXTS[0]!.name]!;
const staging = CLUSTERS[CONTEXTS[1]!.name]!;

const labels = (app: string) => ({
  "app.kubernetes.io/name": app,
  "app.kubernetes.io/part-of": "acme",
  "app.kubernetes.io/managed-by": "Helm",
});
const owner = (kind: string, object: any, apiVersion = "apps/v1") => ({
  apiVersion,
  kind,
  name: object.metadata.name,
  uid: object.metadata.uid,
  controller: true,
  blockOwnerDeletion: true,
});
const clone = <T>(value: T): T => structuredClone(value);

const event = (involved: any, reason: string, message: string, count: number, last: number, component = "kubelet") => ({
  apiVersion: "v1",
  kind: "Event",
  metadata: { name: `${involved.metadata.name}.${uid().slice(-12)}`, namespace: involved.metadata.namespace ?? "default", uid: uid(), creationTimestamp: ago(last + count * 30) },
  involvedObject: { kind: involved.kind, name: involved.metadata.name, namespace: involved.metadata.namespace, uid: involved.metadata.uid, apiVersion: involved.apiVersion },
  type: "Warning",
  reason,
  message,
  count,
  source: { component },
  firstTimestamp: ago(last + count * 30),
  lastTimestamp: ago(last),
});

/* A Deployment with its ReplicaSet and pods (states set by the caller). */
function workload(name: string, namespace: string, image: string, replicas: number, age: number, extra: { annotations?: Record<string, string>; container?: any } = {}) {
  const hash = `${name.length}c9d4b7f5`.slice(0, 9);
  const container = {
    name,
    image,
    ports: [{ name: "http", containerPort: 8080, protocol: "TCP" }],
    resources: { requests: { cpu: "100m", memory: "128Mi" }, limits: { cpu: "500m", memory: "256Mi" } },
    ...extra.container,
  };
  const template = { metadata: { labels: { ...labels(name), "pod-template-hash": hash } }, spec: { containers: [container] } };
  const deployment = {
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: {
      name,
      namespace,
      uid: uid(),
      generation: 3,
      creationTimestamp: ago(age),
      labels: labels(name),
      annotations: { "deployment.kubernetes.io/revision": "3", "meta.helm.sh/release-name": name, "meta.helm.sh/release-namespace": namespace, ...extra.annotations },
    },
    spec: { replicas, selector: { matchLabels: { "app.kubernetes.io/name": name } }, template: { ...template, metadata: { labels: labels(name) } } },
    status: { observedGeneration: 3, replicas, updatedReplicas: replicas, readyReplicas: 0, availableReplicas: 0, conditions: [] as any[] },
  };
  const replicaSet = {
    apiVersion: "apps/v1",
    kind: "ReplicaSet",
    metadata: { name: `${name}-${hash}`, namespace, uid: uid(), creationTimestamp: ago(age), labels: template.metadata.labels, annotations: { "deployment.kubernetes.io/revision": "3" }, ownerReferences: [owner("Deployment", deployment)] },
    spec: { replicas, template },
    status: { replicas, readyReplicas: 0 },
  };
  const pod = (suffix: string, created: number, status: any, spec: any = {}) => ({
    apiVersion: "v1",
    kind: "Pod",
    metadata: { name: `${replicaSet.metadata.name}-${suffix}`, namespace, uid: uid(), creationTimestamp: ago(created), labels: template.metadata.labels, ownerReferences: [owner("ReplicaSet", replicaSet)] },
    spec: { containers: [container], restartPolicy: "Always", serviceAccountName: name, nodeName: "ip-10-0-45-118.eu-west-1.compute.internal", ...spec },
    status: { phase: "Running", qosClass: "Burstable", startTime: ago(created), ...status },
  });
  return { deployment, replicaSet, pod, container };
}

const conditions = (ready: boolean, since: number) => [
  { type: "PodScheduled", status: "True", lastTransitionTime: ago(since + 5 * MIN) },
  { type: "Initialized", status: "True", lastTransitionTime: ago(since + 5 * MIN) },
  { type: "ContainersReady", status: ready ? "True" : "False", lastTransitionTime: ago(since) },
  { type: "Ready", status: ready ? "True" : "False", lastTransitionTime: ago(since) },
];

/* --------------------------------------------- checkout-api (prod) -- */

const checkout = prod.deployments.find((d: any) => d.metadata.name === "checkout-api");
if (checkout) {
  checkout.metadata.annotations = {
    ...checkout.metadata.annotations,
    "argocd.argoproj.io/tracking-id": "shop:apps/Deployment:checkout/checkout-api",
  };
  checkout.status.conditions = checkout.status.conditions.map((c: any) =>
    c.type === "Progressing"
      ? { ...c, status: "False", reason: "ProgressDeadlineExceeded", lastTransitionTime: ago(38 * MIN), lastUpdateTime: ago(38 * MIN), message: `ReplicaSet "${c.message?.match(/"([^"]+)"/)?.[1] ?? "checkout-api"}" has timed out progressing.` }
      : c
  );
  const current = prod.replicasets.find((rs: any) => rs.metadata.ownerReferences?.[0]?.uid === checkout.metadata.uid);
  if (current) {
    const hash = current.metadata.name.split("-").pop();
    current.metadata.annotations = { ...current.metadata.annotations, "deployment.kubernetes.io/revision": "7" };
    current.spec.template = { metadata: { labels: { ...checkout.spec.template.metadata.labels, "pod-template-hash": hash } }, spec: clone(checkout.spec.template.spec) };
    for (const [revision, version, age] of [[6, "v3.1.4", 3 * DAY], [5, "v3.1.2", 11 * DAY]] as const) {
      const template = clone(current.spec.template);
      template.metadata.labels["pod-template-hash"] = `${revision}f7c2d9b8`;
      template.spec.containers[0].image = `ghcr.io/acme/checkout-api:${version}`;
      prod.replicasets.push({
        apiVersion: "apps/v1",
        kind: "ReplicaSet",
        metadata: {
          name: `checkout-api-${revision}f7c2d9b8`,
          namespace: "checkout",
          uid: uid(),
          creationTimestamp: ago(age),
          labels: checkout.metadata.labels,
          annotations: { "deployment.kubernetes.io/revision": String(revision) },
          ownerReferences: [owner("Deployment", checkout)],
        },
        spec: { replicas: 0, template },
        status: { replicas: 0 },
      });
    }
  }
}

/* -------------------------------------------- fraud-check (prod) -- */

{
  const fraud = workload("fraud-check", "payments", "ghcr.io/acme/fraud-check:v0.8.0", 2, 50 * MIN, {
    container: { envFrom: [{ secretRef: { name: "fraud-model-credentials" } }] },
  });
  const missing = 'secret "fraud-model-credentials" not found';
  const waiting = (created: number) =>
    fraud.pod(created === 48 * MIN ? "q7x2m" : "w4k9p", created, {
      phase: "Pending",
      conditions: conditions(false, created),
      containerStatuses: [{ name: "fraud-check", image: fraud.container.image, ready: false, started: false, restartCount: 0, state: { waiting: { reason: "CreateContainerConfigError", message: missing } } }],
    });
  const pods = [waiting(48 * MIN), waiting(47 * MIN)];
  prod.deployments.push(fraud.deployment);
  prod.replicasets.push(fraud.replicaSet);
  prod.pods.push(...pods);
  prod.events.push(...pods.map((p) => event(p, "Failed", `Error: ${missing}`, 214, 20)));
}

/* --------------------------------------------- search-api (prod) -- */

{
  const probe = { httpGet: { path: "/healthz/ready", port: 8080 }, periodSeconds: 10, failureThreshold: 3 };
  const search = workload("search-api", "platform", "ghcr.io/acme/search-api:v2.3.1", 2, 6 * DAY, { container: { readinessProbe: probe } });
  search.deployment.status.readyReplicas = 1;
  search.deployment.status.availableReplicas = 1;
  const running = (suffix: string, ready: boolean, since: number) =>
    search.pod(suffix, 6 * DAY, {
      podIP: `10.42.31.${suffix.length * 7}`,
      conditions: conditions(ready, since),
      containerStatuses: [{ name: "search-api", image: search.container.image, ready, started: true, restartCount: 0, state: { running: { startedAt: ago(6 * DAY) } } }],
    });
  const failing = running("h2v8d", false, 23 * MIN);
  prod.deployments.push(search.deployment);
  prod.replicasets.push(search.replicaSet);
  prod.pods.push(running("m5t1c", true, 6 * DAY), failing);
  prod.events.push(event(failing, "Unhealthy", "Readiness probe failed: HTTP probe failed with statuscode: 503", 138, 8));
}

/* -------------------------------------- evicted payments-api pods -- */

{
  const template = prod.pods.find((p: any) => p.metadata.labels?.["app.kubernetes.io/name"] === "payments-api");
  if (template) {
    for (const [suffix, at] of [["g8c2x", 3 * HOUR], ["t6n4w", 3 * HOUR + 4 * MIN]] as const) {
      const pod = clone(template);
      pod.metadata = { ...pod.metadata, name: `${template.metadata.ownerReferences[0].name}-${suffix}`, uid: uid(), creationTimestamp: ago(at + DAY) };
      pod.status = {
        phase: "Failed",
        reason: "Evicted",
        message: "The node was low on resource: memory. Threshold quantity: 100Mi, available: 84Mi. Container payments-api was using 498Mi, request is 256Mi.",
        startTime: ago(at + DAY),
        conditions: [{ type: "DisruptionTarget", status: "True", reason: "TerminationByKubelet", lastTransitionTime: ago(at) }],
      };
      prod.pods.push(pod);
      prod.events.push(event(pod, "Evicted", pod.status.message, 1, at));
    }
  }
}

/* ------------------------------------ debug-toolbox (stuck, prod) -- */

{
  const pod = {
    apiVersion: "v1",
    kind: "Pod",
    metadata: { name: "debug-toolbox", namespace: "default", uid: uid(), creationTimestamp: ago(2 * DAY), deletionTimestamp: ago(26 * MIN), deletionGracePeriodSeconds: 30, finalizers: ["acme.dev/session-recording"] },
    spec: { containers: [{ name: "toolbox", image: "nicolaka/netshoot:v0.13" }], nodeName: "ip-10-0-91-7.eu-west-1.compute.internal", restartPolicy: "Always", terminationGracePeriodSeconds: 30 },
    status: { phase: "Running", startTime: ago(2 * DAY), conditions: conditions(true, 2 * DAY), containerStatuses: [{ name: "toolbox", image: "nicolaka/netshoot:v0.13", ready: true, restartCount: 0, state: { running: { startedAt: ago(2 * DAY) } } }] },
  };
  prod.pods.push(pod);
  prod.events.push(event(pod, "FailedKillPod", "error killing pod: failed to \"KillPodSandbox\" for \"debug-toolbox\": rpc error: code = DeadlineExceeded", 6, 4 * MIN));
}

/* --------------------------------------------- db-migrate-42 (prod) -- */

{
  const job = {
    apiVersion: "batch/v1",
    kind: "Job",
    metadata: { name: "db-migrate-42", namespace: "payments", uid: uid(), creationTimestamp: ago(52 * MIN), labels: { "app.kubernetes.io/name": "db-migrate" } },
    spec: {
      backoffLimit: 2,
      completions: 1,
      selector: { matchLabels: { "batch.kubernetes.io/controller-uid": "x" } },
      template: { metadata: { labels: { "app.kubernetes.io/name": "db-migrate" } }, spec: { containers: [{ name: "migrate", image: "ghcr.io/acme/payments-migrations:v42" }], restartPolicy: "Never" } },
    },
    status: { failed: 3, startTime: ago(52 * MIN), conditions: [{ type: "Failed", status: "True", reason: "BackoffLimitExceeded", message: "Job has reached the specified backoff limit", lastTransitionTime: ago(41 * MIN) }] },
  };
  prod.jobs.push(job);
  const attempts = [[52, "x4f7q"], [48, "k2m9d"], [42, "p8v3n"]] as const;
  for (const [minutes, suffix] of attempts) {
    prod.pods.push({
      apiVersion: "v1",
      kind: "Pod",
      metadata: { name: `db-migrate-42-${suffix}`, namespace: "payments", uid: uid(), creationTimestamp: ago(minutes * MIN), labels: { "job-name": "db-migrate-42" }, ownerReferences: [owner("Job", job, "batch/v1")] },
      spec: { containers: job.spec.template.spec.containers, restartPolicy: "Never", nodeName: "ip-10-0-12-34.eu-west-1.compute.internal" },
      status: {
        phase: "Failed",
        startTime: ago(minutes * MIN),
        containerStatuses: [{ name: "migrate", image: "ghcr.io/acme/payments-migrations:v42", ready: false, restartCount: 0, state: { terminated: { exitCode: 1, reason: "Error", startedAt: ago(minutes * MIN), finishedAt: ago(minutes * MIN - 40) } } }],
      },
    });
  }
  prod.events.push(event(job, "BackoffLimitExceeded", "Job has reached the specified backoff limit", 1, 41 * MIN, "job-controller"));
}

/* ------------------------------------------- a silent staging node -- */

{
  const node = staging.nodes[1];
  if (node) {
    node.status.conditions = node.status.conditions.map((c: any) =>
      c.type === "Ready"
        ? { ...c, status: "Unknown", reason: "NodeStatusUnknown", message: "Kubelet stopped posting node status.", lastTransitionTime: ago(17 * MIN) }
        : { ...c, status: "Unknown", reason: "NodeStatusUnknown", message: "Kubelet stopped posting node status." }
    );
  }
}

/* -------------------------------------------------------------- logs -- */

const stamp = (seconds: number) => ago(seconds).replace(/\.\d+Z$/, "Z");

const LOGS: Record<string, (previous: boolean) => string[]> = {
  "checkout-api": () => [
    `${stamp(330)} INFO  starting checkout-api v3.2.0 (commit 9f2c1ab)`,
    `${stamp(330)} INFO  loading config from /etc/checkout/config.yaml`,
    `${stamp(329)} INFO  feature flags: fastCheckout=true, splitPayments=true`,
    `${stamp(329)} INFO  connecting to payments-api at http://payments-api.payments`,
    `${stamp(328)} WARN  CHECKOUT_PAYMENTS_TOKEN is not set; splitPayments needs it since 3.2.0`,
    `${stamp(328)} ERROR payments client: refusing to start without a token`,
    `${stamp(328)} FATAL startup failed: missing required setting CHECKOUT_PAYMENTS_TOKEN`,
  ],
  "payments-worker": () => [
    'level=info ts=2026-10-31T16:58:02Z msg="processing batch" batch=48211 size=5000',
    'level=info ts=2026-10-31T16:58:04Z msg="loaded payment intents" count=5000',
    'level=warn ts=2026-10-31T16:58:09Z msg="memory usage high" heap_mb=231 limit_mb=256',
    "fatal error: runtime: out of memory",
    "",
    "goroutine 41 [running]:",
    "runtime.throw({0x1a2b3c4?, 0x40?})",
    "\t/usr/local/go/src/runtime/panic.go:1023 +0x5c",
    "github.com/acme/payments-worker/internal/batch.(*Loader).Load(0xc000124000)",
    "\t/src/internal/batch/loader.go:88 +0x1f4",
  ],
  "db-migrate": () => [
    "migrate: connected to postgres at postgres.payments:5432",
    "migrate: current version 41, applying 42_orders_v2.sql",
    'migrate: ERROR: relation "orders_v2" already exists (SQLSTATE 42P07)',
    "migrate: rolling back 42_orders_v2.sql",
    "migrate: failed after 1 of 1 migrations",
  ],
};

const appOf = (pod: any) => pod?.metadata?.labels?.["app.kubernetes.io/name"] ?? pod?.metadata?.labels?.["job-name"]?.replace(/-\d+$/, "");

registerKubeRoutes([
  {
    // A container's logs (the problem panel's tail).
    method: "GET",
    path: /^\/api\/v1\/namespaces\/([^/]+)\/pods\/([^/]+)\/log$/,
    handle: (request, [, namespace, name]) => {
      const pod = (CLUSTERS[request.context]?.pods ?? []).find((p: any) => p.metadata?.name === decodeURIComponent(name!) && p.metadata?.namespace === namespace);
      if (!pod) throw kubeError(404, `pods "${name}" not found`, "NotFound");
      const lines = LOGS[appOf(pod)]?.(request.query.get("previous") === "true") ?? [
        `${stamp(120)} INFO  listening on :8080`,
        `${stamp(60)} INFO  GET /healthz 200 1ms`,
      ];
      return lines.slice(-Number(request.query.get("tailLines") ?? lines.length)).join("\n") + "\n";
    },
  },
  {
    // Retry: a new Job from a failed one.
    method: "POST",
    path: /^\/apis\/batch\/v1\/namespaces\/([^/]+)\/jobs$/,
    handle: (request) => {
      const job = clone(request.body);
      job.metadata.name = `${job.metadata.generateName}${uid().slice(-5)}`;
      job.status = { active: 1, startTime: new Date().toISOString() };
      return (window as any).__harnessAdd("jobs", job);
    },
  },
  {
    method: "DELETE",
    path: /^\/api\/v1\/namespaces\/([^/]+)\/pods\/([^/]+)$/,
    handle: (_request, [, , name]) => {
      (window as any).__harnessRemove("pods", decodeURIComponent(name!));
      return { kind: "Status", status: "Success" };
    },
  },
]);

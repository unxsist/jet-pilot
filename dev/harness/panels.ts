/*
 * Side panel fixtures and mocks (rich per-kind panels, inline edits, the
 * native describe). Adds to the harness clusters on import:
 *
 * - nodes: system info, zone / instance / pool labels, a custom taint on
 *   ip-10-0-45-118, disk pressure (with events) on ip-10-0-78-201; ip-10-0-91-7
 *   is cordoned (fixtures.ts)
 * - pods: probes, tolerations and anti-affinity / spread on checkout-api and
 *   payments-api
 * - autoscalers with CPU, memory and custom metrics; checkout-web at its
 *   maximum
 * - db-backup: a time zone and a history of jobs; events for it
 * - EndpointSlices for every Service (ready / not-ready from the pods)
 * - payments-config with YAML, JSON and plain values; a last-applied
 *   annotation on the payments-api Deployment
 * - a ResourceQuota (one line nearly full) and a LimitRange in payments
 * - CSI details on the volumes, gp3 parameters, the nginx IngressClass
 *
 * Routes: PATCH of any built-in object (JSON merge patch, JSON patch with
 * `test` and strategic merge patch, applied to the fixture and pushed to
 * the watchers, or only answered with `?dryRun=All`; refused with
 * `?scenario=edit-forbidden`), lists with a field / label selector and
 * the events of one object (`fieldSelector=involvedObject...`).
 */
import { CLUSTERS, CONTEXTS, API_GROUPS } from "./fixtures";
import { kubeError, registerKubeRoutes } from "./kubeApi";

const NOW = Date.now();
const MIN = 60;
const HOUR = 3600;
const DAY = 86400;
const ago = (seconds: number) => new Date(NOW - seconds * 1000).toISOString();

let uidCounter = 0;
const uid = () => `a0000000-7e1f-4c2d-9b3a-${(++uidCounter).toString(16).padStart(12, "0")}`;

/* ------------------------------------------------------------ nodes -- */

const prod = CLUSTERS[CONTEXTS[0]!.name]!;

prod.nodes.forEach((node: any, i: number) => {
  node.metadata.labels = {
    ...node.metadata.labels,
    "kubernetes.io/os": "linux",
    "kubernetes.io/arch": "amd64",
    "topology.kubernetes.io/region": "eu-west-1",
    "eks.amazonaws.com/nodegroup": i === 0 ? "system" : "general-purpose",
    "eks.amazonaws.com/capacityType": i === 2 ? "SPOT" : "ON_DEMAND",
  };
  node.spec = {
    ...node.spec,
    providerID: `aws:///eu-west-1${"abc"[i % 3]}/i-0${(0x3f2a9c41 + i * 7919).toString(16)}e5d1`,
    podCIDR: `10.42.${i * 16}.0/20`,
  };
  node.status.nodeInfo = {
    ...node.status.nodeInfo,
    operatingSystem: "linux",
    kernelVersion: "6.1.102-111.182.amzn2023.x86_64",
    kubeProxyVersion: "v1.30.2-eks-1552ad0",
  };
  node.status.addresses = [
    ...node.status.addresses,
    { type: "Hostname", address: node.metadata.name },
    { type: "InternalDNS", address: node.metadata.name },
  ];
});

/* A custom taint: batch work only (the taints edit screen). */
const batchNode = prod.nodes[1];
batchNode.spec.taints = [{ key: "workload", value: "batch", effect: "PreferNoSchedule" }];

/* Disk pressure, with the kubelet's message. */
const diskNode = prod.nodes[2];
diskNode.status.conditions = diskNode.status.conditions.map((c: any) =>
  c.type === "DiskPressure"
    ? { ...c, message: "Disk usage on /var/lib/containerd is above the eviction threshold (91% used, 10% must stay free)." }
    : c
);
diskNode.spec.taints = [{ key: "node.kubernetes.io/disk-pressure", effect: "NoSchedule", timeAdded: ago(2 * HOUR) }];

/* ------------------------------------------------------------- pods -- */

const probes = (port: number) => ({
  startupProbe: { httpGet: { path: "/healthz", port }, periodSeconds: 5, failureThreshold: 24 },
  livenessProbe: { httpGet: { path: "/healthz", port }, initialDelaySeconds: 10, periodSeconds: 10, failureThreshold: 3 },
  readinessProbe: { httpGet: { path: "/ready", port }, periodSeconds: 5, failureThreshold: 2 },
});
const DEFAULT_TOLERATIONS = [
  { key: "node.kubernetes.io/not-ready", operator: "Exists", effect: "NoExecute", tolerationSeconds: 300 },
  { key: "node.kubernetes.io/unreachable", operator: "Exists", effect: "NoExecute", tolerationSeconds: 300 },
];
const appOf = (object: any) => object.metadata?.labels?.["app.kubernetes.io/name"];

for (const pod of prod.pods) {
  pod.spec.tolerations = [...DEFAULT_TOLERATIONS];
  if (pod.status?.podIP) pod.status.podIPs = [{ ip: pod.status.podIP }];
  const app = appOf(pod);
  if (app === "checkout-api" || app === "payments-api") {
    pod.spec.containers = pod.spec.containers.map((c: any, i: number) => (i === 0 ? { ...c, ...probes(8080) } : c));
    pod.spec.affinity = {
      podAntiAffinity: {
        preferredDuringSchedulingIgnoredDuringExecution: [
          { weight: 100, podAffinityTerm: { topologyKey: "kubernetes.io/hostname", labelSelector: { matchLabels: { "app.kubernetes.io/name": app } } } },
        ],
      },
      nodeAffinity: {
        requiredDuringSchedulingIgnoredDuringExecution: {
          nodeSelectorTerms: [{ matchExpressions: [{ key: "kubernetes.io/arch", operator: "In", values: ["amd64", "arm64"] }] }],
        },
      },
    };
    pod.spec.topologySpreadConstraints = [
      { maxSkew: 1, topologyKey: "topology.kubernetes.io/zone", whenUnsatisfiable: "ScheduleAnyway", labelSelector: { matchLabels: { "app.kubernetes.io/name": app } } },
    ];
    pod.spec.tolerations.push({ key: "workload", operator: "Equal", value: "batch", effect: "PreferNoSchedule" });
    pod.spec.priorityClassName = "business-critical";
  }
}

/* ------------------------------------------------- the payments API -- */

const paymentsApi = prod.deployments.find((d: any) => d.metadata.name === "payments-api");
paymentsApi.metadata.labels = { ...paymentsApi.metadata.labels, tier: "backend", "app.kubernetes.io/version": "2.14.3" };
paymentsApi.metadata.annotations = {
  ...paymentsApi.metadata.annotations,
  "kubectl.kubernetes.io/last-applied-configuration": JSON.stringify({
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: { name: "payments-api", namespace: "payments", labels: paymentsApi.metadata.labels },
    spec: { replicas: 4, selector: paymentsApi.spec.selector, template: { metadata: { labels: { "app.kubernetes.io/name": "payments-api" } }, spec: { containers: [{ name: "payments-api", image: "ghcr.io/acme/payments-api:v2.14.3" }] } } },
  }),
  "acme.dev/owner": "team-payments@acme.dev",
};

/* ----------------------------------------------------- autoscaling -- */

const hpas: any[] = prod.horizontalpodautoscalers;
const paymentsHpa = hpas.find((h) => h.metadata.name === "payments-api");
paymentsHpa.spec.metrics = [
  { type: "Resource", resource: { name: "cpu", target: { type: "Utilization", averageUtilization: 70 } } },
  { type: "Resource", resource: { name: "memory", target: { type: "AverageValue", averageValue: "400Mi" } } },
  { type: "Pods", pods: { metric: { name: "http_requests_per_second" }, target: { type: "AverageValue", averageValue: "100" } } },
];
paymentsHpa.status = {
  currentReplicas: 4,
  desiredReplicas: 4,
  lastScaleTime: ago(3 * HOUR),
  currentMetrics: [
    { type: "Resource", resource: { name: "cpu", current: { averageUtilization: 63, averageValue: "158m" } } },
    { type: "Resource", resource: { name: "memory", current: { averageValue: "312Mi" } } },
    { type: "Pods", pods: { metric: { name: "http_requests_per_second" }, current: { averageValue: "84500m" } } },
  ],
  conditions: [
    { type: "AbleToScale", status: "True", reason: "ReadyForNewScale", message: "recommended size matches current size", lastTransitionTime: ago(3 * HOUR) },
    { type: "ScalingActive", status: "True", reason: "ValidMetricFound", message: "the HPA was able to successfully calculate a replica count from cpu resource utilization (percentage of request)", lastTransitionTime: ago(12 * DAY) },
    { type: "ScalingLimited", status: "False", reason: "DesiredWithinRange", message: "the desired count is within the acceptable range", lastTransitionTime: ago(3 * HOUR) },
  ],
};
const webHpa = hpas.find((h) => h.metadata.name === "checkout-web");
webHpa.spec.maxReplicas = 3;
webHpa.spec.minReplicas = 2;
webHpa.spec.metrics = [{ type: "Resource", resource: { name: "cpu", target: { type: "Utilization", averageUtilization: 60 } } }];
webHpa.status = {
  currentReplicas: 3,
  desiredReplicas: 3,
  currentMetrics: [{ type: "Resource", resource: { name: "cpu", current: { averageUtilization: 96 } } }],
  conditions: [
    { type: "AbleToScale", status: "True", reason: "ReadyForNewScale", lastTransitionTime: ago(2 * HOUR) },
    { type: "ScalingActive", status: "True", reason: "ValidMetricFound", lastTransitionTime: ago(3 * DAY) },
    { type: "ScalingLimited", status: "True", reason: "TooManyReplicas", message: "the desired replica count is more than the maximum replica count", lastTransitionTime: ago(47 * MIN) },
  ],
};

/* --------------------------------------------------------- cron jobs -- */

const backup = prod.cronjobs.find((c: any) => c.metadata.name === "db-backup");
backup.spec = { ...backup.spec, schedule: "0 */2 * * *", timeZone: "Europe/Amsterdam", concurrencyPolicy: "Forbid", successfulJobsHistoryLimit: 3, failedJobsHistoryLimit: 1 };
const backupOwner = { apiVersion: "batch/v1", kind: "CronJob", name: "db-backup", uid: backup.metadata.uid, controller: true };
for (const [index, hours] of [6, 4].entries()) {
  const started = hours * HOUR;
  prod.jobs.push({
    apiVersion: "batch/v1",
    kind: "Job",
    metadata: { name: `db-backup-2874${4920 + index * 120}`, namespace: "payments", uid: uid(), creationTimestamp: ago(started), ownerReferences: [backupOwner] },
    spec: { completions: 1, parallelism: 1, backoffLimit: 2 },
    status: { succeeded: 1, startTime: ago(started), completionTime: ago(started - 38 - index * 7), conditions: [{ type: "Complete", status: "True", lastTransitionTime: ago(started - 38) }] },
  });
}

/* ------------------------------------------------- endpoint slices -- */

const matches = (selector: Record<string, string> | undefined, labels: Record<string, string> | undefined) =>
  !!selector && Object.keys(selector).length > 0 && Object.entries(selector).every(([k, v]) => labels?.[k] === v);

for (const cluster of Object.values(CLUSTERS)) {
  cluster.endpointslices = cluster.services
    .filter((service: any) => service.spec?.selector)
    .map((service: any) => {
      const pods = cluster.pods.filter(
        (pod: any) => pod.metadata.namespace === service.metadata.namespace && matches(service.spec.selector, pod.metadata.labels) && pod.status?.podIP
      );
      return {
        apiVersion: "discovery.k8s.io/v1",
        kind: "EndpointSlice",
        addressType: "IPv4",
        metadata: {
          name: `${service.metadata.name}-${service.metadata.uid.slice(-5)}`,
          namespace: service.metadata.namespace,
          uid: uid(),
          creationTimestamp: service.metadata.creationTimestamp,
          labels: { "kubernetes.io/service-name": service.metadata.name, "endpointslice.kubernetes.io/managed-by": "endpointslice-controller.k8s.io" },
          ownerReferences: [{ apiVersion: "v1", kind: "Service", name: service.metadata.name, uid: service.metadata.uid, controller: true }],
        },
        endpoints: pods.map((pod: any) => {
          const ready = (pod.status.conditions ?? []).some((c: any) => c.type === "Ready" && c.status === "True");
          const terminating = !!pod.metadata.deletionTimestamp;
          return {
            addresses: [pod.status.podIP],
            conditions: { ready: ready && !terminating, serving: ready, terminating },
            nodeName: pod.spec.nodeName,
            targetRef: { kind: "Pod", name: pod.metadata.name, namespace: pod.metadata.namespace, uid: pod.metadata.uid },
          };
        }),
        ports: (service.spec.ports ?? []).map((p: any) => ({ name: p.name ?? "", port: typeof p.targetPort === "number" ? p.targetPort : p.port, protocol: p.protocol ?? "TCP" })),
      };
    });
}

/* ------------------------------------------------------- config -- */

const paymentsConfig = prod.configmaps.find((c: any) => c.metadata.name === "payments-config");
paymentsConfig.metadata.labels = { "app.kubernetes.io/name": "payments-api", "app.kubernetes.io/part-of": "acme" };
paymentsConfig.data = {
  "config.yaml": [
    "# Payments API settings",
    "server:",
    "  port: 8080",
    "  readTimeout: 15s",
    "database:",
    "  host: postgres.payments.svc.cluster.local",
    "  pool: 20",
    "features:",
    "  fastCheckout: true",
    "  refunds: false",
    "",
  ].join("\n"),
  "features.json": JSON.stringify({ fastCheckout: { enabled: true, rollout: 0.25 }, refunds: { enabled: false }, currencies: ["EUR", "USD", "GBP"] }),
  LOG_LEVEL: "info",
  "nginx.conf": "upstream payments {\n  server 127.0.0.1:8080;\n  keepalive 32;\n}\n",
};

/* ------------------------------------------------- quota & limits -- */

prod.resourcequotas = [
  {
    apiVersion: "v1",
    kind: "ResourceQuota",
    metadata: { name: "payments-quota", namespace: "payments", uid: uid(), creationTimestamp: ago(90 * DAY) },
    spec: { hard: { "requests.cpu": "8", "requests.memory": "16Gi", "limits.cpu": "16", "limits.memory": "32Gi", pods: "40", persistentvolumeclaims: "10", "services.loadbalancers": "1" } },
    status: {
      hard: { "requests.cpu": "8", "requests.memory": "16Gi", "limits.cpu": "16", "limits.memory": "32Gi", pods: "40", persistentvolumeclaims: "10", "services.loadbalancers": "1" },
      used: { "requests.cpu": "2650m", "requests.memory": "6348Mi", "limits.cpu": "11", "limits.memory": "29696Mi", pods: "12", persistentvolumeclaims: "2", "services.loadbalancers": "0" },
    },
  },
];
prod.limitranges = [
  {
    apiVersion: "v1",
    kind: "LimitRange",
    metadata: { name: "payments-defaults", namespace: "payments", uid: uid(), creationTimestamp: ago(90 * DAY) },
    spec: {
      limits: [
        { type: "Container", default: { cpu: "500m", memory: "512Mi" }, defaultRequest: { cpu: "100m", memory: "128Mi" }, max: { cpu: "2", memory: "4Gi" } },
        { type: "PersistentVolumeClaim", min: { storage: "1Gi" }, max: { storage: "100Gi" } },
      ],
    },
  },
];

/* ---------------------------------------------------------- storage -- */

prod.persistentvolumes.forEach((pv: any, i: number) => {
  pv.spec = {
    ...pv.spec,
    persistentVolumeReclaimPolicy: "Delete",
    volumeMode: "Filesystem",
    csi: { driver: "ebs.csi.aws.com", volumeHandle: `vol-0${(0x5c1e7a2b + i * 104729).toString(16)}9f3d` },
    nodeAffinity: { required: { nodeSelectorTerms: [{ matchExpressions: [{ key: "topology.kubernetes.io/zone", operator: "In", values: [`eu-west-1${"ab"[i % 2]}`] }] }] } },
  };
});
const gp3 = prod.storageclasses[0];
gp3.parameters = { type: "gp3", encrypted: "true", fsType: "ext4" };
gp3.allowVolumeExpansion = true;
prod.ingressclasses = [
  {
    apiVersion: "networking.k8s.io/v1",
    kind: "IngressClass",
    metadata: { name: "nginx", uid: uid(), creationTimestamp: ago(120 * DAY), annotations: { "ingressclass.kubernetes.io/is-default-class": "true" } },
    spec: { controller: "k8s.io/ingress-nginx" },
  },
];

/* ------------------------------------------------------------ events -- */

const event = (involved: any, type: string, reason: string, message: string, count: number, last: number, component: string, host?: string) => ({
  apiVersion: "v1",
  kind: "Event",
  metadata: { name: `${involved.metadata.name}.${uid().slice(-12)}`, namespace: involved.metadata.namespace ?? "default", uid: uid(), creationTimestamp: ago(last + count * 60) },
  involvedObject: { kind: involved.kind, name: involved.metadata.name, namespace: involved.metadata.namespace, uid: involved.metadata.uid, apiVersion: involved.apiVersion },
  type,
  reason,
  message,
  count,
  source: { component, ...(host ? { host } : {}) },
  firstTimestamp: ago(last + count * 60),
  lastTimestamp: ago(last),
});

const redisClaim = prod.persistentvolumeclaims.find((c: any) => c.metadata.name === "data-redis-0");
prod.events.push(
  event(diskNode, "Warning", "EvictionThresholdMet", "Attempting to reclaim ephemeral-storage", 4, 6 * MIN, "kubelet", diskNode.metadata.name),
  event(diskNode, "Warning", "FreeDiskSpaceFailed", "Failed to garbage collect required amount of images. Attempted to free 4.2GB, but only found 1.1GB eligible to free.", 7, 9 * MIN, "kubelet", diskNode.metadata.name),
  event(diskNode, "Normal", "NodeHasDiskPressure", `Node ${diskNode.metadata.name} status is now: NodeHasDiskPressure`, 1, 2 * HOUR, "kubelet", diskNode.metadata.name),
  event(paymentsHpa, "Normal", "SuccessfulRescale", "New size: 4; reason: cpu resource utilization (percentage of request) above target", 1, 3 * HOUR, "horizontal-pod-autoscaler"),
  event(webHpa, "Warning", "FailedRescale", "New size: 4; reason: cpu resource utilization (percentage of request) above target; capped at the maximum of 3", 12, 4 * MIN, "horizontal-pod-autoscaler"),
  event(backup, "Normal", "SuccessfulCreate", "Created job db-backup-28745160", 1, 2 * HOUR, "cronjob-controller"),
  event(backup, "Normal", "SawCompletedJob", "Saw completed job: db-backup-28745160, condition: Complete", 1, 2 * HOUR - 40, "cronjob-controller"),
  event(redisClaim, "Warning", "ProvisioningFailed", 'storageclass.storage.k8s.io "fast-ssd" not found', 31, 2 * MIN, "persistentvolume-controller")
);

/* ------------------------------------------------------------ routes -- */

if (!API_GROUPS.some((g) => g.name === "discovery.k8s.io")) {
  API_GROUPS.push({
    name: "discovery.k8s.io",
    version: "discovery.k8s.io/v1",
    resources: [{ name: "endpointslices", singularName: "endpointslice", namespaced: true, kind: "EndpointSlice", verbs: ["get", "list", "watch"] }],
  });
}

type Emit = (key: string, change: { added?: any[]; modified?: any[]; deleted?: any[] }, context: string) => void;

/* RFC 7386 merge patch. */
function mergePatch(target: any, patch: any): any {
  if (patch === null || typeof patch !== "object" || Array.isArray(patch)) return patch;
  const result = target && typeof target === "object" && !Array.isArray(target) ? { ...target } : {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete result[key];
    else result[key] = mergePatch(result[key], value);
  }
  return result;
}

/* Strategic merge patch, as far as the harness needs it: lists of named items merge by name. */
function strategicPatch(target: any, patch: any): any {
  if (Array.isArray(patch) && Array.isArray(target) && patch.every((item) => item?.name)) {
    const result = target.map((item) => {
      const change = patch.find((p) => p.name === item?.name);
      return change ? strategicPatch(item, change) : item;
    });
    return [...result, ...patch.filter((p) => !target.some((item) => item?.name === p.name))];
  }
  if (patch === null || typeof patch !== "object" || Array.isArray(patch)) return patch;
  const result = target && typeof target === "object" && !Array.isArray(target) ? { ...target } : {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete result[key];
    else result[key] = strategicPatch(result[key], value);
  }
  return result;
}

/* RFC 6902 JSON patch: add, replace, remove and test (what the panels send). */
function jsonPatch(target: any, ops: any[]): any {
  const doc = structuredClone(target);
  for (const op of ops) {
    const path = String(op.path).split("/").slice(1).map((s) => s.replace(/~1/g, "/").replace(/~0/g, "~"));
    const key = path.pop()!;
    let parent = doc;
    for (const segment of path) {
      if (parent?.[segment] === undefined) throw kubeError(422, `the server rejected our request due to an error in our request: path ${op.path} doesn't exist`, "Invalid");
      parent = parent[segment];
    }
    if (op.op === "test") {
      if (JSON.stringify(parent?.[key]) !== JSON.stringify(op.value)) {
        throw kubeError(422, `the server rejected our request due to an error in our request: testing value ${op.path} failed`, "Invalid");
      }
    } else if (op.op === "remove") {
      if (Array.isArray(parent)) parent.splice(Number(key), 1);
      else delete parent[key];
    } else {
      parent[key] = op.value;
    }
  }
  return doc;
}

let resourceVersion = 70_000;

export function createPanelsMocks(scenario: string, emit: Emit) {
  const listOf = (context: string, plural: string): any[] => (CLUSTERS[context]?.[plural] ?? []) as any[];

  registerKubeRoutes([
    {
      // The events of one object.
      method: "GET",
      path: /^\/api\/v1\/(?:namespaces\/([^/]+)\/)?events$/,
      handle: (request, match) => {
        const namespace = match[1] ? decodeURIComponent(match[1]) : undefined;
        const fields = Object.fromEntries(
          (request.query.get("fieldSelector") ?? "")
            .split(",")
            .filter(Boolean)
            .map((part) => part.split("=") as [string, string])
        );
        const items = listOf(request.context, "events").filter(
          (e) =>
            (!namespace || e.metadata?.namespace === namespace) &&
            (!fields["involvedObject.name"] || e.involvedObject?.name === fields["involvedObject.name"]) &&
            (!fields["involvedObject.kind"] || e.involvedObject?.kind === fields["involvedObject.kind"]) &&
            (!fields["involvedObject.uid"] || !e.involvedObject?.uid || e.involvedObject.uid === fields["involvedObject.uid"])
        );
        return { apiVersion: "v1", kind: "EventList", items };
      },
    },
    {
      // Lists (the native describe: a node's pods, a Service's EndpointSlices).
      method: "GET",
      path: /^\/(?:api\/v1|apis\/[^/]+\/[^/]+)\/(?:namespaces\/([^/]+)\/)?([a-z0-9]+)$/,
      handle: (request, match) => {
        const namespace = match[1] ? decodeURIComponent(match[1]) : undefined;
        const pairs = (selector: string | null) =>
          (selector ?? "").split(",").filter(Boolean).map((part) => part.split("=") as [string, string]);
        const fields = pairs(request.query.get("fieldSelector"));
        const labels = pairs(request.query.get("labelSelector"));
        const items = listOf(request.context, match[2]!).filter(
          (o) =>
            (!namespace || o.metadata?.namespace === namespace) &&
            fields.every(([key, value]) => (key === "spec.nodeName" ? o.spec?.nodeName === value : true)) &&
            labels.every(([key, value]) => o.metadata?.labels?.[key] === value)
        );
        return { kind: "List", apiVersion: "v1", items };
      },
    },
    {
      // Labels, annotations, taints: any built-in object.
      method: "PATCH",
      path: /^\/(?:api\/v1|apis\/[^/]+\/[^/]+)\/(?:namespaces\/([^/]+)\/)?([a-z0-9]+)\/([^/]+)$/,
      handle: (request, match) => {
        const [, namespace, plural, name] = match;
        const list = listOf(request.context, plural!);
        const index = list.findIndex(
          (o) => o.metadata?.name === decodeURIComponent(name!) && (!namespace || o.metadata?.namespace === decodeURIComponent(namespace))
        );
        if (index < 0) throw kubeError(404, `${plural} "${name}" not found`, "NotFound");
        if (scenario === "edit-forbidden") {
          throw kubeError(
            403,
            `${plural}.apps "${name}" is forbidden: User "maria@acme.dev" cannot patch resource "${plural}" in API group "apps" in the namespace "${namespace}"`,
            "Forbidden"
          );
        }
        const before = list[index];
        const type = String(request.contentType ?? "");
        const next = type.includes("json-patch")
          ? jsonPatch(before, request.body)
          : type.includes("strategic")
            ? strategicPatch(structuredClone(before), request.body)
            : mergePatch(structuredClone(before), request.body);
        next.metadata = { ...next.metadata, resourceVersion: String(++resourceVersion) };
        // A dry run answers with what would be stored, and stores nothing.
        if (request.query.get("dryRun") === "All") return next;
        list[index] = next;
        emit(plural!, { modified: [next] }, request.context);
        return next;
      },
    },
  ]);
}

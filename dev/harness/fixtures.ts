/*
 * Deterministic fake cluster data for the visual QA harness. Two contexts,
 * a handful of namespaces, ~40 pods in mixed states, deployments,
 * replicasets, services, nodes, events, helm releases and metrics.
 *
 * Dev-only: never imported by the app itself.
 */

export const HOME = "/home/demo";
export const KUBECONFIG = `${HOME}/.kube/config`;

export const CONTEXTS = [
  { name: "prod-eu-west-1", namespace: "payments" },
  { name: "staging-us-east-2", namespace: "default" },
];

export const NAMESPACES: Record<string, string[]> = {
  "prod-eu-west-1": [
    "default",
    "kube-system",
    "payments",
    "checkout",
    "monitoring",
    "ingress-nginx",
    "cert-manager",
    "platform",
  ],
  "staging-us-east-2": ["default", "kube-system", "payments", "checkout"],
};

const NOW = Date.now();
const ago = (seconds: number) => new Date(NOW - seconds * 1000).toISOString();
const MIN = 60;
const HOUR = 3600;
const DAY = 86400;

let seed = 42;
const rand = () => {
  seed = (seed * 16807) % 2147483647;
  return (seed - 1) / 2147483646;
};
const hash = (len: number) =>
  Array.from({ length: len }, () =>
    "bcdfghjklmnpqrstvwxz2456789"[Math.floor(rand() * 27)]
  ).join("");
let uidCounter = 0;
const uid = () =>
  `${(++uidCounter).toString(16).padStart(8, "0")}-4a1b-4c2d-9e3f-${hash(12)}`;

const NODE_NAMES = [
  "ip-10-0-12-34.eu-west-1.compute.internal",
  "ip-10-0-45-118.eu-west-1.compute.internal",
  "ip-10-0-78-201.eu-west-1.compute.internal",
  "ip-10-0-91-7.eu-west-1.compute.internal",
];

type PodState =
  | "running"
  | "crashloop"
  | "pending"
  | "terminating"
  | "imagepull"
  | "creating"
  | "init"
  | "completed"
  | "oom";

interface WorkloadSpec {
  name: string;
  namespace: string;
  image: string;
  replicas: number;
  states?: PodState[];
  port?: number;
  cpu: [string, string];
  memory: [string, string];
  age: number;
}

const WORKLOADS: WorkloadSpec[] = [
  { name: "payments-api", namespace: "payments", image: "ghcr.io/acme/payments-api:v2.14.3", replicas: 4, port: 8080, cpu: ["250m", "1"], memory: ["256Mi", "512Mi"], age: 12 * DAY },
  { name: "payments-worker", namespace: "payments", image: "ghcr.io/acme/payments-worker:v2.14.3", replicas: 3, states: ["running", "running", "oom"], cpu: ["100m", "500m"], memory: ["128Mi", "256Mi"], age: 12 * DAY },
  { name: "ledger", namespace: "payments", image: "ghcr.io/acme/ledger:v1.8.0", replicas: 2, port: 9000, cpu: ["200m", "1"], memory: ["512Mi", "1Gi"], age: 41 * DAY },
  { name: "checkout-api", namespace: "checkout", image: "ghcr.io/acme/checkout-api:v3.2.0", replicas: 3, states: ["running", "crashloop", "running"], port: 8080, cpu: ["250m", "1"], memory: ["256Mi", "512Mi"], age: 3 * DAY },
  { name: "checkout-web", namespace: "checkout", image: "ghcr.io/acme/checkout-web:v3.2.0", replicas: 3, port: 3000, cpu: ["100m", "500m"], memory: ["128Mi", "256Mi"], age: 3 * DAY },
  { name: "image-resizer", namespace: "checkout", image: "ghcr.io/acme/image-resizer:v0.9.1-rc", replicas: 2, states: ["imagepull", "creating"], cpu: ["100m", "500m"], memory: ["128Mi", "512Mi"], age: 25 * MIN },
  { name: "cart-service", namespace: "checkout", image: "ghcr.io/acme/cart:v1.4.2", replicas: 2, states: ["running", "terminating"], port: 8080, cpu: ["100m", "500m"], memory: ["128Mi", "256Mi"], age: 6 * DAY },
  { name: "prometheus", namespace: "monitoring", image: "quay.io/prometheus/prometheus:v2.53.1", replicas: 1, port: 9090, cpu: ["500m", "2"], memory: ["2Gi", "4Gi"], age: 88 * DAY },
  { name: "grafana", namespace: "monitoring", image: "grafana/grafana:11.1.0", replicas: 1, port: 3000, cpu: ["100m", "500m"], memory: ["256Mi", "512Mi"], age: 88 * DAY },
  { name: "alertmanager", namespace: "monitoring", image: "quay.io/prometheus/alertmanager:v0.27.0", replicas: 2, states: ["running", "pending"], port: 9093, cpu: ["50m", "200m"], memory: ["64Mi", "128Mi"], age: 88 * DAY },
  { name: "ingress-nginx-controller", namespace: "ingress-nginx", image: "registry.k8s.io/ingress-nginx/controller:v1.11.1", replicas: 2, port: 443, cpu: ["100m", "1"], memory: ["90Mi", "512Mi"], age: 120 * DAY },
  { name: "cert-manager", namespace: "cert-manager", image: "quay.io/jetstack/cert-manager-controller:v1.15.1", replicas: 1, cpu: ["50m", "200m"], memory: ["64Mi", "256Mi"], age: 120 * DAY },
  { name: "cert-manager-webhook", namespace: "cert-manager", image: "quay.io/jetstack/cert-manager-webhook:v1.15.1", replicas: 1, port: 10250, cpu: ["50m", "200m"], memory: ["32Mi", "128Mi"], age: 120 * DAY },
  { name: "coredns", namespace: "kube-system", image: "registry.k8s.io/coredns/coredns:v1.11.1", replicas: 2, port: 53, cpu: ["100m", "200m"], memory: ["70Mi", "170Mi"], age: 210 * DAY },
  { name: "metrics-server", namespace: "kube-system", image: "registry.k8s.io/metrics-server/metrics-server:v0.7.1", replicas: 1, port: 4443, cpu: ["100m", "200m"], memory: ["200Mi", "400Mi"], age: 210 * DAY },
  { name: "feature-flags", namespace: "platform", image: "ghcr.io/acme/feature-flags:v0.22.0", replicas: 2, states: ["running", "init"], port: 8080, cpu: ["50m", "250m"], memory: ["64Mi", "128Mi"], age: 9 * HOUR },
  { name: "nginx", namespace: "default", image: "nginx:1.27-alpine", replicas: 2, port: 80, cpu: ["50m", "100m"], memory: ["32Mi", "64Mi"], age: 30 * DAY },
];

const labelsFor = (app: string) => ({
  "app.kubernetes.io/name": app,
  "app.kubernetes.io/part-of": "acme",
  "app.kubernetes.io/managed-by": "Helm",
});

function containerStatus(
  name: string,
  image: string,
  state: PodState,
  started: string
) {
  const base = {
    name,
    image,
    imageID: `${image.split(":")[0]}@sha256:${hash(16)}`,
    containerID: `containerd://${hash(32)}`,
  };
  switch (state) {
    case "running":
      return { ...base, ready: true, started: true, restartCount: rand() > 0.8 ? 1 : 0, state: { running: { startedAt: started } } };
    case "crashloop":
      return {
        ...base,
        ready: false,
        started: false,
        restartCount: 14,
        state: { waiting: { reason: "CrashLoopBackOff", message: "back-off 5m0s restarting failed container" } },
        lastState: { terminated: { exitCode: 1, reason: "Error", startedAt: ago(6 * MIN), finishedAt: ago(5 * MIN) } },
      };
    case "imagepull":
      return { ...base, ready: false, started: false, restartCount: 0, state: { waiting: { reason: "ImagePullBackOff", message: `Back-off pulling image "${image}"` } } };
    case "creating":
      return { ...base, ready: false, started: false, restartCount: 0, state: { waiting: { reason: "ContainerCreating" } } };
    case "oom":
      return {
        ...base,
        ready: false,
        started: false,
        restartCount: 3,
        state: { terminated: { exitCode: 137, reason: "OOMKilled", startedAt: ago(4 * MIN), finishedAt: ago(2 * MIN) } },
      };
    case "completed":
      return { ...base, ready: false, started: false, restartCount: 0, state: { terminated: { exitCode: 0, reason: "Completed", startedAt: ago(2 * HOUR), finishedAt: ago(2 * HOUR - 40) } } };
    case "init":
      return { ...base, ready: false, started: false, restartCount: 0, state: { waiting: { reason: "PodInitializing" } } };
    default:
      return { ...base, ready: true, started: true, restartCount: 0, state: { running: { startedAt: started } } };
  }
}

function makePod(
  w: WorkloadSpec,
  rs: { name: string; uid: string },
  state: PodState,
  index: number
) {
  const name = `${rs.name}-${hash(5)}`;
  const created = ago(Math.min(w.age, index === 0 ? w.age : w.age / (index + 1)));
  const node = state === "pending" ? undefined : NODE_NAMES[(index + w.name.length) % NODE_NAMES.length];
  const ip = state === "pending" ? undefined : `10.42.${(w.name.length * 7) % 255}.${10 + index * 13}`;
  const phase =
    state === "pending" ? "Pending" : state === "completed" ? "Succeeded" : state === "creating" || state === "init" || state === "imagepull" ? "Pending" : "Running";

  const container = {
    name: w.name.replace(/-controller$/, ""),
    image: w.image,
    ports: w.port ? [{ name: "http", containerPort: w.port, protocol: "TCP" }] : [],
    resources: {
      requests: { cpu: w.cpu[0], memory: w.memory[0] },
      limits: { cpu: w.cpu[1], memory: w.memory[1] },
    },
    env: [
      { name: "LOG_LEVEL", value: "info" },
      { name: "OTEL_EXPORTER_OTLP_ENDPOINT", value: "http://otel-collector.monitoring:4317" },
    ],
    imagePullPolicy: "IfNotPresent",
  };
  const sidecar = w.namespace === "payments" && w.name === "payments-api"
    ? { name: "envoy", image: "envoyproxy/envoy:v1.30.2", ports: [{ name: "admin", containerPort: 9901, protocol: "TCP" }], resources: { requests: { cpu: "50m", memory: "64Mi" }, limits: { cpu: "200m", memory: "128Mi" } } }
    : null;

  const containers = sidecar ? [container, sidecar] : [container];
  const pod: any = {
    apiVersion: "v1",
    kind: "Pod",
    metadata: {
      name,
      namespace: w.namespace,
      uid: uid(),
      creationTimestamp: created,
      labels: { ...labelsFor(w.name), "pod-template-hash": rs.name.split("-").pop() },
      annotations: {
        "kubectl.kubernetes.io/restartedAt": ago(w.age),
        "prometheus.io/scrape": "true",
      },
      ownerReferences: [
        { apiVersion: "apps/v1", kind: "ReplicaSet", name: rs.name, uid: rs.uid, controller: true },
      ],
      ...(state === "terminating" ? { deletionTimestamp: ago(20), deletionGracePeriodSeconds: 30 } : {}),
    },
    spec: {
      containers,
      ...(state === "init"
        ? { initContainers: [{ name: "migrate", image: w.image.replace(/:.*/, ":migrate") }] }
        : {}),
      nodeName: node,
      serviceAccountName: w.name,
      restartPolicy: "Always",
    },
    status: {
      phase,
      podIP: ip,
      hostIP: node ? `10.0.${(index * 33) % 255}.${(index * 17) % 255}` : undefined,
      qosClass: "Burstable",
      startTime: created,
      conditions: [
        { type: "PodScheduled", status: state === "pending" ? "False" : "True", lastTransitionTime: created, ...(state === "pending" ? { reason: "Unschedulable", message: "0/4 nodes are available: 4 Insufficient memory." } : {}) },
        { type: "Initialized", status: state === "init" ? "False" : "True", lastTransitionTime: created },
        { type: "ContainersReady", status: ["running", "terminating"].includes(state) ? "True" : "False", lastTransitionTime: created },
        { type: "Ready", status: ["running", "terminating"].includes(state) ? "True" : "False", lastTransitionTime: created },
      ],
    },
  };

  if (state !== "pending") {
    pod.status.containerStatuses = containers.map((c, i) =>
      containerStatus(c.name, c.image, i === 0 ? state : "running", created)
    );
  }
  if (state === "init") {
    pod.status.initContainerStatuses = [
      { name: "migrate", image: w.image.replace(/:.*/, ":migrate"), ready: false, restartCount: 0, state: { running: { startedAt: ago(40) } } },
    ];
  }
  return pod;
}

export interface Cluster {
  pods: any[];
  deployments: any[];
  replicasets: any[];
  services: any[];
  nodes: any[];
  events: any[];
  configmaps: any[];
  secrets: any[];
  namespaces: any[];
  jobs: any[];
  ingresses: any[];
  podmetrics: any[];
  helmReleases: any[];
  /* Resource graph kinds (statefulsets, cronjobs, hpas, ...), keyed by plural resource name. */
  [resource: string]: any[];
}

function buildCluster(context: string, scale = 1): Cluster {
  const pods: any[] = [];
  const deployments: any[] = [];
  const replicasets: any[] = [];
  const services: any[] = [];
  const podmetrics: any[] = [];

  const workloads = scale === 1 ? WORKLOADS : WORKLOADS.filter((w) => NAMESPACES[context].includes(w.namespace)).slice(0, 6);

  for (const w of workloads) {
    const depUid = uid();
    const rsHash = hash(9).slice(0, 9);
    const rs = { name: `${w.name}-${rsHash}`, uid: uid() };
    const states = w.states ?? Array(w.replicas).fill("running");
    const replicas = Math.max(1, Math.round(w.replicas * scale));
    const podsForW = states.slice(0, replicas).map((s, i) => makePod(w, rs, s as PodState, i));
    pods.push(...podsForW);
    const ready = podsForW.filter((p) => p.status.containerStatuses?.every((c: any) => c.ready)).length;

    deployments.push({
      apiVersion: "apps/v1",
      kind: "Deployment",
      metadata: {
        name: w.name,
        namespace: w.namespace,
        uid: depUid,
        generation: 7,
        creationTimestamp: ago(w.age),
        labels: labelsFor(w.name),
        annotations: { "deployment.kubernetes.io/revision": "7", "meta.helm.sh/release-name": w.name },
      },
      spec: {
        replicas,
        selector: { matchLabels: { "app.kubernetes.io/name": w.name } },
        strategy: { type: "RollingUpdate", rollingUpdate: { maxSurge: "25%", maxUnavailable: "25%" } },
        template: {
          metadata: { labels: labelsFor(w.name) },
          spec: { containers: podsForW[0].spec.containers },
        },
      },
      status: {
        observedGeneration: 7,
        replicas,
        updatedReplicas: replicas,
        readyReplicas: ready,
        availableReplicas: ready,
        conditions: [
          { type: "Available", status: ready === replicas ? "True" : "False", reason: ready === replicas ? "MinimumReplicasAvailable" : "MinimumReplicasUnavailable", lastTransitionTime: ago(w.age / 2), lastUpdateTime: ago(w.age / 2), message: ready === replicas ? "Deployment has minimum availability." : "Deployment does not have minimum availability." },
          { type: "Progressing", status: "True", reason: "NewReplicaSetAvailable", lastTransitionTime: ago(w.age), lastUpdateTime: ago(w.age / 3), message: `ReplicaSet "${rs.name}" has successfully progressed.` },
        ],
      },
    });

    replicasets.push({
      apiVersion: "apps/v1",
      kind: "ReplicaSet",
      metadata: {
        name: rs.name,
        namespace: w.namespace,
        uid: rs.uid,
        creationTimestamp: ago(w.age / 2),
        labels: labelsFor(w.name),
        ownerReferences: [{ apiVersion: "apps/v1", kind: "Deployment", name: w.name, uid: depUid, controller: true }],
      },
      spec: { replicas },
      status: { replicas, readyReplicas: ready, availableReplicas: ready },
    });

    if (w.port) {
      services.push({
        apiVersion: "v1",
        kind: "Service",
        metadata: { name: w.name, namespace: w.namespace, uid: uid(), creationTimestamp: ago(w.age), labels: labelsFor(w.name) },
        spec: {
          type: w.name.startsWith("ingress-nginx") ? "LoadBalancer" : "ClusterIP",
          clusterIP: `172.20.${(w.name.length * 11) % 255}.${(w.port % 200) + 10}`,
          ports: [{ name: "http", port: w.port === 8080 ? 80 : w.port, targetPort: w.port, protocol: "TCP" }],
          selector: { "app.kubernetes.io/name": w.name },
        },
        status: w.name.startsWith("ingress-nginx")
          ? { loadBalancer: { ingress: [{ hostname: "a1b2c3d4e5-123456789.eu-west-1.elb.amazonaws.com" }] } }
          : {},
      });
    }

    for (const pod of podsForW) {
      if (pod.status.phase !== "Running" || pod.metadata.deletionTimestamp) continue;
      podmetrics.push({
        apiVersion: "metrics.k8s.io/v1beta1",
        kind: "PodMetrics",
        metadata: { name: pod.metadata.name, namespace: pod.metadata.namespace, creationTimestamp: ago(0) },
        timestamp: ago(10),
        window: "15s",
        containers: pod.spec.containers.map((c: any) => {
          const cpuLimit = c.resources.limits.cpu.endsWith("m") ? parseInt(c.resources.limits.cpu) : parseInt(c.resources.limits.cpu) * 1000;
          const memLimitMi = c.resources.limits.memory.endsWith("Gi") ? parseInt(c.resources.limits.memory) * 1024 : parseInt(c.resources.limits.memory);
          const cpu = Math.round(cpuLimit * (0.08 + rand() * 0.75));
          const mem = Math.round(memLimitMi * (0.25 + rand() * 0.7));
          return { name: c.name, usage: { cpu: `${cpu * 1000000}n`, memory: `${mem * 1024}Ki` } };
        }),
      });
    }
  }

  // A completed job pod.
  const jobUid = uid();
  const jobs = [
    {
      apiVersion: "batch/v1",
      kind: "Job",
      metadata: { name: "db-backup-28745160", namespace: "payments", uid: jobUid, creationTimestamp: ago(2 * HOUR) },
      spec: { completions: 1, parallelism: 1 },
      status: { succeeded: 1, startTime: ago(2 * HOUR), completionTime: ago(2 * HOUR - 40) },
    },
  ];
  if (scale === 1) {
    pods.push({
      ...makePod(
        { name: "db-backup-28745160", namespace: "payments", image: "ghcr.io/acme/pg-backup:v1.2.0", replicas: 1, cpu: ["100m", "500m"], memory: ["128Mi", "256Mi"], age: 2 * HOUR },
        { name: "db-backup-28745160", uid: jobUid },
        "completed",
        0
      ),
    });
    const last = pods[pods.length - 1];
    last.metadata.ownerReferences = [{ apiVersion: "batch/v1", kind: "Job", name: "db-backup-28745160", uid: jobUid, controller: true }];
    last.spec.restartPolicy = "Never";
  }

  const nodes = NODE_NAMES.slice(0, scale === 1 ? 4 : 2).map((name, i) => ({
    apiVersion: "v1",
    kind: "Node",
    metadata: {
      name,
      uid: uid(),
      creationTimestamp: ago((210 - i * 40) * DAY),
      labels: {
        "kubernetes.io/hostname": name,
        "node.kubernetes.io/instance-type": i === 0 ? "m6i.xlarge" : "m6i.2xlarge",
        "topology.kubernetes.io/zone": `eu-west-1${"abc"[i % 3]}`,
        ...(i === 0 ? { "node-role.kubernetes.io/control-plane": "" } : { "node-role.kubernetes.io/worker": "" }),
      },
    },
    spec: {
      ...(i === 3 ? { unschedulable: true, taints: [{ key: "node.kubernetes.io/unschedulable", effect: "NoSchedule" }] } : {}),
      ...(i === 0 ? { taints: [{ key: "node-role.kubernetes.io/control-plane", effect: "NoSchedule" }] } : {}),
    },
    status: {
      nodeInfo: { kubeletVersion: "v1.30.2-eks-1552ad0", osImage: "Amazon Linux 2023", containerRuntimeVersion: "containerd://1.7.11", architecture: "amd64" },
      capacity: { cpu: "8", memory: "32386524Ki", pods: "110" },
      allocatable: { cpu: "7910m", memory: "31369692Ki", pods: "110" },
      addresses: [{ type: "InternalIP", address: `10.0.${12 + i * 33}.${34 + i}` }],
      conditions: [
        { type: "MemoryPressure", status: "False", reason: "KubeletHasSufficientMemory", lastTransitionTime: ago(20 * DAY) },
        { type: "DiskPressure", status: i === 2 ? "True" : "False", reason: i === 2 ? "KubeletHasDiskPressure" : "KubeletHasNoDiskPressure", lastTransitionTime: ago(2 * HOUR) },
        { type: "Ready", status: "True", reason: "KubeletReady", message: "kubelet is posting ready status", lastTransitionTime: ago(20 * DAY) },
      ],
    },
  }));

  const firstOf = (state: string) => pods.find((p) => {
    const cs = p.status.containerStatuses?.[0];
    return cs?.state?.waiting?.reason === state || cs?.state?.terminated?.reason === state;
  });

  const eventFor = (pod: any, type: string, reason: string, message: string, count: number, last: number, component = "kubelet") =>
    pod && {
      apiVersion: "v1",
      kind: "Event",
      metadata: { name: `${pod.metadata.name}.${hash(16)}`, namespace: pod.metadata.namespace, uid: uid(), creationTimestamp: ago(last + count * 30) },
      involvedObject: { kind: "Pod", name: pod.metadata.name, namespace: pod.metadata.namespace, uid: pod.metadata.uid, apiVersion: "v1" },
      type,
      reason,
      message,
      count,
      source: { component, host: pod.spec.nodeName },
      firstTimestamp: ago(last + count * 30),
      lastTimestamp: ago(last),
    };

  const pending = pods.find((p) => p.status.phase === "Pending" && !p.status.containerStatuses);
  const running = pods.filter((p) => p.status.phase === "Running");
  const events = [
    eventFor(firstOf("CrashLoopBackOff"), "Warning", "BackOff", "Back-off restarting failed container checkout-api in pod", 61, 40),
    eventFor(firstOf("ImagePullBackOff"), "Warning", "Failed", 'Failed to pull image "ghcr.io/acme/image-resizer:v0.9.1-rc": rpc error: code = NotFound desc = failed to resolve reference', 9, 70),
    eventFor(pending, "Warning", "FailedScheduling", "0/4 nodes are available: 4 Insufficient memory. preemption: 0/4 nodes are available: 4 No preemption victims found for incoming pod.", 23, 15, "default-scheduler"),
    eventFor(firstOf("OOMKilled"), "Warning", "OOMKilling", "Memory cgroup out of memory: Killed process 4211 (payments-worker)", 3, 120),
    eventFor(running[0], "Normal", "Pulled", 'Container image "ghcr.io/acme/payments-api:v2.14.3" already present on machine', 1, 3 * HOUR),
    eventFor(running[1], "Normal", "Started", "Started container payments-api", 1, 3 * HOUR),
    eventFor(running[2], "Normal", "Scheduled", `Successfully assigned payments/${running[2]?.metadata.name} to ${running[2]?.spec.nodeName}`, 1, 5 * HOUR, "default-scheduler"),
    eventFor(running[5], "Normal", "Killing", "Stopping container cart", 1, 20),
    eventFor(running[7], "Normal", "Created", "Created container checkout-web", 1, 2 * DAY),
  ].filter(Boolean);

  const namespaces = NAMESPACES[context].map((name, i) => ({
    apiVersion: "v1",
    kind: "Namespace",
    metadata: { name, uid: uid(), creationTimestamp: ago((200 - i * 10) * DAY), labels: { "kubernetes.io/metadata.name": name } },
    status: { phase: "Active" },
  }));

  const configmaps = ["payments-config", "checkout-flags", "grafana-dashboards", "coredns", "kube-root-ca.crt"].map((name, i) => ({
    apiVersion: "v1",
    kind: "ConfigMap",
    metadata: { name, namespace: ["payments", "checkout", "monitoring", "kube-system", "default"][i], uid: uid(), creationTimestamp: ago((i + 1) * 9 * DAY) },
    data: { "config.yaml": "server:\n  port: 8080\nfeatures:\n  fastCheckout: true\n" },
  }));

  const secrets = ["payments-db", "stripe-api-key", "grafana-admin", "tls-acme-dev"].map((name, i) => ({
    apiVersion: "v1",
    kind: "Secret",
    type: i === 3 ? "kubernetes.io/tls" : "Opaque",
    metadata: { name, namespace: ["payments", "payments", "monitoring", "ingress-nginx"][i], uid: uid(), creationTimestamp: ago((i + 2) * 7 * DAY) },
    data: { username: btoa("payments"), password: btoa("s3cr3t-p4ssw0rd") },
  }));

  const ingresses = [
    {
      apiVersion: "networking.k8s.io/v1",
      kind: "Ingress",
      metadata: { name: "checkout", namespace: "checkout", uid: uid(), creationTimestamp: ago(30 * DAY) },
      spec: { ingressClassName: "nginx", rules: [{ host: "checkout.acme.dev" }], tls: [{ hosts: ["checkout.acme.dev"], secretName: "tls-acme-dev" }] },
      status: { loadBalancer: { ingress: [{ hostname: "a1b2c3d4e5-123456789.eu-west-1.elb.amazonaws.com" }] } },
    },
  ];

  const helmReleases = [
    { name: "payments-api", namespace: "payments", revision: "42", updated: ago(2 * HOUR).replace("T", " ").replace("Z", " +0000 UTC"), status: "deployed", chart: "payments-api-2.14.3", app_version: "2.14.3" },
    { name: "checkout", namespace: "checkout", revision: "17", updated: ago(3 * DAY).replace("T", " ").replace("Z", " +0000 UTC"), status: "failed", chart: "checkout-3.2.0", app_version: "3.2.0" },
    { name: "kube-prometheus-stack", namespace: "monitoring", revision: "9", updated: ago(40 * DAY).replace("T", " ").replace("Z", " +0000 UTC"), status: "deployed", chart: "kube-prometheus-stack-61.3.2", app_version: "v0.75.2" },
    { name: "ingress-nginx", namespace: "ingress-nginx", revision: "6", updated: ago(88 * DAY).replace("T", " ").replace("Z", " +0000 UTC"), status: "deployed", chart: "ingress-nginx-4.11.1", app_version: "1.11.1" },
    { name: "cert-manager", namespace: "cert-manager", revision: "3", updated: ago(120 * DAY).replace("T", " ").replace("Z", " +0000 UTC"), status: "deployed", chart: "cert-manager-v1.15.1", app_version: "v1.15.1" },
    { name: "feature-flags", namespace: "platform", revision: "2", updated: ago(9 * MIN).replace("T", " ").replace("Z", " +0000 UTC"), status: "pending-upgrade", chart: "feature-flags-0.22.0", app_version: "0.22.0" },
  ];

  const cluster: Cluster = { pods, deployments, replicasets, services, nodes, events, configmaps, secrets, namespaces, jobs, ingresses, podmetrics, helmReleases };
  addTopology(cluster, workloads, scale === 1);
  return cluster;
}

/* ------------------------------------------------------ resource graph -- */

/*
 * Topology for the resource graph, added after the base data (with its own
 * random sequence) so the existing pod names and uids stay stable: config
 * and secret references (incl. a dangling one), service accounts,
 * ingresses, a service without ready endpoints, a StatefulSet with PVCs, a
 * DaemonSet, CronJobs (one failing), HPAs, PDBs, NetworkPolicies and
 * Gateway API routes.
 */
const DEPS: Record<string, { envFrom?: string[]; secretEnv?: string[]; cmVolumes?: string[] }> = {
  "payments-api": { envFrom: ["payments-config"], secretEnv: ["payments-db", "stripe-api-key"] },
  "payments-worker": { envFrom: ["payments-config"], secretEnv: ["payments-db"] },
  ledger: { secretEnv: ["payments-db", "ledger-signing-key"] },
  "checkout-api": { envFrom: ["checkout-flags"] },
  "checkout-web": { envFrom: ["checkout-flags"] },
  grafana: { cmVolumes: ["grafana-dashboards"], secretEnv: ["grafana-admin"] },
  coredns: { cmVolumes: ["coredns"] },
};

function withDeps(spec: any, name: string) {
  const deps = DEPS[name] || {};
  const containers = spec.containers.map((c: any, i: number) =>
    i > 0
      ? c
      : {
          ...c,
          envFrom: (deps.envFrom || []).map((cm) => ({ configMapRef: { name: cm } })),
          env: [
            ...(c.env || []),
            ...(deps.secretEnv || []).map((secret) => ({
              name: secret.toUpperCase().replace(/-/g, "_"),
              valueFrom: { secretKeyRef: { name: secret, key: "value" } },
            })),
          ],
        }
  );
  const volumes = [
    ...(deps.cmVolumes || []).map((cm) => ({ name: cm, configMap: { name: cm } })),
    { name: "kube-api-access", projected: { sources: [{ serviceAccountToken: { path: "token" } }, { configMap: { name: "kube-root-ca.crt" } }] } },
  ];
  return { ...spec, serviceAccountName: name, containers, volumes };
}

let gseed = 7;
const grand = () => {
  gseed = (gseed * 48271) % 2147483647;
  return (gseed - 1) / 2147483646;
};
let guidCounter = 0;
const guid = () =>
  `${(0x80000000 + ++guidCounter).toString(16)}-5b2c-4d3e-8f40-${Math.floor(grand() * 1e12).toString(16).padStart(12, "0")}`;
const ghash = (len: number) =>
  Array.from({ length: len }, () => "bcdfghjklmnpqrstvwxz2456789"[Math.floor(grand() * 27)]).join("");

const ownerRef = (kind: string, obj: any, apiVersion = "apps/v1") => ({
  apiVersion,
  kind,
  name: obj.metadata.name,
  uid: obj.metadata.uid,
  controller: true,
  blockOwnerDeletion: true,
});

function graphPod(
  name: string,
  namespace: string,
  labels: Record<string, string>,
  owner: any,
  spec: any,
  opts: { state?: PodState | "failed"; node?: string; age?: number } = {}
) {
  const state = opts.state || "running";
  const created = ago(opts.age ?? 5 * DAY);
  const ready = state === "running";
  const phase =
    state === "completed"
      ? "Succeeded"
      : state === "failed"
        ? "Failed"
        : ["pending", "creating", "imagepull", "init"].includes(state)
          ? "Pending"
          : "Running";
  return {
    apiVersion: "v1",
    kind: "Pod",
    metadata: { name, namespace, uid: guid(), creationTimestamp: created, labels, ownerReferences: owner ? [owner] : undefined },
    spec: { ...spec, nodeName: state === "pending" ? undefined : opts.node || NODE_NAMES[Math.floor(grand() * NODE_NAMES.length)] },
    status: {
      phase,
      podIP: `10.42.${Math.floor(grand() * 255)}.${Math.floor(grand() * 255)}`,
      startTime: created,
      conditions: [
        { type: "PodScheduled", status: state === "pending" ? "False" : "True", lastTransitionTime: created },
        { type: "Ready", status: ready ? "True" : "False", lastTransitionTime: created },
      ],
      containerStatuses:
        state === "pending"
          ? undefined
          : spec.containers.map((c: any) =>
              state === "failed"
                ? { name: c.name, image: c.image, ready: false, restartCount: 0, state: { terminated: { exitCode: 1, reason: "Error", startedAt: created, finishedAt: created } } }
                : containerStatus(c.name, c.image, state as PodState, created)
            ),
    },
  };
}

const graphMeta = (name: string, namespace: string | undefined, extra: any = {}) => ({
  name,
  ...(namespace ? { namespace } : {}),
  uid: guid(),
  creationTimestamp: ago(20 * DAY),
  ...extra,
});

function addTopology(cluster: Cluster, workloads: WorkloadSpec[], full: boolean) {
  const add = (resource: string, ...items: any[]) => {
    cluster[resource] = [...(cluster[resource] || []), ...items];
  };
  const meta = graphMeta;

  /* Pod specs reference config, secrets and their service account. */
  for (const dep of cluster.deployments) {
    const name = dep.metadata.name;
    dep.spec.template.spec = withDeps(dep.spec.template.spec, name);
    for (const pod of cluster.pods) {
      if (pod.metadata.labels?.["app.kubernetes.io/name"] === name && pod.metadata.ownerReferences?.[0]?.kind === "ReplicaSet") {
        pod.spec = { ...withDeps(pod.spec, name), nodeName: pod.spec.nodeName };
      }
    }
  }
  const namespaces = [...new Set(workloads.map((w) => w.namespace))];
  add("serviceaccounts", ...workloads.map((w) => ({ apiVersion: "v1", kind: "ServiceAccount", metadata: meta(w.name, w.namespace, { labels: labelsFor(w.name) }) })));
  add("serviceaccounts", ...namespaces.map((ns) => ({ apiVersion: "v1", kind: "ServiceAccount", metadata: meta("default", ns) })));
  add("configmaps", ...namespaces.map((ns) => ({ apiVersion: "v1", kind: "ConfigMap", metadata: meta("kube-root-ca.crt", ns), data: { "ca.crt": "-----BEGIN CERTIFICATE-----" } })));

  if (!full) return;

  /* Old ReplicaSets (rollout history) for payments-api. */
  const paymentsApi = cluster.deployments.find((d) => d.metadata.name === "payments-api");
  for (const [i, revision] of [5, 6].entries()) {
    add("replicasets", {
      apiVersion: "apps/v1",
      kind: "ReplicaSet",
      metadata: meta(`payments-api-${ghash(9)}`, "payments", {
        creationTimestamp: ago((30 - i * 8) * DAY),
        labels: labelsFor("payments-api"),
        annotations: { "deployment.kubernetes.io/revision": String(revision) },
        ownerReferences: [ownerRef("Deployment", paymentsApi)],
      }),
      spec: { replicas: 0 },
      status: { replicas: 0 },
    });
  }

  /* Secrets the apps use (ledger-signing-key is deliberately missing). */
  add(
    "secrets",
    { apiVersion: "v1", kind: "Secret", type: "kubernetes.io/tls", metadata: meta("checkout-tls", "checkout"), data: { "tls.crt": "", "tls.key": "" } },
    { apiVersion: "v1", kind: "Secret", type: "kubernetes.io/tls", metadata: meta("api-acme-dev-tls", "payments"), data: { "tls.crt": "", "tls.key": "" } },
    { apiVersion: "v1", kind: "Secret", type: "Opaque", metadata: meta("postgres-credentials", "payments"), data: { password: btoa("pw") } }
  );

  /* image-resizer gets a Service: none of its pods is ready. */
  add("services", {
    apiVersion: "v1",
    kind: "Service",
    metadata: meta("image-resizer", "checkout", { labels: labelsFor("image-resizer") }),
    spec: { type: "ClusterIP", clusterIP: "172.20.88.14", ports: [{ name: "http", port: 80, targetPort: 8080, protocol: "TCP" }], selector: { "app.kubernetes.io/name": "image-resizer" } },
    status: {},
  });

  /* Ingresses: checkout fans out to three services, legacy-site points nowhere. */
  const path = (p: string, service: string, port = 80) => ({ path: p, pathType: "Prefix", backend: { service: { name: service, port: { number: port } } } });
  cluster.ingresses[0].metadata.labels = { "app.kubernetes.io/instance": "checkout" };
  cluster.ingresses[0].spec = {
    ingressClassName: "nginx",
    rules: [{ host: "checkout.acme.dev", http: { paths: [path("/", "checkout-web", 3000), path("/api", "checkout-api"), path("/images", "image-resizer")] } }],
    tls: [{ hosts: ["checkout.acme.dev"], secretName: "checkout-tls" }],
  };
  add(
    "ingresses",
    {
      apiVersion: "networking.k8s.io/v1",
      kind: "Ingress",
      metadata: meta("payments-api", "payments", { labels: labelsFor("payments-api") }),
      spec: { ingressClassName: "nginx", rules: [{ host: "api.acme.dev", http: { paths: [path("/v1/payments", "payments-api"), path("/v1/ledger", "ledger", 9000)] } }], tls: [{ hosts: ["api.acme.dev"], secretName: "api-acme-dev-tls" }] },
      status: { loadBalancer: { ingress: [{ hostname: "a1b2c3d4e5-123456789.eu-west-1.elb.amazonaws.com" }] } },
    },
    {
      apiVersion: "networking.k8s.io/v1",
      kind: "Ingress",
      metadata: meta("grafana", "monitoring", { labels: labelsFor("grafana") }),
      spec: { ingressClassName: "nginx", rules: [{ host: "grafana.acme.dev", http: { paths: [path("/", "grafana", 3000)] } }] },
    },
    {
      apiVersion: "networking.k8s.io/v1",
      kind: "Ingress",
      metadata: meta("legacy-site", "default"),
      spec: { ingressClassName: "nginx", rules: [{ host: "www.acme.dev", http: { paths: [path("/", "legacy-frontend")] } }] },
    }
  );

  /* StatefulSet with per-replica PVCs bound to PVs of a StorageClass. */
  const pgLabels = { "app.kubernetes.io/name": "postgres", "app.kubernetes.io/instance": "postgres", "app.kubernetes.io/managed-by": "Helm" };
  const pgSpec = {
    containers: [{ name: "postgres", image: "postgres:16.3", ports: [{ name: "pg", containerPort: 5432 }], env: [{ name: "POSTGRES_PASSWORD", valueFrom: { secretKeyRef: { name: "postgres-credentials", key: "password" } } }], resources: { requests: { cpu: "250m", memory: "1Gi" }, limits: { cpu: "2", memory: "4Gi" } } }],
  };
  const pg = {
    apiVersion: "apps/v1",
    kind: "StatefulSet",
    metadata: meta("postgres", "payments", { labels: pgLabels, creationTimestamp: ago(60 * DAY) }),
    spec: { replicas: 2, serviceName: "postgres", selector: { matchLabels: { "app.kubernetes.io/name": "postgres" } }, template: { metadata: { labels: pgLabels }, spec: pgSpec }, volumeClaimTemplates: [{ metadata: { name: "data" } }] },
    status: { replicas: 2, readyReplicas: 2, currentReplicas: 2 },
  };
  add("statefulsets", pg);
  add("storageclasses", {
    apiVersion: "storage.k8s.io/v1",
    kind: "StorageClass",
    metadata: meta("gp3", undefined, { annotations: { "storageclass.kubernetes.io/is-default-class": "true" } }),
    provisioner: "ebs.csi.aws.com",
    reclaimPolicy: "Delete",
    volumeBindingMode: "WaitForFirstConsumer",
  });
  for (const ordinal of [0, 1]) {
    const claimName = `data-postgres-${ordinal}`;
    const pvName = `pvc-${guid().slice(0, 8)}`;
    add("persistentvolumes", { apiVersion: "v1", kind: "PersistentVolume", metadata: meta(pvName, undefined), spec: { capacity: { storage: "50Gi" }, storageClassName: "gp3", claimRef: { name: claimName, namespace: "payments" }, accessModes: ["ReadWriteOnce"] }, status: { phase: "Bound" } });
    add("persistentvolumeclaims", { apiVersion: "v1", kind: "PersistentVolumeClaim", metadata: meta(claimName, "payments", { labels: pgLabels }), spec: { accessModes: ["ReadWriteOnce"], storageClassName: "gp3", volumeName: pvName, resources: { requests: { storage: "50Gi" } } }, status: { phase: "Bound", capacity: { storage: "50Gi" } } });
    add("pods", graphPod(`postgres-${ordinal}`, "payments", { ...pgLabels, "statefulset.kubernetes.io/pod-name": `postgres-${ordinal}` }, ownerRef("StatefulSet", pg), { ...pgSpec, volumes: [{ name: "data", persistentVolumeClaim: { claimName } }] }, { age: 60 * DAY }));
  }
  add("services", { apiVersion: "v1", kind: "Service", metadata: meta("postgres", "payments", { labels: pgLabels }), spec: { type: "ClusterIP", clusterIP: "None", ports: [{ name: "pg", port: 5432, targetPort: 5432, protocol: "TCP" }], selector: { "app.kubernetes.io/name": "postgres" } }, status: {} });

  /* Redis: its claim is stuck Pending (no such storage class). */
  const redisLabels = { "app.kubernetes.io/name": "redis" };
  const redisSpec = { containers: [{ name: "redis", image: "redis:7.2", ports: [{ containerPort: 6379 }] }], volumes: [{ name: "data", persistentVolumeClaim: { claimName: "data-redis-0" } }] };
  const redis = { apiVersion: "apps/v1", kind: "StatefulSet", metadata: meta("redis", "checkout", { labels: redisLabels }), spec: { replicas: 1, selector: { matchLabels: redisLabels }, template: { metadata: { labels: redisLabels }, spec: redisSpec } }, status: { replicas: 1, readyReplicas: 0 } };
  add("statefulsets", redis);
  add("persistentvolumeclaims", { apiVersion: "v1", kind: "PersistentVolumeClaim", metadata: meta("data-redis-0", "checkout", { labels: redisLabels }), spec: { accessModes: ["ReadWriteOnce"], storageClassName: "fast-ssd", resources: { requests: { storage: "8Gi" } } }, status: { phase: "Pending" } });
  add("pods", graphPod("redis-0", "checkout", redisLabels, ownerRef("StatefulSet", redis), redisSpec, { state: "pending" }));
  add("services", { apiVersion: "v1", kind: "Service", metadata: meta("redis", "checkout", { labels: redisLabels }), spec: { type: "ClusterIP", clusterIP: "172.20.40.2", ports: [{ port: 6379, targetPort: 6379, protocol: "TCP" }], selector: redisLabels }, status: {} });

  /* DaemonSet: one node exporter per node. */
  const neLabels = { "app.kubernetes.io/name": "node-exporter", "app.kubernetes.io/instance": "node-exporter" };
  const neSpec = { containers: [{ name: "node-exporter", image: "quay.io/prometheus/node-exporter:v1.8.1", ports: [{ containerPort: 9100 }] }] };
  const ne = { apiVersion: "apps/v1", kind: "DaemonSet", metadata: meta("node-exporter", "monitoring", { labels: neLabels }), spec: { selector: { matchLabels: neLabels }, template: { metadata: { labels: neLabels }, spec: neSpec } }, status: { desiredNumberScheduled: 4, numberReady: 4, numberAvailable: 4 } };
  add("daemonsets", ne);
  NODE_NAMES.forEach((node, i) => add("pods", graphPod(`node-exporter-${ghash(5)}`, "monitoring", neLabels, ownerRef("DaemonSet", ne), neSpec, { node, age: (80 - i) * DAY })));

  /* CronJobs: db-backup (owns the existing job) and a failing report. */
  const backupJob = cluster.jobs[0];
  const backup = { apiVersion: "batch/v1", kind: "CronJob", metadata: meta("db-backup", "payments", { labels: { "app.kubernetes.io/name": "db-backup" } }), spec: { schedule: "0 */2 * * *", jobTemplate: { spec: { template: { spec: { containers: [{ name: "backup", image: "ghcr.io/acme/pg-backup:v1.2.0", envFrom: [{ secretRef: { name: "postgres-credentials" } }] }], restartPolicy: "Never" } } } } }, status: { lastScheduleTime: ago(2 * HOUR), lastSuccessfulTime: ago(2 * HOUR - 40) } };
  add("cronjobs", backup);
  backupJob.metadata.ownerReferences = [ownerRef("CronJob", backup, "batch/v1")];
  backupJob.status.conditions = [{ type: "Complete", status: "True" }];

  const report = { apiVersion: "batch/v1", kind: "CronJob", metadata: meta("report-generator", "checkout", { labels: { "app.kubernetes.io/name": "report-generator" } }), spec: { schedule: "30 1 * * *", jobTemplate: { spec: { backoffLimit: 2, template: { spec: { containers: [{ name: "report", image: "ghcr.io/acme/reports:v0.4.0", envFrom: [{ configMapRef: { name: "checkout-flags" } }] }], restartPolicy: "Never" } } } } }, status: { lastScheduleTime: ago(9 * HOUR) } };
  add("cronjobs", report);
  const reportJob = { apiVersion: "batch/v1", kind: "Job", metadata: meta("report-generator-28745100", "checkout", { creationTimestamp: ago(9 * HOUR), ownerReferences: [ownerRef("CronJob", report, "batch/v1")] }), spec: { completions: 1, backoffLimit: 2 }, status: { failed: 3, startTime: ago(9 * HOUR), conditions: [{ type: "Failed", status: "True", reason: "BackoffLimitExceeded", message: "Job has reached the specified backoff limit" }] } };
  add("jobs", reportJob);
  add("pods", graphPod(`report-generator-28745100-${ghash(5)}`, "checkout", { "job-name": reportJob.metadata.name }, ownerRef("Job", reportJob, "batch/v1"), report.spec.jobTemplate.spec.template.spec, { state: "failed", age: 9 * HOUR }));

  /* Autoscaling, disruption budgets and network policies. */
  const hpa = (name: string, namespace: string, min: number, max: number, current: number) => ({
    apiVersion: "autoscaling/v2",
    kind: "HorizontalPodAutoscaler",
    metadata: meta(name, namespace, { labels: labelsFor(name) }),
    spec: { scaleTargetRef: { apiVersion: "apps/v1", kind: "Deployment", name }, minReplicas: min, maxReplicas: max, metrics: [{ type: "Resource", resource: { name: "cpu", target: { type: "Utilization", averageUtilization: 70 } } }] },
    status: { currentReplicas: current, desiredReplicas: current, currentMetrics: [{ type: "Resource", resource: { name: "cpu", current: { averageUtilization: 63 } } }], conditions: [{ type: "AbleToScale", status: "True" }, { type: "ScalingActive", status: "True" }] },
  });
  add("horizontalpodautoscalers", hpa("payments-api", "payments", 2, 10, 4), hpa("checkout-web", "checkout", 3, 12, 3));
  const pdb = (name: string, namespace: string, minAvailable: number, current: number) => ({
    apiVersion: "policy/v1",
    kind: "PodDisruptionBudget",
    metadata: meta(name, namespace, { labels: labelsFor(name) }),
    spec: { minAvailable, selector: { matchLabels: { "app.kubernetes.io/name": name } } },
    status: { currentHealthy: current, desiredHealthy: minAvailable, disruptionsAllowed: Math.max(0, current - minAvailable), expectedPods: current },
  });
  add("poddisruptionbudgets", pdb("payments-api", "payments", 2, 4), pdb("checkout-api", "checkout", 3, 2));
  add(
    "networkpolicies",
    { apiVersion: "networking.k8s.io/v1", kind: "NetworkPolicy", metadata: meta("ledger-allow-payments", "payments"), spec: { podSelector: { matchLabels: { "app.kubernetes.io/name": "ledger" } }, policyTypes: ["Ingress"], ingress: [{ from: [{ podSelector: { matchLabels: { "app.kubernetes.io/name": "payments-api" } } }] }] } },
    { apiVersion: "networking.k8s.io/v1", kind: "NetworkPolicy", metadata: meta("default-deny", "payments"), spec: { podSelector: {}, policyTypes: ["Ingress"] } }
  );

  /* Gateway API: a gateway routing to feature-flags. */
  const gw = { apiVersion: "gateway.networking.k8s.io/v1", kind: "Gateway", metadata: meta("public-gateway", "platform"), spec: { gatewayClassName: "istio", listeners: [{ name: "https", port: 443, protocol: "HTTPS", hostname: "*.acme.dev" }] }, status: { conditions: [{ type: "Programmed", status: "True" }] } };
  add("gateways", gw);
  add("httproutes", {
    apiVersion: "gateway.networking.k8s.io/v1",
    kind: "HTTPRoute",
    metadata: meta("feature-flags", "platform", { labels: labelsFor("feature-flags") }),
    spec: { parentRefs: [{ name: "public-gateway" }], hostnames: ["flags.acme.dev"], rules: [{ matches: [{ path: { type: "PathPrefix", value: "/" } }], backendRefs: [{ name: "feature-flags", port: 80 }] }] },
    status: { parents: [{ parentRef: { name: "public-gateway" }, conditions: [{ type: "Accepted", status: "True" }] }] },
  });
}

/*
 * ?scenario=large: a synthetic cluster with 2,000+ graphable objects (apps
 * with services, config, secrets, service accounts, ingresses, HPAs and
 * statefulsets with volumes across 12 namespaces), to measure the resource
 * graph. Built lazily: only the large scenario pays for it.
 */
export function buildLargeCluster(apps = 160): Cluster {
  const cluster: Cluster = {
    ...CLUSTERS["prod-eu-west-1"],
    pods: [],
    deployments: [],
    replicasets: [],
    statefulsets: [],
    daemonsets: [],
    cronjobs: [],
    services: [],
    configmaps: [],
    secrets: [],
    serviceaccounts: [],
    ingresses: [],
    jobs: [],
    podmetrics: [],
    persistentvolumeclaims: [],
    persistentvolumes: [],
    horizontalpodautoscalers: [],
    poddisruptionbudgets: [],
    networkpolicies: [],
    gateways: [],
    httproutes: [],
  };
  const add = (resource: string, ...items: any[]) => {
    for (const item of items) cluster[resource].push(item);
  };
  const meta = graphMeta;
  const namespaces = Array.from({ length: 12 }, (_, i) => `team-${String.fromCharCode(97 + i)}`);
  const words = ["orders", "billing", "search", "catalog", "auth", "profile", "media", "notify", "pricing", "inventory", "reviews", "shipping", "tax", "fraud", "loyalty", "quotes"];
  const flaky: PodState[] = ["running", "running", "running", "crashloop", "pending", "imagepull"];
  for (let i = 0; i < apps; i++) {
    const namespace = namespaces[i % namespaces.length];
    const name = `${words[i % words.length]}-${["api", "worker", "web", "sync", "gateway"][Math.floor(i / words.length) % 5]}${i >= 80 ? "-v2" : ""}`;
    const labels = { "app.kubernetes.io/name": name };
    const replicas = 2 + Math.floor(grand() * 7);
    const spec = {
      serviceAccountName: name,
      containers: [
        {
          name: "app",
          image: `ghcr.io/acme/${name}:v1.${i % 9}.0`,
          envFrom: [{ configMapRef: { name: `${name}-config` } }],
          env: [{ name: "DB", valueFrom: { secretKeyRef: { name: i % 37 === 5 ? `${name}-db-missing` : `${name}-secrets`, key: "url" } } }],
        },
      ],
    };
    add("serviceaccounts", { apiVersion: "v1", kind: "ServiceAccount", metadata: meta(name, namespace) });
    add("configmaps", { apiVersion: "v1", kind: "ConfigMap", metadata: meta(`${name}-config`, namespace), data: { "app.yaml": "x: 1" } });
    add("secrets", { apiVersion: "v1", kind: "Secret", type: "Opaque", metadata: meta(`${name}-secrets`, namespace), data: { url: btoa("pg://") } });

    const stateful = i % 10 === 3;
    const workload: any = {
      apiVersion: "apps/v1",
      kind: stateful ? "StatefulSet" : "Deployment",
      metadata: meta(name, namespace, { labels }),
      spec: { replicas, selector: { matchLabels: labels }, template: { metadata: { labels }, spec } },
      status: { replicas, readyReplicas: replicas, availableReplicas: replicas },
    };
    let podOwner = ownerRef(workload.kind, workload);
    if (!stateful) {
      const rs = { apiVersion: "apps/v1", kind: "ReplicaSet", metadata: meta(`${name}-${ghash(9)}`, namespace, { labels, ownerReferences: [ownerRef("Deployment", workload)] }), spec: { replicas }, status: { replicas, readyReplicas: replicas } };
      const oldRs = { apiVersion: "apps/v1", kind: "ReplicaSet", metadata: meta(`${name}-${ghash(9)}`, namespace, { labels, ownerReferences: [ownerRef("Deployment", workload)] }), spec: { replicas: 0 }, status: { replicas: 0 } };
      add("replicasets", rs, oldRs);
      podOwner = ownerRef("ReplicaSet", rs);
    }
    let ready = 0;
    for (let p = 0; p < replicas; p++) {
      const state = i % 9 === 2 ? flaky[Math.floor(grand() * flaky.length)] : "running";
      if (state === "running") ready++;
      const podName = stateful ? `${name}-${p}` : `${podOwner.name}-${ghash(5)}`;
      const podSpec = stateful ? { ...spec, volumes: [{ name: "data", persistentVolumeClaim: { claimName: `data-${name}-${p}` } }] } : spec;
      add("pods", graphPod(podName, namespace, labels, podOwner, podSpec, { state }));
      if (stateful) {
        const pv = `pvc-${guid().slice(0, 8)}`;
        add("persistentvolumeclaims", { apiVersion: "v1", kind: "PersistentVolumeClaim", metadata: meta(`data-${name}-${p}`, namespace), spec: { storageClassName: "gp3", volumeName: pv, resources: { requests: { storage: "20Gi" } } }, status: { phase: "Bound", capacity: { storage: "20Gi" } } });
        add("persistentvolumes", { apiVersion: "v1", kind: "PersistentVolume", metadata: meta(pv, undefined), spec: { storageClassName: "gp3", capacity: { storage: "20Gi" } }, status: { phase: "Bound" } });
      }
    }
    workload.status.readyReplicas = ready;
    workload.status.availableReplicas = ready;
    add(stateful ? "statefulsets" : "deployments", workload);
    add("services", { apiVersion: "v1", kind: "Service", metadata: meta(name, namespace, { labels }), spec: { type: "ClusterIP", clusterIP: `172.21.${i % 255}.${(i * 7) % 255}`, ports: [{ name: "http", port: 80, targetPort: 8080, protocol: "TCP" }], selector: labels }, status: {} });
    if (i % 3 === 0) {
      add("ingresses", { apiVersion: "networking.k8s.io/v1", kind: "Ingress", metadata: meta(name, namespace, { labels }), spec: { ingressClassName: "nginx", rules: [{ host: `${name}.acme.dev`, http: { paths: [{ path: "/", pathType: "Prefix", backend: { service: { name, port: { number: 80 } } } }] } }] } });
    }
    if (i % 4 === 0) {
      add("horizontalpodautoscalers", { apiVersion: "autoscaling/v2", kind: "HorizontalPodAutoscaler", metadata: meta(name, namespace), spec: { scaleTargetRef: { kind: workload.kind, name }, minReplicas: 2, maxReplicas: 12 }, status: { currentReplicas: replicas, conditions: [] } });
    }
  }
  cluster.namespaces = namespaces.map((name) => ({ apiVersion: "v1", kind: "Namespace", metadata: { name, uid: guid() }, status: { phase: "Active" } }));
  return cluster;
}

export const CLUSTERS: Record<string, Cluster> = {
  "prod-eu-west-1": buildCluster("prod-eu-west-1", 1),
  "staging-us-east-2": buildCluster("staging-us-east-2", 0.5),
};

/* ------------------------------------------------------------ discovery -- */

const r = (name: string, kind: string, namespaced = true) => ({
  name,
  singularName: kind.toLowerCase(),
  namespaced,
  kind,
  verbs: ["get", "list", "watch", "create", "update", "patch", "delete"],
});

export const CORE_RESOURCES = [
  r("bindings", "Binding"),
  r("configmaps", "ConfigMap"),
  r("endpoints", "Endpoints"),
  r("events", "Event"),
  r("limitranges", "LimitRange"),
  r("namespaces", "Namespace", false),
  r("nodes", "Node", false),
  r("persistentvolumeclaims", "PersistentVolumeClaim"),
  r("persistentvolumes", "PersistentVolume", false),
  r("pods", "Pod"),
  r("pods/log", "Pod"),
  r("replicationcontrollers", "ReplicationController"),
  r("resourcequotas", "ResourceQuota"),
  r("secrets", "Secret"),
  r("serviceaccounts", "ServiceAccount"),
  r("services", "Service"),
];

export const API_GROUPS: { name: string; version: string; resources: any[] }[] = [
  { name: "apps", version: "apps/v1", resources: [r("daemonsets", "DaemonSet"), r("deployments", "Deployment"), r("replicasets", "ReplicaSet"), r("statefulsets", "StatefulSet")] },
  { name: "batch", version: "batch/v1", resources: [r("cronjobs", "CronJob"), r("jobs", "Job")] },
  { name: "networking.k8s.io", version: "networking.k8s.io/v1", resources: [r("ingresses", "Ingress"), r("ingressclasses", "IngressClass", false), r("networkpolicies", "NetworkPolicy")] },
  { name: "storage.k8s.io", version: "storage.k8s.io/v1", resources: [r("storageclasses", "StorageClass", false), r("csidrivers", "CSIDriver", false)] },
  { name: "autoscaling", version: "autoscaling/v2", resources: [r("horizontalpodautoscalers", "HorizontalPodAutoscaler")] },
  { name: "policy", version: "policy/v1", resources: [r("poddisruptionbudgets", "PodDisruptionBudget")] },
  { name: "rbac.authorization.k8s.io", version: "rbac.authorization.k8s.io/v1", resources: [r("clusterrolebindings", "ClusterRoleBinding", false), r("clusterroles", "ClusterRole", false), r("rolebindings", "RoleBinding"), r("roles", "Role")] },
  { name: "apiextensions.k8s.io", version: "apiextensions.k8s.io/v1", resources: [r("customresourcedefinitions", "CustomResourceDefinition", false)] },
  { name: "metrics.k8s.io", version: "metrics.k8s.io/v1beta1", resources: [r("pods", "PodMetrics"), r("nodes", "NodeMetrics", false)] },
  { name: "gateway.networking.k8s.io", version: "gateway.networking.k8s.io/v1", resources: [r("gateways", "Gateway"), r("httproutes", "HTTPRoute"), r("gatewayclasses", "GatewayClass", false)] },
  { name: "cert-manager.io", version: "cert-manager.io/v1", resources: [r("certificates", "Certificate"), r("clusterissuers", "ClusterIssuer", false), r("issuers", "Issuer")] },
];

/* ----------------------------------------------------------------- logs -- */

const LOG_MESSAGES = [
  ["info", "http", "request completed"],
  ["info", "http", "request completed"],
  ["debug", "db", "acquired connection from pool"],
  ["info", "payments", "charge authorized"],
  ["warn", "payments", "retrying idempotent request"],
  ["info", "http", "request completed"],
  ["error", "payments", "upstream timeout talking to stripe"],
  ["info", "cache", "cache hit ratio recalculated"],
];

export function logLines(count = 80): string[] {
  const lines: string[] = [];
  for (let i = 0; i < count; i++) {
    const [level, logger, msg] = LOG_MESSAGES[i % LOG_MESSAGES.length];
    const ts = new Date(NOW - (count - i) * 1700).toISOString();
    const entry: Record<string, unknown> = {
      level,
      ts,
      logger,
      msg,
      trace_id: hash(16),
    };
    if (logger === "http") {
      entry.method = ["GET", "POST", "GET", "PUT"][i % 4];
      entry.path = ["/v1/charges", "/v1/refunds", "/healthz", "/v1/customers/42"][i % 4];
      entry.status = [200, 201, 200, 404][i % 4];
      entry.duration_ms = Math.round(4 + rand() * 180);
    }
    lines.push(`${ts} ${JSON.stringify(entry)}`);
  }
  return lines;
}

/* ------------------------------------------------------------- describe -- */

export function describe(kind: string, obj: any): string {
  const m = obj?.metadata || {};
  const lines = [
    `Name:             ${m.name}`,
    `Namespace:        ${m.namespace || ""}`,
    `Priority:         0`,
    `Service Account:  ${obj?.spec?.serviceAccountName || "default"}`,
    `Node:             ${obj?.spec?.nodeName || "<none>"}`,
    `Start Time:       ${new Date(m.creationTimestamp || NOW).toUTCString()}`,
    `Labels:           ${Object.entries(m.labels || {}).map(([k, v]) => `${k}=${v}`).join("\n                  ")}`,
    `Annotations:      ${Object.entries(m.annotations || {}).map(([k, v]) => `${k}: ${v}`).join("\n                  ")}`,
    `Status:           ${obj?.status?.phase || "Running"}`,
    `IP:               ${obj?.status?.podIP || "<none>"}`,
    `Controlled By:    ${m.ownerReferences?.[0] ? `${m.ownerReferences[0].kind}/${m.ownerReferences[0].name}` : "<none>"}`,
    `Containers:`,
    ...(obj?.spec?.containers || []).flatMap((c: any) => [
      `  ${c.name}:`,
      `    Image:          ${c.image}`,
      `    Port:           ${c.ports?.[0]?.containerPort ?? "<none>"}/TCP`,
      `    State:          Running`,
      `      Started:      ${new Date(m.creationTimestamp || NOW).toUTCString()}`,
      `    Ready:          True`,
      `    Restart Count:  0`,
      `    Limits:`,
      `      cpu:     ${c.resources?.limits?.cpu}`,
      `      memory:  ${c.resources?.limits?.memory}`,
      `    Requests:`,
      `      cpu:        ${c.resources?.requests?.cpu}`,
      `      memory:     ${c.resources?.requests?.memory}`,
    ]),
    `Conditions:`,
    `  Type              Status`,
    ...(obj?.status?.conditions || []).map((c: any) => `  ${c.type.padEnd(18)}${c.status}`),
    `QoS Class:        Burstable`,
    `Events:`,
    `  Type    Reason     Age   From               Message`,
    `  ----    ------     ----  ----               -------`,
    `  Normal  Scheduled  12m   default-scheduler  Successfully assigned ${m.namespace}/${m.name}`,
    `  Normal  Pulled     12m   kubelet            Container image already present on machine`,
    `  Normal  Created    12m   kubelet            Created container`,
    `  Normal  Started    12m   kubelet            Started container`,
  ];
  return lines.join("\n") + "\n";
}

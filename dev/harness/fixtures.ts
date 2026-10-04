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

  return { pods, deployments, replicasets, services, nodes, events, configmaps, secrets, namespaces, jobs, ingresses, podmetrics, helmReleases };
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

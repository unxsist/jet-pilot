/*
 * Deterministic synthetic pod lists for the table benchmarks / tests.
 * Shaped like `kubectl get pods -o json` items as tagged by the Pods view
 * (metadata.context / kubeConfig, empty `metrics`).
 */

const NAMESPACES = [
  "default",
  "payments",
  "checkout",
  "search",
  "kube-system",
  "monitoring",
  "ingress",
  "data",
];
const APPS = [
  "payments-api",
  "checkout-api",
  "web",
  "search-indexer",
  "redis",
  "postgres",
  "prometheus",
  "worker",
  "gateway",
  "auth",
];
const NODES = Array.from(
  { length: 24 },
  (_, i) => `ip-10-0-${i}-${(i * 37) % 255}.eu-west-1.compute.internal`
);
const PHASES = [
  "Running",
  "Running",
  "Running",
  "Running",
  "Pending",
  "Succeeded",
  "Failed",
];

/* Small deterministic PRNG (mulberry32). */
function rng(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function syntheticPod(
  i: number,
  version = 1,
  contexts = ["prod-eu-west-1", "staging"]
) {
  const rand = rng(i + 1);
  const app = APPS[i % APPS.length];
  const namespace = NAMESPACES[Math.floor(rand() * NAMESPACES.length)];
  const phase = PHASES[Math.floor(rand() * PHASES.length)];
  const restarts = Math.floor(rand() * 4) * (rand() > 0.8 ? 7 : 0);
  const created = new Date(
    Date.UTC(2026, 8, 1) + Math.floor(rand() * 30 * 86400000)
  ).toISOString();
  const containers = 1 + (i % 3 === 0 ? 1 : 0);

  return {
    apiVersion: "v1",
    kind: "Pod",
    metadata: {
      name: `${app}-${((i * 2654435761) >>> 0)
        .toString(36)
        .slice(0, 9)}-${i.toString(36)}`,
      namespace,
      uid: `uid-${i.toString(16).padStart(8, "0")}`,
      resourceVersion: String(100000 + i * 10 + version),
      creationTimestamp: created,
      labels: { app, "pod-template-hash": (i % 97).toString(16) },
      ownerReferences: [
        {
          kind: "ReplicaSet",
          name: `${app}-rs-${i % 50}`,
          uid: `rs-${i % 50}`,
          apiVersion: "apps/v1",
        },
      ],
      context: contexts[i % contexts.length],
      kubeConfig: "/home/user/.kube/config",
    },
    spec: {
      nodeName: NODES[i % NODES.length],
      containers: Array.from({ length: containers }, (_, c) => ({
        name: c === 0 ? app : "sidecar",
        image: `registry.example.com/${app}:1.${i % 20}.${c}`,
        resources: {
          requests: { cpu: "100m", memory: "128Mi" },
          limits: { cpu: "500m", memory: "512Mi" },
        },
      })),
    },
    status: {
      phase,
      podIP: `10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}`,
      startTime: created,
      containerStatuses: Array.from({ length: containers }, (_, c) => ({
        name: c === 0 ? app : "sidecar",
        ready: phase === "Running",
        restartCount: restarts,
        image: `registry.example.com/${app}:1.${i % 20}.${c}`,
        imageID: "",
        state:
          phase === "Running"
            ? { running: { startedAt: created } }
            : { waiting: { reason: "ContainerCreating" } },
      })),
    },
    metrics: [] as unknown[],
  };
}

export type SyntheticPod = ReturnType<typeof syntheticPod>;

export function syntheticPods(count: number): SyntheticPod[] {
  return Array.from({ length: count }, (_, i) => syntheticPod(i));
}

/**
 * A refreshed list as the polling data layer delivers it: every row is a
 * new object (JSON round trip), `changedFraction` of them with a new
 * resourceVersion and status.
 */
export function refreshedPods(
  previous: SyntheticPod[],
  changedFraction: number,
  round: number
): SyntheticPod[] {
  const step = Math.max(1, Math.round(1 / changedFraction));
  const next = JSON.parse(JSON.stringify(previous)) as SyntheticPod[];
  for (let i = round % step; i < next.length; i += step) {
    const pod = next[i];
    pod.metadata.resourceVersion = String(
      Number(pod.metadata.resourceVersion) + 1
    );
    pod.status.containerStatuses[0].restartCount += 1;
  }
  return next;
}

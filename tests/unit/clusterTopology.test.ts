import { describe, expect, test } from "vitest";
import {
  GraphObject,
  buildTopology,
  labelSelectorMatches,
  parseLabelFilter,
  podSpecReferences,
  selectGraphResources,
  summarize,
  topologySignature,
  traceNeighbourhood,
  visibleGraph,
} from "@/lib/clusterGraph";

/* ------------------------------------------------------------ builders -- */

let counter = 0;
const meta = (
  name: string,
  extra: Record<string, any> = {},
  namespace = "shop"
) => ({
  name,
  namespace,
  uid: `${name}-${++counter}`,
  ...extra,
});

const owner = (object: GraphObject) => ({
  apiVersion: "apps/v1",
  kind: object.kind!,
  name: object.metadata.name!,
  uid: object.metadata.uid!,
  controller: true,
});

const runningPod = (name: string, labels: Record<string, string>, owned?: GraphObject, extra: any = {}): GraphObject => ({
  apiVersion: "v1",
  kind: "Pod",
  metadata: meta(name, { labels, ownerReferences: owned ? [owner(owned)] : undefined }),
  spec: { containers: [{ name: "app" }], ...extra.spec },
  status: {
    phase: "Running",
    conditions: [{ type: "Ready", status: "True" }],
    containerStatuses: [
      { name: "app", ready: true, restartCount: 0, state: { running: {} } },
    ],
    ...extra.status,
  },
});

const crashingPod = (name: string, labels: Record<string, string>, owned?: GraphObject): GraphObject =>
  runningPod(name, labels, owned, {
    status: {
      phase: "Running",
      conditions: [{ type: "Ready", status: "False" }],
      containerStatuses: [
        {
          name: "app",
          ready: false,
          restartCount: 12,
          state: { waiting: { reason: "CrashLoopBackOff" } },
        },
      ],
    },
  });

const deployment = (
  name: string,
  replicas: number,
  available: number,
  podSpec: any = { containers: [{ name: "app" }] },
  labels = { "app.kubernetes.io/name": name }
): GraphObject => ({
  apiVersion: "apps/v1",
  kind: "Deployment",
  metadata: meta(name, { labels }),
  spec: {
    replicas,
    selector: { matchLabels: labels },
    template: { metadata: { labels }, spec: podSpec },
  },
  status: { replicas, availableReplicas: available, readyReplicas: available },
});

const replicaSet = (name: string, dep: GraphObject, replicas: number): GraphObject => ({
  apiVersion: "apps/v1",
  kind: "ReplicaSet",
  metadata: meta(name, { ownerReferences: [owner(dep)] }),
  spec: { replicas },
  status: { replicas, readyReplicas: replicas },
});

const service = (name: string, selector: Record<string, string> | undefined, extra: any = {}): GraphObject => ({
  apiVersion: "v1",
  kind: "Service",
  metadata: meta(name),
  spec: { type: "ClusterIP", selector, ports: [{ port: 80 }], ...extra },
  status: {},
});

const ingress = (name: string, backends: string[], tlsSecret?: string): GraphObject => ({
  apiVersion: "networking.k8s.io/v1",
  kind: "Ingress",
  metadata: meta(name),
  spec: {
    rules: [
      {
        host: `${name}.example.com`,
        http: {
          paths: backends.map((backend) => ({
            path: "/",
            backend: { service: { name: backend, port: { number: 80 } } },
          })),
        },
      },
    ],
    tls: tlsSecret ? [{ hosts: [`${name}.example.com`], secretName: tlsSecret }] : undefined,
  },
});

const simple = (kind: string, name: string, extra: any = {}, namespace = "shop"): GraphObject => {
  const { metadata, ...rest } = extra;
  return { kind, metadata: meta(name, metadata || {}, namespace), ...rest };
};

/** A Deployment with an active + old ReplicaSet and its pods. */
function webApp(options: { crash?: boolean } = {}) {
  const labels = { "app.kubernetes.io/name": "web" };
  const dep = deployment("web", 2, options.crash ? 1 : 2, {
    containers: [
      {
        name: "app",
        envFrom: [{ configMapRef: { name: "web-config" } }],
        env: [{ name: "PW", valueFrom: { secretKeyRef: { name: "web-db", key: "pw" } } }],
      },
    ],
    volumes: [{ name: "data", persistentVolumeClaim: { claimName: "web-data" } }],
    serviceAccountName: "web",
  });
  const rs = replicaSet("web-abc", dep, 2);
  const oldRs = replicaSet("web-old", dep, 0);
  const pods = [
    runningPod("web-abc-1", labels, rs),
    options.crash ? crashingPod("web-abc-2", labels, rs) : runningPod("web-abc-2", labels, rs),
  ];
  return { dep, rs, oldRs, pods, labels };
}

const edgeTypes = (topology: ReturnType<typeof buildTopology>, from: string, to: string) =>
  topology.edges
    .filter((edge) => edge.source === from && edge.target === to)
    .map((edge) => edge.type);

/* --------------------------------------------------------------- tests -- */

describe("selectors", () => {
  test("label selectors support matchLabels and expressions", () => {
    const labels = { app: "web", tier: "frontend" };
    expect(labelSelectorMatches({ matchLabels: { app: "web" } }, labels)).toBe(true);
    expect(labelSelectorMatches({ matchLabels: { app: "db" } }, labels)).toBe(false);
    expect(
      labelSelectorMatches(
        {
          matchExpressions: [
            { key: "tier", operator: "In", values: ["frontend", "edge"] },
            { key: "canary", operator: "DoesNotExist" },
          ],
        },
        labels
      )
    ).toBe(true);
    expect(
      labelSelectorMatches({ matchExpressions: [{ key: "tier", operator: "NotIn", values: ["frontend"] }] }, labels)
    ).toBe(false);
    expect(labelSelectorMatches({}, labels)).toBe(true);
    expect(labelSelectorMatches(undefined, labels)).toBe(false);
  });

  test("label filters", () => {
    const match = parseLabelFilter("app=web, tier!=db, team")!;
    expect(match({ app: "web", tier: "frontend", team: "a" })).toBe(true);
    expect(match({ app: "web", tier: "db", team: "a" })).toBe(false);
    expect(match({ app: "web" })).toBe(false);
    expect(parseLabelFilter("  ")).toBeNull();
  });
});

describe("podSpecReferences", () => {
  test("collects volumes, env, envFrom, projected, pull secrets and the service account", () => {
    const refs = podSpecReferences({
      serviceAccountName: "runner",
      imagePullSecrets: [{ name: "registry" }],
      volumes: [
        { name: "a", configMap: { name: "cm-volume" } },
        { name: "b", secret: { secretName: "secret-volume", optional: true } },
        { name: "c", persistentVolumeClaim: { claimName: "claim" } },
        {
          name: "kube-api-access",
          projected: {
            sources: [{ configMap: { name: "kube-root-ca.crt" } }, { secret: { name: "projected" } }],
          },
        },
      ],
      initContainers: [{ envFrom: [{ secretRef: { name: "init-secret" } }] }],
      containers: [
        {
          envFrom: [{ configMapRef: { name: "cm-env", optional: true } }],
          env: [{ valueFrom: { configMapKeyRef: { name: "cm-key" } } }],
        },
      ],
    });
    const byId = Object.fromEntries(refs.map((ref) => [`${ref.kind}/${ref.name}`, ref.optional]));
    expect(byId).toEqual({
      "ConfigMap/cm-volume": false,
      "Secret/secret-volume": true,
      "PersistentVolumeClaim/claim": false,
      "Secret/projected": false,
      "Secret/init-secret": false,
      "ConfigMap/cm-env": true,
      "ConfigMap/cm-key": false,
      "Secret/registry": false,
      "ServiceAccount/runner": false,
    });
  });

  test("leaves out the implicit default service account", () => {
    expect(podSpecReferences({ serviceAccountName: "default", containers: [] })).toEqual([]);
  });
});

describe("buildTopology: relationships", () => {
  test("collapses Deployment -> ReplicaSet -> Pod under the deployment", () => {
    const { dep, rs, oldRs, pods } = webApp();
    const topology = buildTopology([dep, rs, oldRs, ...pods]);
    const root = topology.nodes.get(dep.metadata.uid!)!;

    expect(root.category).toBe("workload");
    expect(root.pods!.map((pod) => pod.metadata.name)).toEqual(["web-abc-1", "web-abc-2"]);
    expect(root.replicaSets!.active.map((r) => r.metadata.name)).toEqual(["web-abc"]);
    expect(root.replicaSets!.old.map((r) => r.metadata.name)).toEqual(["web-old"]);

    const podNode = topology.nodes.get(pods[0].metadata.uid!)!;
    expect(podNode.parent).toBe(dep.metadata.uid);
    expect(topology.nodes.get(oldRs.metadata.uid!)!.old).toBe(true);
    expect(edgeTypes(topology, dep.metadata.uid!, rs.metadata.uid!)).toEqual(["owns"]);
    expect(edgeTypes(topology, rs.metadata.uid!, pods[0].metadata.uid!)).toEqual(["owns"]);
  });

  test("CronJob -> Job -> Pod and StatefulSet / DaemonSet -> Pod", () => {
    const cron = simple("CronJob", "backup", { spec: { schedule: "@daily", jobTemplate: { spec: { template: { spec: { containers: [] } } } } } });
    const job = simple("Job", "backup-1", {
      metadata: { ownerReferences: [owner(cron)], creationTimestamp: "2024-01-01T00:00:00Z" },
      status: { succeeded: 1, conditions: [{ type: "Complete", status: "True" }] },
    });
    const jobPod = runningPod("backup-1-x", {}, job, { status: { phase: "Succeeded", containerStatuses: [] } });
    const sts = simple("StatefulSet", "db", { spec: { replicas: 1, template: { spec: {} } }, status: { readyReplicas: 1 } });
    const stsPod = runningPod("db-0", {}, sts);
    const ds = simple("DaemonSet", "agent", { status: { desiredNumberScheduled: 1, numberReady: 1 } });
    const dsPod = runningPod("agent-x", {}, ds);

    const topology = buildTopology([cron, job, jobPod, sts, stsPod, ds, dsPod]);
    expect(topology.nodes.get(jobPod.metadata.uid!)!.parent).toBe(cron.metadata.uid);
    expect(topology.nodes.get(cron.metadata.uid!)!.jobs!.map((j) => j.metadata.name)).toEqual(["backup-1"]);
    expect(edgeTypes(topology, cron.metadata.uid!, job.metadata.uid!)).toEqual(["owns"]);
    expect(edgeTypes(topology, job.metadata.uid!, jobPod.metadata.uid!)).toEqual(["owns"]);
    expect(topology.nodes.get(stsPod.metadata.uid!)!.parent).toBe(sts.metadata.uid);
    expect(topology.nodes.get(dsPod.metadata.uid!)!.parent).toBe(ds.metadata.uid);
    expect(topology.nodes.get(cron.metadata.uid!)!.health).toBe("ok");
  });

  test("owners of an unfetched kind become external roots", () => {
    const rs = simple("ReplicaSet", "rollout-abc", {
      metadata: { ownerReferences: [{ kind: "Rollout", name: "rollout", uid: "r-1", controller: true }] },
      spec: { replicas: 1 },
      status: { readyReplicas: 1 },
    });
    const pod = runningPod("rollout-abc-1", {}, rs);
    const topology = buildTopology([rs, pod]);
    const root = topology.nodes.get("external:r-1")!;
    expect(root).toMatchObject({ kind: "Rollout", name: "rollout", external: true });
    expect(root.pods).toHaveLength(1);
    expect(topology.nodes.get(pod.metadata.uid!)!.parent).toBe("external:r-1");
  });

  test("traffic: Ingress -> Service -> workload, Gateway -> HTTPRoute -> Service", () => {
    const { dep, rs, pods, labels } = webApp();
    const svc = service("web", labels);
    const ing = ingress("web", ["web"]);
    const gateway = simple("Gateway", "edge", { metadata: {}, spec: {} }, "infra");
    const route = simple("HTTPRoute", "web", {
      spec: {
        parentRefs: [{ name: "edge", namespace: "infra" }],
        rules: [{ backendRefs: [{ name: "web", port: 80 }] }],
      },
    });
    const topology = buildTopology([dep, rs, ...pods, svc, ing, gateway, route]);

    expect(edgeTypes(topology, ing.metadata.uid!, svc.metadata.uid!)).toEqual(["routes"]);
    expect(edgeTypes(topology, svc.metadata.uid!, dep.metadata.uid!)).toEqual(["routes"]);
    expect(edgeTypes(topology, gateway.metadata.uid!, route.metadata.uid!)).toEqual(["routes"]);
    expect(edgeTypes(topology, route.metadata.uid!, svc.metadata.uid!)).toEqual(["routes"]);
    expect(topology.nodes.get(svc.metadata.uid!)!.health).toBe("ok");
  });

  test("services also select workloads scaled to zero (by template labels)", () => {
    const labels = { app: "idle" };
    const dep = deployment("idle", 0, 0, { containers: [] }, labels);
    const svc = service("idle", labels);
    const topology = buildTopology([dep, svc]);
    expect(edgeTypes(topology, svc.metadata.uid!, dep.metadata.uid!)).toEqual(["routes"]);
    expect(topology.nodes.get(dep.metadata.uid!)!.health).toBe("neutral");
    expect(topology.nodes.get(svc.metadata.uid!)!.reasons).toContain("No ready endpoints");
  });

  test("config, storage and identity dependencies", () => {
    const { dep, rs, pods } = webApp();
    const cm = simple("ConfigMap", "web-config");
    const secret = simple("Secret", "web-db", { type: "Opaque" });
    const sa = simple("ServiceAccount", "web");
    const sc = simple("StorageClass", "gp3", {}, "");
    const pv = simple("PersistentVolume", "pv-1", { spec: { storageClassName: "gp3" }, status: { phase: "Bound" } }, "");
    const pvc = simple("PersistentVolumeClaim", "web-data", { spec: { volumeName: "pv-1", storageClassName: "gp3" }, status: { phase: "Bound" } });
    const topology = buildTopology([dep, rs, ...pods, cm, secret, sa, sc, pv, pvc]);
    const depId = dep.metadata.uid!;

    for (const target of [cm, secret, sa, pvc]) {
      expect(edgeTypes(topology, depId, target.metadata.uid!)).toEqual(["mounts"]);
    }
    expect(edgeTypes(topology, pvc.metadata.uid!, pv.metadata.uid!)).toEqual(["mounts"]);
    expect(edgeTypes(topology, pv.metadata.uid!, sc.metadata.uid!)).toEqual(["mounts"]);
    expect([...topology.nodes.values()].some((node) => node.missing)).toBe(false);
  });

  test("HPA scales, PDB and NetworkPolicy select the workload", () => {
    const { dep, rs, pods, labels } = webApp();
    const hpa = simple("HorizontalPodAutoscaler", "web", {
      spec: { scaleTargetRef: { kind: "Deployment", name: "web" }, minReplicas: 2, maxReplicas: 10 },
      status: { currentReplicas: 2 },
    });
    const pdb = simple("PodDisruptionBudget", "web", {
      spec: { selector: { matchLabels: labels } },
      status: { currentHealthy: 2, desiredHealthy: 1 },
    });
    const policy = simple("NetworkPolicy", "web", { spec: { podSelector: { matchLabels: labels } } });
    const denyAll = simple("NetworkPolicy", "deny-all", { spec: { podSelector: {} } });
    const topology = buildTopology([dep, rs, ...pods, hpa, pdb, policy, denyAll]);
    const depId = dep.metadata.uid!;
    expect(edgeTypes(topology, hpa.metadata.uid!, depId)).toEqual(["scales"]);
    expect(edgeTypes(topology, pdb.metadata.uid!, depId)).toEqual(["selects"]);
    expect(edgeTypes(topology, policy.metadata.uid!, depId)).toEqual(["selects"]);
    expect(topology.edges.some((edge) => edge.source === denyAll.metadata.uid)).toBe(false);
  });
});

describe("buildTopology: dangling references", () => {
  test("missing ConfigMap / Secret become missing nodes and flag the workload", () => {
    const { dep, rs, pods } = webApp();
    const topology = buildTopology([dep, rs, ...pods, simple("ConfigMap", "other"), simple("Secret", "x", { type: "Opaque" })], {
      loadedKinds: new Set(["Deployment", "ReplicaSet", "Pod", "ConfigMap", "Secret"]),
    });
    const missing = [...topology.nodes.values()].filter((node) => node.missing);
    expect(missing.map((node) => `${node.kind}/${node.name}`).sort()).toEqual([
      "ConfigMap/web-config",
      "Secret/web-db",
    ]);
    expect(missing.every((node) => node.health === "error")).toBe(true);
    // Placed next to the workload that references them.
    expect(missing.every((node) => node.group === "shop/web")).toBe(true);

    const root = topology.nodes.get(dep.metadata.uid!)!;
    expect(root.health).toBe("warning");
    expect(root.reasons).toContain('References missing ConfigMap "web-config"');
    expect(edgeTypes(topology, root.id, "missing:ConfigMap/shop/web-config")).toEqual(["mounts"]);
  });

  test("kinds that were not loaded (e.g. no RBAC for Secrets) never dangle", () => {
    const { dep, rs, pods } = webApp();
    const topology = buildTopology([dep, rs, ...pods], {
      loadedKinds: new Set(["Deployment", "ReplicaSet", "Pod"]),
    });
    expect([...topology.nodes.values()].some((node) => node.missing)).toBe(false);
    expect(topology.nodes.get(dep.metadata.uid!)!.health).toBe("ok");
  });

  test("optional references never dangle", () => {
    const dep = deployment("opt", 1, 1, {
      containers: [{ envFrom: [{ configMapRef: { name: "maybe", optional: true } }] }],
    });
    const topology = buildTopology([dep], { loadedKinds: new Set(["Deployment", "ConfigMap"]) });
    expect([...topology.nodes.values()].some((node) => node.missing)).toBe(false);
  });

  test("ingress with a missing backend service fails", () => {
    const ing = ingress("shop", ["ghost"]);
    const topology = buildTopology([ing], { loadedKinds: new Set(["Ingress", "Service"]) });
    const node = topology.nodes.get(ing.metadata.uid!)!;
    expect(node.health).toBe("error");
    expect(node.reasons).toContain('Backend Service "ghost" does not exist');
    const missing = topology.nodes.get("missing:Service/shop/ghost")!;
    expect(missing.missing).toBe(true);
    expect(missing.group).toBe(node.group);
  });

  test("references outside the fetched namespaces are not judged", () => {
    const route = simple("HTTPRoute", "r", {
      spec: { rules: [{ backendRefs: [{ name: "svc", namespace: "elsewhere" }] }] },
    });
    const topology = buildTopology([route], {
      loadedKinds: new Set(["HTTPRoute", "Service"]),
      namespaceInScope: (namespace) => namespace === "shop",
    });
    expect([...topology.nodes.values()].some((node) => node.missing)).toBe(false);
  });

  test("HPA with a missing scale target fails", () => {
    const hpa = simple("HorizontalPodAutoscaler", "gone", {
      spec: { scaleTargetRef: { kind: "Deployment", name: "gone" }, maxReplicas: 3 },
      status: {},
    });
    const topology = buildTopology([hpa], { loadedKinds: new Set(["HorizontalPodAutoscaler", "Deployment"]) });
    expect(topology.nodes.get(hpa.metadata.uid!)!.health).toBe("error");
    expect(topology.nodes.has("missing:Deployment/shop/gone")).toBe(true);
  });
});

describe("buildTopology: health", () => {
  test("a crashing pod degrades its deployment and the app", () => {
    const { dep, rs, pods, labels } = webApp({ crash: true });
    const svc = service("web", labels);
    const ing = ingress("web", ["web"]);
    const topology = buildTopology([dep, rs, ...pods, svc, ing]);
    const root = topology.nodes.get(dep.metadata.uid!)!;
    expect(root.health).toBe("warning");
    expect(root.reasons).toEqual(["1/2 replicas available", "1 pod CrashLoopBackOff"]);
    expect(topology.nodes.get(pods[1].metadata.uid!)!.health).toBe("error");
    // One ready endpoint left: service and ingress are fine.
    expect(topology.nodes.get(svc.metadata.uid!)!.health).toBe("ok");
    expect(topology.nodes.get(ing.metadata.uid!)!.health).toBe("ok");
    expect(topology.groups.get("shop/web")!.health).toBe("warning");
  });

  test("all pods failing fails the workload, the service and the ingress", () => {
    const labels = { app: "api" };
    const dep = deployment("api", 1, 0, { containers: [] }, labels);
    const rs = replicaSet("api-1", dep, 1);
    const pod = crashingPod("api-1-x", labels, rs);
    const svc = service("api", labels);
    const ing = ingress("api", ["api"]);
    const topology = buildTopology([dep, rs, pod, svc, ing]);
    expect(topology.nodes.get(dep.metadata.uid!)!.health).toBe("error");
    expect(topology.nodes.get(svc.metadata.uid!)!).toMatchObject({ health: "error", reasons: ["No ready endpoints"] });
    const ingressNode = topology.nodes.get(ing.metadata.uid!)!;
    expect(ingressNode.health).toBe("error");
    expect(ingressNode.reasons[0]).toContain("No ready endpoints");
  });

  test("a service whose selector matches nothing fails", () => {
    const svc = service("orphan", { app: "nothing" });
    const topology = buildTopology([svc]);
    expect(topology.nodes.get(svc.metadata.uid!)!).toMatchObject({
      health: "error",
      reasons: ["Selector matches no pods"],
    });
  });

  test("services without selector use EndpointSlices when present", () => {
    const external = service("external", undefined);
    const slice = simple("EndpointSlice", "external-abc", {
      metadata: { labels: { "kubernetes.io/service-name": "external" } },
      endpoints: [{ conditions: { ready: true } }],
    });
    expect(buildTopology([external, slice]).nodes.get(external.metadata.uid!)!.health).toBe("ok");
    const unknown = service("manual", undefined);
    expect(buildTopology([unknown]).nodes.get(unknown.metadata.uid!)!.health).toBe("neutral");
  });

  test("pending claims warn, restarts warn, failed last cron run fails", () => {
    const pvc = simple("PersistentVolumeClaim", "pending", { spec: {}, status: { phase: "Pending" } });
    const restarting = runningPod("flaky", {}, undefined, {
      status: {
        phase: "Running",
        containerStatuses: [{ name: "app", ready: true, restartCount: 9, state: { running: {} } }],
      },
    });
    const cron = simple("CronJob", "report", { spec: { jobTemplate: { spec: { template: { spec: {} } } } } });
    const failedJob = simple("Job", "report-2", {
      metadata: { ownerReferences: [owner(cron)], creationTimestamp: "2024-01-02T00:00:00Z" },
      status: { failed: 1, conditions: [{ type: "Failed", status: "True", reason: "BackoffLimitExceeded" }] },
    });
    const okJob = simple("Job", "report-1", {
      metadata: { ownerReferences: [owner(cron)], creationTimestamp: "2024-01-01T00:00:00Z" },
      status: { succeeded: 1, conditions: [{ type: "Complete", status: "True" }] },
    });
    const topology = buildTopology([pvc, restarting, cron, failedJob, okJob]);
    expect(topology.nodes.get(pvc.metadata.uid!)!.health).toBe("warning");
    expect(topology.nodes.get(restarting.metadata.uid!)!).toMatchObject({ health: "warning", reasons: ["9 restarts"] });
    expect(topology.nodes.get(cron.metadata.uid!)!.health).toBe("error");
    expect(topology.nodes.get(cron.metadata.uid!)!.reasons).toContain("Last run failed");
  });
});

describe("buildTopology: grouping", () => {
  test("groups by app label and pulls services, ingresses and deps into the app", () => {
    const { dep, rs, pods, labels } = webApp();
    const svc = service("web-svc", labels);
    const ing = ingress("public", ["web-svc"], "public-tls");
    const cm = simple("ConfigMap", "web-config");
    const tls = simple("Secret", "public-tls", { type: "kubernetes.io/tls" });
    const topology = buildTopology([dep, rs, ...pods, svc, ing, cm, tls]);
    const group = topology.groups.get("shop/web")!;
    expect(group.type).toBe("app");
    for (const object of [dep, svc, ing, cm, tls, pods[0]]) {
      expect(topology.nodes.get(object.metadata.uid!)!.group).toBe("shop/web");
    }
  });

  test("helm release / instance labels group several workloads into one app", () => {
    const a = deployment("shop-api", 1, 1, { containers: [] }, { "app.kubernetes.io/instance": "shop", "app.kubernetes.io/name": "api" } as any);
    const b = deployment("shop-web", 1, 1, { containers: [] }, { "app.kubernetes.io/instance": "shop", "app.kubernetes.io/name": "web" } as any);
    const topology = buildTopology([a, b]);
    expect(topology.groups.get("shop/shop")!.nodeIds.sort()).toEqual([a.metadata.uid, b.metadata.uid].sort());
  });

  test("dependencies used by several apps are shared; unreferenced ones unused", () => {
    const shared = simple("ConfigMap", "common");
    const unused = simple("ConfigMap", "leftover");
    const a = deployment("a", 1, 1, { containers: [{ envFrom: [{ configMapRef: { name: "common" } }] }] });
    const b = deployment("b", 1, 1, { containers: [{ envFrom: [{ configMapRef: { name: "common" } }] }] });
    const topology = buildTopology([shared, unused, a, b]);
    expect(topology.nodes.get(shared.metadata.uid!)!.group).toBe("shop/~shared");
    expect(topology.groups.get("shop/~shared")!.type).toBe("shared");
    expect(topology.nodes.get(unused.metadata.uid!)!.group).toBe("shop/~unused");
  });
});

describe("visibleGraph", () => {
  const build = () => {
    const app = webApp({ crash: true });
    const healthy = deployment("calm", 1, 1, { containers: [] }, { app: "calm" } as any);
    const unused = simple("ConfigMap", "leftover");
    const topology = buildTopology([app.dep, app.rs, app.oldRs, ...app.pods, healthy, unused]);
    return { app, healthy, topology };
  };

  test("collapses children unless expanded; old ReplicaSets need the history", () => {
    const { app, topology } = build();
    const none = { expanded: new Set<string>(), history: new Set<string>() };
    const collapsed = visibleGraph(topology, none);
    expect(collapsed.nodes.some((node) => node.parent)).toBe(false);
    expect(collapsed.nodes.some((node) => node.name === "leftover")).toBe(false);

    const expanded = visibleGraph(topology, { expanded: new Set([app.dep.metadata.uid!]), history: new Set() });
    const names = expanded.nodes.map((node) => node.name);
    expect(names).toContain("web-abc");
    expect(names).toContain("web-abc-1");
    expect(names).not.toContain("web-old");
    expect(expanded.edges.some((edge) => edge.type === "owns")).toBe(true);

    const history = visibleGraph(topology, {
      expanded: new Set([app.dep.metadata.uid!]),
      history: new Set([app.dep.metadata.uid!]),
    });
    expect(history.nodes.map((node) => node.name)).toContain("web-old");
  });

  test("filters by problems, namespaces, labels and categories", () => {
    const { topology } = build();
    const none = { expanded: new Set<string>(), history: new Set<string>() };
    expect(visibleGraph(topology, none, { problemsOnly: true }).groups.map((g) => g.id)).toEqual(["shop/web"]);
    expect(visibleGraph(topology, none, { namespaces: ["other"] }).nodes).toEqual([]);
    expect(visibleGraph(topology, none, { labels: "app=calm" }).groups.map((g) => g.id)).toEqual(["shop/calm"]);
    expect(
      visibleGraph(topology, none, { hiddenCategories: ["config", "storage", "identity"] }).nodes.every(
        (node) => node.category === "workload"
      )
    ).toBe(true);
    expect(visibleGraph(topology, none, { showUnused: true }).nodes.map((n) => n.name)).toContain("leftover");
  });
});

describe("traceNeighbourhood", () => {
  test("follows paths upstream and downstream, not sideways", () => {
    const edges = [
      { id: "1", source: "ing", target: "svc", type: "routes" as const },
      { id: "2", source: "svc", target: "dep", type: "routes" as const },
      { id: "3", source: "dep", target: "cm", type: "mounts" as const },
      { id: "4", source: "other", target: "cm", type: "mounts" as const },
      { id: "5", source: "hpa", target: "dep", type: "scales" as const },
    ];
    const fromSvc = traceNeighbourhood(edges, "svc");
    expect([...fromSvc.nodes].sort()).toEqual(["cm", "dep", "ing", "svc"]);
    expect([...fromSvc.edges].sort()).toEqual(["1", "2", "3"]);
    const fromDep = traceNeighbourhood(edges, "dep");
    expect([...fromDep.nodes].sort()).toEqual(["cm", "dep", "hpa", "ing", "svc"]);
  });
});

describe("summary and signature", () => {
  test("counts apps by health, ignoring shared / unused groups", () => {
    expect(
      summarize([
        { id: "a", name: "a", namespace: "x", type: "app", nodeIds: [], health: "ok" },
        { id: "b", name: "b", namespace: "x", type: "app", nodeIds: [], health: "warning" },
        { id: "c", name: "c", namespace: "x", type: "app", nodeIds: [], health: "error" },
        { id: "d", name: "d", namespace: "x", type: "app", nodeIds: [], health: "neutral" },
        { id: "e", name: "e", namespace: "x", type: "shared", nodeIds: [], health: "error" },
      ])
    ).toEqual({ apps: 4, healthy: 2, degraded: 1, failing: 1 });
  });

  test("the signature ignores order and health", () => {
    const { dep, rs, pods } = webApp();
    const a = buildTopology([dep, rs, ...pods]);
    const none = { expanded: new Set<string>(), history: new Set<string>() };
    const graphA = visibleGraph(a, none);
    const reversed = visibleGraph(buildTopology([...pods, rs, dep].reverse()), none);
    expect(topologySignature(graphA.nodes, graphA.edges)).toBe(
      topologySignature(reversed.nodes, reversed.edges)
    );
  });
});

describe("selectGraphResources", () => {
  test("picks the graphed resources by group and keeps the canonical order", () => {
    const discovered = [
      { name: "certificates", group: "cert-manager.io", kind: "Certificate" },
      { name: "deployments", group: "apps", kind: "Deployment" },
      { name: "pods", group: "", kind: "Pod" },
      { name: "gateways", group: "networking.istio.io", kind: "Gateway" },
      { name: "gateways", group: "gateway.networking.k8s.io", kind: "Gateway" },
    ];
    expect(selectGraphResources(discovered).map((r) => `${r.name}.${r.group}`)).toEqual([
      "pods.",
      "deployments.apps",
      "gateways.gateway.networking.k8s.io",
    ]);
  });
});

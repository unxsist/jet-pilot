import { describe, expect, test } from "vitest";
import { describeCron, isTimeZone, nextCronRun, parseCron } from "../../src/lib/resources/cron";
import {
  diffEntries,
  diffTaints,
  editErrorMessage,
  metadataPatch,
  pointerSegment,
  taintsPatch,
  validateKey,
  validateLabelValue,
  validateTaint,
} from "../../src/lib/resources/metadataEdit";
import {
  containerProbes,
  ownerOf,
  podState,
  podUses,
  probeWords,
  resolveOwners,
  schedulingWords,
  tolerationWords,
} from "../../src/lib/resources/pod";
import { nodeAllocation, nodeHealth, nodePlacement, nodeRoles } from "../../src/lib/resources/node";
import { httpRoutesFor, ingressRoutes, ingressesFor, portMapping, serviceEndpoints } from "../../src/lib/resources/network";
import { hpaConditionWords, hpaMetrics } from "../../src/lib/resources/autoscaling";
import { limitRangeLines, quotaLines } from "../../src/lib/resources/quota";
import { detectFormat, highlight, prettyJson, sizeWords } from "../../src/lib/resources/highlight";
import { objectState } from "../../src/lib/resources/state";
import { describeObject, describeStrings, describeText, matchStarts } from "../../src/lib/resources/describe";
import { accessModeWords, podsUsingClaim } from "../../src/lib/resources/storage";
import { refPath, watchResource, KINDS } from "../../src/lib/resources/kinds";
import { conditionHealthy } from "../../src/lib/resources/conditions";
import { durationWords } from "../../src/lib/resources/format";

const NOW = Date.UTC(2026, 9, 15, 10, 30); // Thursday 15 October 2026, 10:30 UTC
const ago = (seconds: number) => new Date(NOW - seconds * 1000).toISOString();

/* ------------------------------------------------------------- cron -- */

describe("cron schedules", () => {
  test("parses fields, names, steps, ranges and macros", () => {
    expect(parseCron("*/15 9-17 * * MON-FRI")).toMatchObject({
      minutes: [0, 15, 30, 45],
      hours: [9, 10, 11, 12, 13, 14, 15, 16, 17],
      weekdays: [1, 2, 3, 4, 5],
      anyDay: true,
      anyWeekday: false,
    });
    expect(parseCron("@daily")).toMatchObject({ minutes: [0], hours: [0] });
    expect(parseCron("0 0 * * 7")?.weekdays).toEqual([0]);
    expect(parseCron("5/20 * * * *")?.minutes).toEqual([5, 25, 45]);
    expect(parseCron("0 0 1 JAN,jul *")?.months).toEqual([1, 7]);
    expect(parseCron("61 * * * *")).toBeNull();
    expect(parseCron("* * * *")).toBeNull();
    expect(parseCron("*/0 * * * *")).toBeNull();
  });

  test("says common schedules in words", () => {
    expect(describeCron("* * * * *")).toBe("Every minute");
    expect(describeCron("*/5 * * * *")).toBe("Every 5 minutes");
    expect(describeCron("0 * * * *")).toBe("Every hour");
    expect(describeCron("15 * * * *")).toBe("Every hour at :15");
    expect(describeCron("0 */2 * * *")).toBe("Every 2 hours");
    expect(describeCron("0 2 * * *")).toBe("Every day at 02:00");
    expect(describeCron("@daily")).toBe("Every day at 00:00");
    expect(describeCron("30 1 * * *")).toBe("Every day at 01:30");
    expect(describeCron("0 8,20 * * *")).toBe("Every day at 08:00 and 20:00");
    expect(describeCron("0 9 * * 1-5")).toBe("Weekdays at 09:00");
    expect(describeCron("0 10 * * 0,6")).toBe("Weekends at 10:00");
    expect(describeCron("30 18 * * 1,4")).toBe("Every Monday and Thursday at 18:30");
    expect(describeCron("0 0 1 * *")).toBe("On the 1st of every month at 00:00");
    expect(describeCron("0 0 1,15 * *")).toBe("On the 1st and 15th of every month at 00:00");
    expect(describeCron("@yearly")).toBe("Every year on 1 January at 00:00");
    expect(describeCron("*/15 9-17 * * 1-5")).toBe("Every 15 minutes from 09:00 to 17:59 on weekdays");
    expect(describeCron("0 * * * 0")).toBe("Every hour on Sunday");
    // Day of month and day of week both set: no short way to say it.
    expect(describeCron("0 0 13 * 5")).toBeNull();
    expect(describeCron("not a schedule")).toBeNull();
  });

  test("finds the next run in UTC", () => {
    const next = (expression: string, from = NOW) => new Date(nextCronRun(expression, from)!).toISOString();
    expect(next("*/5 * * * *")).toBe("2026-10-15T10:35:00.000Z");
    expect(next("0 */2 * * *")).toBe("2026-10-15T12:00:00.000Z");
    expect(next("0 2 * * *")).toBe("2026-10-16T02:00:00.000Z");
    expect(next("0 9 * * 1-5", Date.UTC(2026, 9, 16, 12))).toBe("2026-10-19T09:00:00.000Z"); // Friday → Monday
    expect(next("0 0 1 * *")).toBe("2026-11-01T00:00:00.000Z");
    // Either the day or the weekday when both are set.
    expect(next("0 0 13 * 5")).toBe("2026-10-16T00:00:00.000Z");
    expect(nextCronRun("0 0 31 2 *", NOW)).toBeNull();
  });

  test("finds the next run in a time zone, skipping times DST jumps over", () => {
    // 02:00 in Amsterdam is 00:00 UTC in summer time (until 25 October).
    expect(new Date(nextCronRun("0 2 * * *", NOW, "Europe/Amsterdam")!).toISOString()).toBe("2026-10-16T00:00:00.000Z");
    // 29 March 2026: clocks jump from 02:00 to 03:00, 02:30 doesn't exist.
    const from = Date.UTC(2026, 2, 28, 12);
    expect(new Date(nextCronRun("30 2 * * *", from, "Europe/Amsterdam")!).toISOString()).toBe("2026-03-30T00:30:00.000Z");
    expect(isTimeZone("Europe/Amsterdam")).toBe(true);
    expect(isTimeZone("Mars/Olympus")).toBe(false);
    expect(nextCronRun("0 2 * * *", NOW, "Mars/Olympus")).toBeNull();
  });
});

/* ---------------------------------------------------- inline edits -- */

describe("label, annotation and taint edits", () => {
  test("validates keys like the API server", () => {
    expect(validateKey("app")).toBeNull();
    expect(validateKey("app.kubernetes.io/name")).toBeNull();
    expect(validateKey("example.com/Team_Name.1")).toBeNull();
    expect(validateKey("")).toBe("Enter a key");
    expect(validateKey("Cost Center")).toMatch(/spaces/);
    expect(validateKey("/name")).toMatch(/prefix/);
    expect(validateKey("Example.com/name")).toMatch(/lowercase DNS/);
    expect(validateKey("a/b/c")).toMatch(/at most one/);
    expect(validateKey("example.com/")).toMatch(/name after/);
    expect(validateKey("-name")).toMatch(/starting and ending/);
    expect(validateKey(`${"a".repeat(64)}`)).toMatch(/63/);
    expect(validateKey(`${"a".repeat(250)}.com/x`)).toMatch(/253/);
  });

  test("validates label values", () => {
    expect(validateLabelValue("")).toBeNull();
    expect(validateLabelValue("v1.2_3-a")).toBeNull();
    expect(validateLabelValue("has space")).toMatch(/leave it empty/);
    expect(validateLabelValue("x".repeat(64))).toMatch(/63/);
  });

  test("diffs entries and builds a merge patch for additions and changes", () => {
    const changes = diffEntries({ app: "web", tier: "backend" }, { app: "web", tier: "api", team: "payments" });
    expect(changes).toEqual([
      { type: "add", key: "team", after: "payments" },
      { type: "change", key: "tier", before: "backend", after: "api" },
    ]);
    expect(metadataPatch("labels", changes)).toEqual({
      type: "merge",
      body: { metadata: { labels: { team: "payments", tier: "api" } } },
    });
    expect(metadataPatch("labels", [])).toBeNull();
  });

  test("removals are a JSON patch that tests what it read, with / escaped", () => {
    expect(pointerSegment("app.kubernetes.io/name")).toBe("app.kubernetes.io~1name");
    expect(pointerSegment("a~b")).toBe("a~0b");
    const changes = diffEntries(
      { "app.kubernetes.io/version": "2.14.3", tier: "backend" },
      { tier: "api", team: "payments" }
    );
    expect(metadataPatch("labels", changes)).toEqual({
      type: "json",
      body: [
        { op: "test", path: "/metadata/labels/app.kubernetes.io~1version", value: "2.14.3" },
        { op: "remove", path: "/metadata/labels/app.kubernetes.io~1version" },
        { op: "add", path: "/metadata/labels/team", value: "payments" },
        { op: "test", path: "/metadata/labels/tier", value: "backend" },
        { op: "replace", path: "/metadata/labels/tier", value: "api" },
      ],
    });
  });

  test("taints: validation, diff and a guarded JSON patch", () => {
    const before = [{ key: "workload", value: "batch", effect: "PreferNoSchedule" }];
    expect(validateTaint({ key: "dedicated", value: "gpu", effect: "NoSchedule" }, before)).toBeNull();
    expect(validateTaint({ key: "workload", effect: "PreferNoSchedule" }, before)).toMatch(/already/);
    expect(validateTaint({ key: "x", effect: "Sometimes" }, [])).toMatch(/effect/);
    expect(validateTaint({ key: "bad key", effect: "NoSchedule" }, [])).toMatch(/spaces/);

    const after = [...before, { key: "dedicated", value: "gpu", effect: "NoExecute" }];
    expect(diffTaints(before, after)).toEqual([{ type: "add", key: "dedicated:NoExecute", after: "gpu" }]);
    expect(taintsPatch(before, after)).toEqual([
      { op: "test", path: "/spec/taints", value: before },
      {
        op: "replace",
        path: "/spec/taints",
        value: [
          { key: "workload", value: "batch", effect: "PreferNoSchedule" },
          { key: "dedicated", value: "gpu", effect: "NoExecute" },
        ],
      },
    ]);
    expect(taintsPatch(undefined, [{ key: "a", effect: "NoSchedule" }])).toEqual([
      { op: "add", path: "/spec/taints", value: [{ key: "a", effect: "NoSchedule" }] },
    ]);
    expect(taintsPatch(before, [])).toEqual([
      { op: "test", path: "/spec/taints", value: before },
      { op: "remove", path: "/spec/taints" },
    ]);
    expect(taintsPatch(before, before)).toBeNull();
  });

  test("API errors in a sentence", () => {
    expect(editErrorMessage({ code: 422, message: "testing value /metadata/labels/a failed" }, "labels")).toMatch(/changed while you were editing/);
    expect(editErrorMessage({ code: 409, message: "Operation cannot be fulfilled" }, "labels")).toMatch(/changed/);
    expect(editErrorMessage({ code: 403, message: "forbidden" }, "taints")).toBe("You don't have permission to change the taints of this object.");
    expect(
      editErrorMessage({ code: 422, message: 'Deployment.apps "x" is invalid: metadata.labels: Invalid value: "-a"' }, "labels")
    ).toBe('metadata.labels: Invalid value: "-a"');
  });
});

/* -------------------------------------------------------------- pods -- */

const container = (overrides: any = {}) => ({ name: "api", image: "acme/api:1", resources: { limits: { memory: "256Mi" } }, ...overrides });

describe("pods in words", () => {
  test("crash loops say the exit code and when", () => {
    const pod = {
      spec: { containers: [container()] },
      status: {
        phase: "Running",
        containerStatuses: [
          {
            name: "api",
            ready: false,
            restartCount: 14,
            state: { waiting: { reason: "CrashLoopBackOff" } },
            lastState: { terminated: { exitCode: 1, reason: "Error", finishedAt: ago(180) } },
          },
        ],
      },
    };
    expect(podState(pod, NOW)).toEqual({
      label: "Restarting",
      tone: "destructive",
      detail: "The container keeps crashing: it exits with code 1, last 3m ago. 14 restarts so far.",
    });
  });

  test("out of memory names the limit; several containers are named", () => {
    const pod = {
      spec: { containers: [container(), container({ name: "proxy" })] },
      status: {
        phase: "Running",
        containerStatuses: [
          { name: "api", ready: false, restartCount: 3, state: { terminated: { exitCode: 137, reason: "OOMKilled", finishedAt: ago(120) } } },
          { name: "proxy", ready: true, state: { running: {} } },
        ],
      },
    };
    expect(podState(pod, NOW).detail).toBe("api was killed for using more memory than its 256Mi limit, 2m ago. 3 restarts so far.");
  });

  test("pending, running, not ready, completed, terminating", () => {
    expect(
      podState({ status: { phase: "Pending", conditions: [{ type: "PodScheduled", status: "False", message: "0/4 nodes are available." }] } }, NOW)
    ).toMatchObject({ label: "Can't be scheduled", detail: "0/4 nodes are available." });
    expect(
      podState({ spec: { containers: [container()] }, status: { phase: "Running", startTime: ago(60), containerStatuses: [{ name: "api", ready: true, state: { running: {} } }] } }, NOW)
    ).toMatchObject({ label: "Running", tone: "success" });
    expect(
      podState({ spec: { containers: [container({ readinessProbe: {} })] }, status: { phase: "Running", containerStatuses: [{ name: "api", ready: false, state: { running: {} } }] } }, NOW).detail
    ).toMatch(/readiness probe/);
    expect(
      podState({ spec: { containers: [container()] }, status: { phase: "Succeeded", startTime: ago(100), containerStatuses: [{ name: "api", state: { terminated: { exitCode: 0, finishedAt: ago(60) } } }] } }, NOW)
    ).toMatchObject({ label: "Completed", detail: "Finished 1m ago, after 40s." });
    expect(podState({ metadata: { deletionTimestamp: ago(-20) }, status: { phase: "Running" } }, NOW).label).toBe("Terminating");
    expect(podState({ metadata: { deletionTimestamp: ago(600) }, status: { phase: "Running" } }, NOW).label).toBe("Stuck terminating");
    expect(
      podState({ spec: { containers: [container()] }, status: { phase: "Pending", containerStatuses: [{ name: "api", image: "acme/api:2", state: { waiting: { reason: "ImagePullBackOff" } } }] } }, NOW)
    ).toMatchObject({ label: "Can't pull the image", detail: expect.stringContaining("acme/api:2") });
  });

  test("what a pod uses: claims, config and secrets with where they go", () => {
    const pod = {
      metadata: { namespace: "shop" },
      spec: {
        imagePullSecrets: [{ name: "registry" }],
        volumes: [
          { name: "kube-api-access-x1", projected: { sources: [{ serviceAccountToken: {} }] } },
          { name: "config", configMap: { name: "app-config" } },
          { name: "data", persistentVolumeClaim: { claimName: "data-0" } },
          { name: "tmp", emptyDir: { medium: "Memory" } },
        ],
        containers: [
          {
            name: "api",
            volumeMounts: [{ name: "config", mountPath: "/etc/app", readOnly: true }, { name: "data", mountPath: "/data" }],
            envFrom: [{ configMapRef: { name: "app-config" } }],
            env: [{ name: "DB_PASSWORD", valueFrom: { secretKeyRef: { name: "db", key: "password" } } }],
          },
        ],
      },
    };
    const uses = podUses(pod);
    expect(uses.map((u) => `${u.kind}:${u.title}`)).toEqual([
      "PersistentVolumeClaim:data-0",
      "ConfigMap:app-config",
      "Secret:db",
      "Secret:registry",
      "emptyDir:Scratch space in memory",
    ]);
    expect(uses[1]!.how).toEqual(["Mounted at /etc/app (read-only)", "As environment variables"]);
    expect(uses[2]!.how).toEqual(["Key password as DB_PASSWORD"]);
    expect(uses[3]!.how).toEqual(["To pull images"]);
    expect(uses[0]!.ref).toEqual({ kind: "PersistentVolumeClaim", name: "data-0", namespace: "shop" });
  });

  test("scheduling and tolerations in sentences, default tolerations left out", () => {
    const words = schedulingWords({
      nodeSelector: { "kubernetes.io/arch": "arm64" },
      affinity: {
        nodeAffinity: {
          requiredDuringSchedulingIgnoredDuringExecution: {
            nodeSelectorTerms: [{ matchExpressions: [{ key: "topology.kubernetes.io/zone", operator: "In", values: ["eu-west-1a", "eu-west-1b"] }] }],
          },
        },
        podAntiAffinity: {
          requiredDuringSchedulingIgnoredDuringExecution: [{ topologyKey: "kubernetes.io/hostname", labelSelector: { matchLabels: { app: "web" } } }],
        },
      },
      topologySpreadConstraints: [{ maxSkew: 1, topologyKey: "topology.kubernetes.io/zone", whenUnsatisfiable: "ScheduleAnyway" }],
      tolerations: [
        { key: "node.kubernetes.io/not-ready", operator: "Exists", effect: "NoExecute", tolerationSeconds: 300 },
        { key: "dedicated", operator: "Equal", value: "gpu", effect: "NoSchedule" },
        { operator: "Exists" },
      ],
    });
    expect(words.rules).toEqual([
      "Only on nodes where architecture is arm64",
      "Only on nodes where zone is eu-west-1a or eu-west-1b",
      "Never on the same node as pods with app=web",
      "Spread across zones, at most 1 apart when possible",
    ]);
    expect(words.tolerations).toEqual(["Tolerates dedicated=gpu:NoSchedule", "Tolerates every taint"]);
    expect(tolerationWords({ key: "node.kubernetes.io/unreachable", operator: "Exists", effect: "NoExecute", tolerationSeconds: 30 })).toBe(
      "Tolerates node.kubernetes.io/unreachable:NoExecute for 30s"
    );
  });

  test("probes in words", () => {
    expect(probeWords({ httpGet: { path: "/healthz", port: 8080 }, initialDelaySeconds: 10 }, "Liveness")).toEqual({
      type: "Liveness",
      check: "HTTP GET /healthz on port 8080",
      timing: "Every 10s, from 10s after start; 3 failures in a row restart it",
    });
    expect(probeWords({ tcpSocket: { port: "pg" }, periodSeconds: 5, failureThreshold: 1 }, "Readiness").timing).toBe(
      "Every 5s; 1 failure in a row take it out of its Services"
    );
    expect(probeWords({ exec: { command: ["cat", "/tmp/ok"] }, periodSeconds: 5, failureThreshold: 24 }, "Startup")).toMatchObject({
      check: "Runs cat /tmp/ok",
      timing: "Every 5s; it has 2m to start",
    });
    expect(containerProbes({ readinessProbe: { grpc: { port: 9000 } }, startupProbe: { httpGet: { port: 1 } } }).map((p) => p.type)).toEqual([
      "Startup",
      "Readiness",
    ]);
  });

  test("owner chains: controller first, fetched level by level", async () => {
    const pod = { metadata: { namespace: "shop", ownerReferences: [{ kind: "ReplicaSet", name: "web-7d9", controller: true }] } };
    expect(ownerOf(pod)).toEqual({ kind: "ReplicaSet", name: "web-7d9", namespace: "shop", apiVersion: undefined });
    const objects: Record<string, any> = {
      "ReplicaSet/web-7d9": { metadata: { namespace: "shop", ownerReferences: [{ kind: "Deployment", name: "web", controller: true }] } },
      "Deployment/web": { metadata: { namespace: "shop" } },
    };
    const chain = await resolveOwners(pod, async (ref) => objects[`${ref.kind}/${ref.name}`] ?? null);
    expect(chain.map((r) => `${r.kind}/${r.name}`)).toEqual(["ReplicaSet/web-7d9", "Deployment/web"]);
    // A failing fetch ends the chain after the owner it couldn't read.
    const partial = await resolveOwners(pod, async () => {
      throw new Error("forbidden");
    });
    expect(partial.map((r) => r.kind)).toEqual(["ReplicaSet"]);
  });
});

/* ------------------------------------------------------------- nodes -- */

describe("nodes", () => {
  const node = {
    metadata: {
      name: "n1",
      labels: {
        "node-role.kubernetes.io/control-plane": "",
        "kubernetes.io/role": "infra",
        "topology.kubernetes.io/zone": "eu-west-1a",
        "node.kubernetes.io/instance-type": "m6i.large",
        "karpenter.sh/capacity-type": "spot",
        "karpenter.sh/nodepool": "general",
      },
    },
    status: {
      capacity: { cpu: "4", memory: "16Gi", pods: "110" },
      allocatable: { cpu: "3900m", memory: "15Gi", pods: "110" },
      conditions: [
        { type: "Ready", status: "True" },
        { type: "DiskPressure", status: "True", message: "disk full" },
        { type: "MemoryPressure", status: "False" },
        { type: "KernelDeadlock", status: "True" },
      ],
    },
  };

  test("health, roles and placement", () => {
    expect(nodeHealth(node)).toMatchObject({
      ready: "True",
      problems: [
        { type: "DiskPressure", label: "Disk pressure", message: "disk full" },
        { type: "KernelDeadlock", label: "Kernel Deadlock" },
      ],
    });
    expect(nodeRoles(node.metadata.labels)).toEqual(["control-plane", "infra"]);
    expect(nodePlacement(node.metadata.labels)).toEqual({
      zone: "eu-west-1a",
      region: undefined,
      instanceType: "m6i.large",
      capacityType: "Spot",
      pool: "general",
    });
  });

  test("requests of the pods on it, the largest init container counted once", () => {
    const pods = [
      { spec: { nodeName: "n1", containers: [{ resources: { requests: { cpu: "500m", memory: "1Gi" }, limits: { cpu: "1" } } }] }, status: { phase: "Running" } },
      {
        spec: {
          nodeName: "n1",
          initContainers: [{ resources: { requests: { cpu: "2", memory: "64Mi" } } }],
          containers: [{ resources: { requests: { cpu: "250m", memory: "128Mi" } } }],
        },
        status: { phase: "Running" },
      },
      { spec: { nodeName: "n1", containers: [{ resources: { requests: { cpu: "4" } } }] }, status: { phase: "Succeeded" } },
      { spec: { nodeName: "n2", containers: [{ resources: { requests: { cpu: "4" } } }] }, status: { phase: "Running" } },
    ];
    const a = nodeAllocation(node, pods);
    expect(a.cpu).toEqual({ capacity: 4000, allocatable: 3900, requested: 2500, limits: 1000 });
    expect(a.memory.requested).toBe(1024 ** 3 + 128 * 1024 ** 2);
    expect(a.pods).toMatchObject({ allocatable: 110, requested: 2 });
  });
});

/* -------------------------------------------------- services, ingress -- */

describe("services and routes", () => {
  const service = { metadata: { name: "web", namespace: "shop" } };

  test("endpoints from EndpointSlices, deduplicated", () => {
    const slices = [
      {
        metadata: { namespace: "shop", labels: { "kubernetes.io/service-name": "web" } },
        endpoints: [
          { addresses: ["10.0.0.1"], conditions: { ready: true }, targetRef: { kind: "Pod", name: "web-a", uid: "a" } },
          { addresses: ["10.0.0.2"], conditions: { ready: false }, targetRef: { kind: "Pod", name: "web-b", uid: "b" } },
          { addresses: ["10.0.0.3"], conditions: { terminating: true }, targetRef: { kind: "Pod", name: "web-c", uid: "c" } },
          { addresses: ["10.0.0.4"], conditions: {} },
        ],
      },
      { metadata: { namespace: "shop", labels: { "kubernetes.io/service-name": "web" } }, endpoints: [{ addresses: ["10.0.0.1"], targetRef: { uid: "a" } }] },
      { metadata: { namespace: "shop", labels: { "kubernetes.io/service-name": "other" } }, endpoints: [{ addresses: ["10.9.9.9"] }] },
    ];
    expect(serviceEndpoints(service, slices).map((e) => [e.addresses[0], e.ready, e.terminating])).toEqual([
      ["10.0.0.1", true, false],
      ["10.0.0.2", false, false],
      ["10.0.0.3", false, true],
      ["10.0.0.4", true, false],
    ]);
    expect(portMapping({ port: 80, targetPort: 8080 })).toBe("80 → 8080");
    expect(portMapping({ port: 53, targetPort: 53 })).toBe("53");
  });

  test("ingress rules and the routes pointing at a Service", () => {
    const ingress = {
      metadata: { namespace: "shop" },
      spec: {
        rules: [
          { host: "shop.dev", http: { paths: [{ path: "/", backend: { service: { name: "web", port: { number: 80 } } } }] } },
          { http: { paths: [{ path: "/api", backend: { service: { name: "api", port: { name: "http" } } } }] } },
        ],
        defaultBackend: { resource: { kind: "Bucket", name: "static" } },
      },
    };
    expect(ingressRoutes(ingress)).toEqual([
      { host: "shop.dev", path: "/", pathType: undefined, service: "web", port: "80" },
      { host: "*", path: "/api", pathType: undefined, service: "api", port: "http" },
      { host: "*", path: "Everything else", resource: "Bucket static" },
    ]);
    expect(ingressesFor(service, [ingress, { ...ingress, metadata: { namespace: "other" } }])).toHaveLength(1);
    const route = { metadata: { namespace: "shop" }, spec: { rules: [{ backendRefs: [{ name: "web", port: 80 }] }] } };
    const elsewhere = { metadata: { namespace: "edge" }, spec: { rules: [{ backendRefs: [{ name: "web", namespace: "shop" }] }] } };
    const notService = { metadata: { namespace: "shop" }, spec: { rules: [{ backendRefs: [{ name: "web", kind: "ServiceImport", group: "multicluster.x-k8s.io" }] }] } };
    expect(httpRoutesFor(service, [route, elsewhere, notService])).toEqual([route, elsewhere]);
  });
});

/* ------------------------------------------------- autoscaling, quota -- */

describe("autoscalers and quotas", () => {
  test("metrics current against target", () => {
    const hpa = {
      spec: {
        minReplicas: 2,
        maxReplicas: 10,
        metrics: [
          { type: "Resource", resource: { name: "cpu", target: { type: "Utilization", averageUtilization: 70 } } },
          { type: "Resource", resource: { name: "memory", target: { type: "AverageValue", averageValue: "400Mi" } } },
          { type: "Pods", pods: { metric: { name: "http_requests_per_second" }, target: { type: "AverageValue", averageValue: "100" } } },
          { type: "External", external: { metric: { name: "queue_depth" }, target: { type: "Value", value: "30" } } },
        ],
      },
      status: {
        currentMetrics: [
          { type: "Resource", resource: { name: "cpu", current: { averageUtilization: 63 } } },
          { type: "Resource", resource: { name: "memory", current: { averageValue: "312Mi" } } },
          { type: "Pods", pods: { metric: { name: "http_requests_per_second" }, current: { averageValue: "84500m" } } },
        ],
        conditions: [
          { type: "AbleToScale", status: "True" },
          { type: "ScalingLimited", status: "True", reason: "TooManyReplicas", message: "the desired count is more than the maximum" },
        ],
      },
    };
    expect(hpaMetrics(hpa).map((m) => [m.label, m.currentText, m.targetText])).toEqual([
      ["CPU", "63%", "70%"],
      ["Memory", "312 MiB", "400 MiB"],
      ["HTTP requests per second", "84.5", "100"],
      ["Queue depth", "–", "30"],
    ]);
    expect(hpaConditionWords(hpa)).toEqual([
      { type: "AbleToScale", ok: true, text: "Can change the replicas", message: undefined },
      { type: "ScalingLimited", ok: false, text: "Held at its maximum of 10", message: "The desired count is more than the maximum" },
    ]);
    expect(hpaMetrics({ spec: { targetCPUUtilizationPercentage: 80 }, status: { currentCPUUtilizationPercentage: 50 } })[0]).toMatchObject({
      currentText: "50%",
      targetText: "80%",
    });
  });

  test("quota lines, fullest first, and limit ranges in words", () => {
    const lines = quotaLines({
      status: {
        hard: { "requests.cpu": "8", "limits.memory": "32Gi", pods: "40", "count/deployments.apps": "20" },
        used: { "requests.cpu": "2650m", "limits.memory": "29Gi", pods: "12" },
      },
    });
    expect(lines.map((l) => [l.label, l.usedText, l.hardText])).toEqual([
      ["Memory limits", "29 GiB", "32 GiB"],
      ["CPU requests", "2.65 cores", "8 cores"],
      ["Pods", "12", "40"],
      ["Deployments", "0", "20"],
    ]);
    expect(
      limitRangeLines({
        spec: {
          limits: [
            { type: "Container", defaultRequest: { cpu: "100m", memory: "128Mi" }, max: { cpu: "2" } },
            { type: "PersistentVolumeClaim", max: { storage: "100Gi" } },
          ],
        },
      })
    ).toEqual([
      { type: "Containers", lines: [{ label: "Default request", value: "100m CPU, 128 MiB memory" }, { label: "At most", value: "2 cores CPU" }] },
      { type: "Volume claims", lines: [{ label: "At most", value: "100 GiB" }] },
    ]);
  });
});

/* ---------------------------------------------------------- values -- */

describe("values and storage", () => {
  test("JSON and YAML are recognised and coloured", () => {
    expect(detectFormat('{"a":1}')).toBe("json");
    expect(detectFormat("[1, 2]", "list.json")).toBe("json");
    expect(detectFormat("{ not json")).toBe("text");
    expect(detectFormat("server:\n  port: 8080\n")).toBe("yaml");
    expect(detectFormat("anything", "values.yaml")).toBe("yaml");
    expect(detectFormat("info")).toBe("text");
    expect(prettyJson('{"a":[1]}')).toBe('{\n  "a": [\n    1\n  ]\n}');
    expect(highlight('{"a":true}', "json")[1]).toEqual([
      { text: "  ", kind: "text" },
      { text: '"a"', kind: "key" },
      { text: ":", kind: "punctuation" },
      { text: " ", kind: "text" },
      { text: "true", kind: "literal" },
    ]);
    expect(highlight("# c\nport: 80 # web", "yaml")).toEqual([
      [{ text: "", kind: "text" }, { text: "# c", kind: "comment" }],
      [
        { text: "", kind: "punctuation" },
        { text: "port", kind: "key" },
        { text: ":", kind: "punctuation" },
        { text: " ", kind: "text" },
        { text: "80", kind: "literal" },
        { text: " # web", kind: "comment" },
      ],
    ]);
    expect(sizeWords("x".repeat(2048))).toBe("2.0 KiB");
  });

  test("access modes and the pods using a claim", () => {
    expect(accessModeWords(["ReadWriteOnce", "ReadOnlyMany"])).toBe("Read-write by one node, Read-only by many nodes");
    const claim = { metadata: { name: "data-0", namespace: "db" } };
    const pods = [
      { metadata: { name: "pg-0", namespace: "db" }, spec: { volumes: [{ persistentVolumeClaim: { claimName: "data-0" } }] } },
      { metadata: { name: "pg-1", namespace: "db" }, spec: { volumes: [{ persistentVolumeClaim: { claimName: "data-1" } }] } },
      { metadata: { name: "data", namespace: "db" }, spec: { volumes: [{ name: "0", ephemeral: {} }] } },
    ];
    expect(podsUsingClaim(claim, pods).map((p) => p.metadata.name)).toEqual(["pg-0", "data"]);
  });

  test("kinds, paths and conditions", () => {
    expect(watchResource(KINDS.Deployment!)).toBe("deployments.apps");
    expect(watchResource(KINDS.Pod!)).toBe("pods");
    expect(refPath({ kind: "Node", name: "n1", namespace: "ignored" })).toBe("/api/v1/nodes/n1");
    expect(refPath({ kind: "HorizontalPodAutoscaler", name: "web", namespace: "shop", apiVersion: "autoscaling/v1" })).toBe(
      "/apis/autoscaling/v1/namespaces/shop/horizontalpodautoscalers/web"
    );
    expect(refPath({ kind: "Widget", name: "x" })).toBeNull();
    expect(conditionHealthy({ type: "Ready", status: "True" })).toBe(true);
    expect(conditionHealthy({ type: "DiskPressure", status: "True" })).toBe(false);
    expect(conditionHealthy({ type: "ReplicaFailure", status: "True" })).toBe(false);
    expect(conditionHealthy({ type: "Ready", status: "Unknown" })).toBe(true);
    expect(durationWords(3_725_000)).toBe("1h 2m");
    expect(durationWords(9 * 86_400_000)).toBe("9d");
  });
});

/* ------------------------------------------------- state, describe -- */

describe("states and the native describe", () => {
  test("states per kind", () => {
    expect(objectState({ kind: "ConfigMap" }, NOW)).toBeNull();
    expect(objectState({ kind: "Namespace", status: { phase: "Active" } }, NOW)).toBeNull();
    expect(objectState({ kind: "Deployment", spec: { replicas: 3 }, status: { readyReplicas: 1, updatedReplicas: 3 } }, NOW)).toMatchObject({
      label: "Degraded",
      detail: "1 of 3 replicas ready.",
    });
    expect(objectState({ kind: "Deployment", spec: { replicas: 3 }, status: { readyReplicas: 3, updatedReplicas: 3 } }, NOW)?.label).toBe("Available");
    expect(objectState({ kind: "Deployment", spec: { replicas: 0 }, status: {} }, NOW)?.label).toBe("Scaled to zero");
    expect(
      objectState({ kind: "Job", spec: { backoffLimit: 2 }, status: { failed: 3, conditions: [{ type: "Failed", status: "True", reason: "BackoffLimitExceeded" }] } }, NOW)
    ).toMatchObject({ label: "Failed", detail: "It failed 3 times and gave up (backoff limit 2)." });
    expect(
      objectState({ kind: "CronJob", spec: { schedule: "0 */2 * * *" }, status: { lastScheduleTime: ago(3600), lastSuccessfulTime: ago(3500) } }, NOW)
    ).toEqual({ label: "Scheduled", tone: "success", detail: "Next run in 1h 30m." });
    expect(
      objectState({ kind: "CronJob", spec: { schedule: "@hourly" }, status: { lastScheduleTime: ago(600), lastSuccessfulTime: ago(4200) } }, NOW)?.label
    ).toBe("Last run failed");
    expect(objectState({ kind: "Node", spec: { unschedulable: true }, status: { conditions: [{ type: "Ready", status: "True" }] } }, NOW)?.label).toBe("Cordoned");
    expect(objectState({ kind: "Node", status: { conditions: [{ type: "Ready", status: "Unknown" }] } }, NOW)?.label).toBe("Not responding");
    expect(objectState({ kind: "PersistentVolumeClaim", status: { phase: "Pending" } }, NOW)?.label).toBe("Pending");
    expect(objectState({ kind: "Service", spec: { type: "LoadBalancer" }, status: {} }, NOW)?.label).toBe("Waiting for a load balancer");
  });

  test("a pod as a document, as text and searchable", () => {
    const pod = {
      kind: "Pod",
      metadata: { name: "web-1", namespace: "shop", creationTimestamp: ago(3600), labels: { app: "web" } },
      spec: { nodeName: "n1", containers: [container({ ports: [{ containerPort: 8080 }] })] },
      status: { phase: "Running", podIP: "10.0.0.5", containerStatuses: [{ name: "api", ready: true, restartCount: 0, state: { running: { startedAt: ago(60) } } }] },
    };
    const doc = describeObject(pod, {
      now: NOW,
      owners: [{ kind: "ReplicaSet", name: "web-7d9", namespace: "shop" }, { kind: "Deployment", name: "web", namespace: "shop" }],
      events: [{ type: "Warning", reason: "Unhealthy", message: "Readiness probe failed", count: 2, lastTimestamp: ago(30), source: { component: "kubelet" } }],
    });
    expect(doc.state?.label).toBe("Running");
    expect(doc.sections.map((s) => s.title)).toEqual(["Overview", "Container api", "Scheduling", "Events", "Labels", "Annotations"]);
    const overview = doc.sections[0]!.rows!;
    const controlled = overview.find((r) => r.label === "Controlled by")!;
    expect(controlled.values.map((value) => value.text)).toEqual(["Deployment web", "ReplicaSet web-7d9"]);
    expect(controlled.values[0]!.ref).toEqual({ kind: "Deployment", name: "web", namespace: "shop" });
    expect(overview.find((r) => r.label === "Node")!.values[0]!.ref).toEqual({ kind: "Node", name: "n1" });

    const text = describeText(doc);
    expect(text).toContain("Pod shop/web-1");
    expect(text).toContain("Controlled by:");
    expect(text).toContain("Deployment web › ReplicaSet web-7d9");
    expect(text).toMatch(/Type\s+Reason\s+Last seen/);
    expect(text).toContain("Readiness probe failed");

    const strings = describeStrings(doc);
    expect(strings[0]).toEqual(["0.t", "Overview"]);
    expect(strings.some(([key, value]) => key.startsWith("3.c0.") && value === "Unhealthy")).toBe(true);
    expect(matchStarts("Ready, ready, READY", "ready")).toEqual([0, 7, 14]);
    expect(matchStarts("abc", "")).toEqual([]);
  });

  test("secrets never show their values; other kinds show their spec", () => {
    const secret = describeObject({ kind: "Secret", metadata: { name: "db" }, data: { password: "c2VjcmV0" } }, { now: NOW });
    const data = secret.sections.find((s) => s.title === "Data")!;
    expect(data.rows![0]!.values[0]!.text).toBe("6 bytes");
    expect(describeText(secret)).not.toContain("c2VjcmV0");

    const widget = describeObject({ kind: "Widget", metadata: { name: "w" }, spec: { size: 3, tags: ["a", "b"], nested: { on: true } }, status: { phase: "Ready" } }, { now: NOW });
    expect(widget.sections.find((s) => s.title === "Spec")!.rows!.map((r) => `${r.label}=${r.values[0]!.text}`)).toEqual([
      "size=3",
      "tags=a, b",
      "nested.on=true",
    ]);
  });
});

describe("init containers", () => {
  test("a running sidecar doesn't hold the pod in Initializing; a running init container does", () => {
    const pod = (restartPolicy?: string) => ({
      spec: { initContainers: [{ name: "proxy", restartPolicy }], containers: [{ name: "api" }] },
      status: {
        phase: restartPolicy ? "Running" : "Pending",
        initContainerStatuses: [{ name: "proxy", state: { running: {} } }],
        containerStatuses: [
          { name: "api", ready: !!restartPolicy, state: restartPolicy ? { running: {} } : { waiting: { reason: "PodInitializing" } } },
        ],
      },
    });
    expect(podState(pod("Always"), NOW).label).toBe("Running");
    expect(podState(pod(), NOW)).toMatchObject({ label: "Initializing", detail: "Running init container proxy (1 of 1)." });
  });
});

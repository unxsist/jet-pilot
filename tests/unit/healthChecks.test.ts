import { describe, expect, test } from "vitest";
import { DAY_MS, dayText, relativeDays } from "@/lib/health/checks/days";
import { RULES, groupRisks, type RiskItem } from "@/lib/health/checks/rules";
import { drainBlockers, drainRisks, floatingImage, mayRunAsRoot, selects, workloadRisks, workloadsOf } from "@/lib/health/checks/workloads";
import { clientCertificateRisk, expiryRisks, expiryTone } from "@/lib/health/checks/expiry";
import { lastChange, unusedRisks } from "@/lib/health/checks/unused";
import { createSessionChecks } from "@/lib/health/checks/session";

const NOW = Date.parse("2026-10-31T12:00:00Z");
const scope = { context: "prod", kubeConfig: "/k" };
const iso = (ms: number) => new Date(ms).toISOString();

const container = (over: any = {}) => ({
  name: "api",
  image: "ghcr.io/acme/api:v1.2.3",
  ports: [{ containerPort: 8080 }],
  resources: { requests: { cpu: "100m", memory: "128Mi" }, limits: { memory: "256Mi" } },
  readinessProbe: { httpGet: { path: "/ready", port: 8080 } },
  livenessProbe: { httpGet: { path: "/live", port: 8080 } },
  securityContext: { runAsNonRoot: true },
  ...over,
});

const deployment = (name: string, replicas: number, spec: any = {}, namespace = "shop") => ({
  metadata: { name, namespace, managedFields: [] as any[] },
  spec: {
    replicas,
    selector: { matchLabels: { app: name } },
    template: { metadata: { labels: { app: name } }, spec: { containers: [container()], ...spec } },
  },
});

const pdb = (app: string, status: any = { disruptionsAllowed: 1, expectedPods: 2 }) => ({
  metadata: { name: app, namespace: "shop" },
  spec: { selector: { matchLabels: { app } } },
  status,
});

const rulesOf = (items: RiskItem[], name?: string) =>
  items.filter((i) => !name || i.object.name === name).map((i) => i.rule).sort();

describe("words", () => {
  test("days", () => {
    expect(dayText(Date.parse("2025-07-15T00:00:00Z"))).toBe("Jul 15, 2025");
    expect(relativeDays(NOW + 12.4 * DAY_MS, NOW)).toBe("in 12 days");
    expect(relativeDays(NOW + 1.9 * DAY_MS, NOW)).toBe("in 2 days");
    expect(relativeDays(NOW + 1 * DAY_MS, NOW)).toBe("in 1 day");
    expect(relativeDays(NOW + 7 * 3_600_000, NOW)).toBe("in 7 hours");
    expect(relativeDays(NOW - 2 * DAY_MS, NOW)).toBe("2 days ago");
  });

  test("every rule reads in plain English, singular and plural", () => {
    for (const rule of RULES) {
      expect(rule.why.endsWith(".")).toBe(true);
      expect(rule.fix.endsWith(".")).toBe(true);
      expect(rule.title(1)).not.toMatch(/\b1 \w+s\b(?! (has|have))/);
    }
    const memory = RULES.find((r) => r.id === "no-memory-limit")!;
    expect(memory.title(1)).toBe("1 workload has no memory limit");
    expect(memory.title(7)).toBe("7 workloads have no memory limit");
    expect(RULES.find((r) => r.id === "certificate-expiry")!.title(2)).toBe("2 certificates need renewing");
  });
});

describe("workload rules", () => {
  test("a well-configured workload has no findings", () => {
    const workloads = workloadsOf({ deployments: [deployment("api", 3)] });
    expect(workloadRisks({ ...scope, production: true, workloads, pods: [], pdbs: [pdb("api")], hpas: [] })).toEqual([]);
  });

  test("each rule fires on its own problem", () => {
    const sidecar = container({ name: "envoy", ports: [], resources: {}, image: "envoyproxy/envoy", securityContext: {} });
    const workloads = workloadsOf({
      deployments: [
        deployment("multi", 2, { containers: [container(), sidecar] }),
        deployment("lonely", 1),
        deployment("probes", 1, { containers: [container({ readinessProbe: undefined, livenessProbe: undefined })] }),
        deployment("host", 1, {
          hostNetwork: true,
          volumes: [{ name: "logs", hostPath: { path: "/var/log" } }, { name: "tmp", emptyDir: {} }],
          containers: [
            container({
              securityContext: { privileged: true, runAsUser: 0, capabilities: { add: ["NET_ADMIN", "CHOWN"] } },
              env: [{ name: "DB_PASSWORD", value: "hunter2" }, { name: "MODE", value: "fast" }, { name: "API_TOKEN", valueFrom: { secretKeyRef: {} } }],
            }),
          ],
        }),
      ],
      cronjobs: [{ metadata: { name: "report", namespace: "shop" }, spec: { jobTemplate: { spec: { template: { spec: { containers: [container({ ports: [], readinessProbe: undefined, image: "busybox:latest" })] } } } } } }],
      daemonsets: [{ metadata: { name: "node-agent", namespace: "kube-system" }, spec: { template: { spec: { hostNetwork: true, containers: [container({ securityContext: { privileged: true } })] } } } }],
    });
    const items = workloadRisks({ ...scope, production: true, workloads, pods: [], pdbs: [], hpas: [] });
    expect(rulesOf(items, "multi")).toEqual(["latest-image", "no-memory-limit", "no-pdb", "no-requests", "root"]);
    expect(items.find((i) => i.object.name === "multi" && i.rule === "no-requests")!.detail).toBe("envoy container");
    expect(items.find((i) => i.object.name === "multi" && i.rule === "latest-image")!.code).toBe("envoyproxy/envoy");
    expect(items.find((i) => i.rule === "no-pdb")!.action).toBe("add-pdb");
    expect(rulesOf(items, "lonely")).toEqual(["single-replica"]);
    expect(rulesOf(items, "probes")).toEqual(["no-liveness", "no-readiness", "single-replica"]);
    expect(rulesOf(items, "host")).toEqual(["capabilities", "empty-dir", "host-namespaces", "host-path", "plain-secrets", "privileged", "root", "single-replica"]);
    expect(items.find((i) => i.rule === "capabilities")!.code).toBe("NET_ADMIN");
    expect(items.find((i) => i.rule === "plain-secrets")!.code).toBe("DB_PASSWORD");
    // Jobs need no probes; kube-system belongs to the platform.
    expect(rulesOf(items, "report")).toEqual(["latest-image"]);
    expect(rulesOf(items, "node-agent")).toEqual([]);
  });

  test("single replicas count in production only; autoscalers raise the floor", () => {
    const workloads = workloadsOf({ deployments: [deployment("api", 1)] });
    expect(rulesOf(workloadRisks({ ...scope, production: false, workloads, pods: [], pdbs: [], hpas: [] }))).toEqual([]);
    const hpa = { metadata: { name: "api", namespace: "shop" }, spec: { scaleTargetRef: { kind: "Deployment", name: "api" }, minReplicas: 2 } };
    expect(rulesOf(workloadRisks({ ...scope, production: true, workloads, pods: [], pdbs: [], hpas: [hpa] }))).toEqual(["no-pdb"]);
  });

  test("autoscalers that can't measure", () => {
    const workloads = workloadsOf({ deployments: [deployment("web", 3, { containers: [container({ resources: { limits: { memory: "1Gi" } } })] })] });
    const hpa = {
      metadata: { name: "web", namespace: "shop" },
      spec: { scaleTargetRef: { kind: "Deployment", name: "web" }, minReplicas: 3, metrics: [{ type: "Resource", resource: { name: "cpu", target: { type: "Utilization", averageUtilization: 70 } } }] },
    };
    const item = workloadRisks({ ...scope, production: false, workloads, pods: [], pdbs: [pdb("web")], hpas: [hpa] }).find((i) => i.rule === "hpa-no-requests")!;
    expect(item.object).toMatchObject({ kind: "HorizontalPodAutoscaler", name: "web" });
    expect(item.detail).toBe("Scales web on CPU");
    const byValue = { ...hpa, spec: { ...hpa.spec, metrics: [{ type: "Resource", resource: { name: "cpu", target: { type: "AverageValue", averageValue: "500m" } } }] } };
    expect(workloadRisks({ ...scope, production: false, workloads, pods: [], pdbs: [pdb("web")], hpas: [byValue] }).some((i) => i.rule === "hpa-no-requests")).toBe(false);
  });

  test("helpers", () => {
    expect(floatingImage("nginx")).toBe(true);
    expect(floatingImage("nginx:latest")).toBe(true);
    expect(floatingImage("localhost:5000/nginx")).toBe(true);
    expect(floatingImage("localhost:5000/nginx:1.27")).toBe(false);
    expect(floatingImage("nginx@sha256:abc")).toBe(false);
    expect(mayRunAsRoot({ securityContext: { runAsNonRoot: true } }, {})).toBe(false);
    expect(mayRunAsRoot({ securityContext: { runAsNonRoot: true } }, { securityContext: { runAsUser: 0 } })).toBe(true);
    expect(mayRunAsRoot({}, { securityContext: { runAsUser: 1000 } })).toBe(false);
    expect(mayRunAsRoot({}, {})).toBe(true);
    expect(selects({ matchLabels: { app: "a" } }, { app: "a", x: "y" })).toBe(true);
    expect(selects({ matchExpressions: [{ key: "tier", operator: "In", values: ["web"] }] }, { tier: "db" })).toBe(false);
    expect(selects({}, { app: "a" })).toBe(true);
    expect(selects(undefined, { app: "a" })).toBe(false);
  });
});

describe("drain safety", () => {
  test("blocking budgets and bare pods", () => {
    const items = drainRisks({
      ...scope,
      pdbs: [pdb("api", { disruptionsAllowed: 0, expectedPods: 2, desiredHealthy: 3, currentHealthy: 2 }), pdb("web"), pdb("idle", { disruptionsAllowed: 0, expectedPods: 0 })],
      pods: [
        { metadata: { name: "debug", namespace: "shop" }, spec: { nodeName: "node-1" }, status: { phase: "Running" } },
        { metadata: { name: "etcd-x", namespace: "kube-system", annotations: { "kubernetes.io/config.mirror": "abc" } }, status: { phase: "Running" } },
        { metadata: { name: "done", namespace: "shop" }, status: { phase: "Succeeded" } },
        { metadata: { name: "owned", namespace: "shop", ownerReferences: [{ kind: "ReplicaSet" }] }, status: { phase: "Running" } },
      ],
    });
    expect(items.map((i) => [i.rule, i.object.name, i.detail])).toEqual([
      ["pdb-blocks", "api", "Needs 3 healthy pods, has 2"],
      ["bare-pods", "debug", "On node-1"],
    ]);
  });
});

describe("drain pre-flight", () => {
  test("names blocking budgets and pods nothing recreates on the node", () => {
    const pod = (name: string, labels: any, owner?: string) => ({
      metadata: { name, namespace: "shop", labels, ...(owner ? { ownerReferences: [{ kind: owner }] } : {}) },
      status: { phase: "Running" },
    });
    const pods = [pod("api-1", { app: "api" }, "ReplicaSet"), pod("agent-x", { app: "agent" }, "DaemonSet"), pod("debug", {})];
    const pdbs = [
      pdb("api", { disruptionsAllowed: 0, expectedPods: 2 }),
      pdb("agent", { disruptionsAllowed: 0, expectedPods: 4 }),
      pdb("other", { disruptionsAllowed: 0, expectedPods: 1 }),
    ];
    expect(drainBlockers(pods, pdbs)).toEqual([
      "The disruption budget api allows no evictions, so the drain waits until it does.",
      "debug has no controller: once evicted, nothing starts it again.",
    ]);
    expect(drainBlockers([pod("a", {}), pod("b", {})], [])).toEqual(["2 pods have no controller: once evicted, nothing starts them again."]);
    expect(drainBlockers([], pdbs)).toEqual([]);
  });
});

describe("expiry", () => {
  const cert = (name: string, notAfter: number, renewal: number | null) => ({
    apiVersion: "cert-manager.io/v1",
    metadata: { name, namespace: "shop" },
    status: { notAfter: iso(notAfter), notBefore: iso(notAfter - 90 * DAY_MS), ...(renewal !== null ? { renewalTime: iso(renewal) } : {}) },
  });
  const tls = (name: string, notAfter: number | null, certificate: string | null = null) => ({
    name,
    namespace: "shop",
    notAfter,
    notBefore: null,
    subject: "shop.acme.dev",
    dnsNames: ["shop.acme.dev"],
    certificate,
    error: null,
  });

  test("tones at 14, 7 and 3 days", () => {
    expect(expiryTone(NOW + 12 * DAY_MS, NOW)).toBe("muted");
    expect(expiryTone(NOW + 6 * DAY_MS, NOW)).toBe("warning");
    expect(expiryTone(NOW + 2 * DAY_MS, NOW)).toBe("destructive");
    expect(expiryTone(NOW - DAY_MS, NOW)).toBe("destructive");
  });

  test("cert-manager certificates only when they aren't renewing; secrets they issue aren't counted twice", () => {
    const items = expiryRisks({
      ...scope,
      now: NOW,
      certificates: [
        cert("overdue", NOW + 5 * DAY_MS, NOW - 25 * DAY_MS),
        cert("expired", NOW - 2 * DAY_MS, NOW - 32 * DAY_MS),
        cert("on-schedule", NOW + 16 * 3_600_000, NOW + 8 * 3_600_000),
        cert("fine", NOW + 60 * DAY_MS, NOW + 30 * DAY_MS),
      ],
      tls: [tls("overdue-tls", NOW + 5 * DAY_MS, "overdue"), tls("manual", NOW + 12 * DAY_MS), tls("later", NOW + 40 * DAY_MS), tls("broken", null)],
    });
    expect(items.map((i) => [i.object.kind, i.object.name, i.detail, i.tone])).toEqual([
      ["Certificate", "overdue", "Expires in 5 days · renewal was due 25 days ago", "warning"],
      ["Certificate", "expired", "Expired 2 days ago", "destructive"],
      ["Secret", "manual", "Expires in 12 days · shop.acme.dev", "muted"],
    ]);
    expect(items[0]!.action).toBe("renew");
    expect(items[2]!.action).toBeUndefined();
  });

  test("the kubeconfig's client certificate", () => {
    expect(clientCertificateRisk({ ...scope, now: NOW, credential: { kind: "clientCert", expiresAt: NOW + 6 * DAY_MS } })).toMatchObject({
      rule: "client-certificate",
      detail: "Expires in 6 days",
      tone: "warning",
    });
    expect(clientCertificateRisk({ ...scope, now: NOW, credential: { kind: "clientCert", expiresAt: NOW + 60 * DAY_MS } })).toBeNull();
    expect(clientCertificateRisk({ ...scope, now: NOW, credential: { kind: "exec", expiresAt: NOW + DAY_MS } })).toBeNull();
    expect(clientCertificateRisk({ ...scope, now: NOW, credential: null })).toBeNull();
  });
});

describe("possibly unused", () => {
  test("idle workloads, empty services, unused claims and volumes", () => {
    const idle = deployment("old-reports", 0);
    idle.metadata.managedFields = [{ manager: "kubectl", time: iso(NOW - 60 * DAY_MS) }];
    const recent = deployment("paused", 0);
    recent.metadata.managedFields = [{ manager: "kubectl", time: iso(NOW - 2 * DAY_MS) }];
    const sts = { metadata: { name: "pg", namespace: "shop" }, spec: { replicas: 1, template: { metadata: { labels: { app: "pg" } }, spec: { containers: [] } } } };
    const items = unusedRisks({
      ...scope,
      now: NOW,
      workloads: workloadsOf({ deployments: [idle, recent], statefulsets: [sts] }),
      pods: [
        { metadata: { name: "pg-0", namespace: "shop", labels: { app: "pg" } }, spec: { volumes: [{ persistentVolumeClaim: { claimName: "data-pg-0" } }] }, status: { phase: "Running" } },
      ],
      services: [
        { metadata: { name: "pg", namespace: "shop" }, spec: { selector: { app: "pg" } } },
        { metadata: { name: "gone", namespace: "shop" }, spec: { selector: { app: "gone" } } },
        { metadata: { name: "external", namespace: "shop" }, spec: { type: "ExternalName" } },
        { metadata: { name: "manual", namespace: "shop" }, spec: {} },
      ],
      claims: [
        { metadata: { name: "data-pg-0", namespace: "shop" }, status: { phase: "Bound", capacity: { storage: "50Gi" } } },
        { metadata: { name: "data-pg-1", namespace: "shop" }, status: { phase: "Bound", capacity: { storage: "50Gi" } } },
        { metadata: { name: "pending", namespace: "shop" }, status: { phase: "Pending" } },
      ],
      volumes: [
        { metadata: { name: "pv-1" }, spec: { capacity: { storage: "20Gi" }, storageClassName: "gp3" }, status: { phase: "Released" } },
        { metadata: { name: "pv-2" }, status: { phase: "Bound" } },
      ],
    });
    expect(items.map((i) => [i.rule, i.object.name, i.detail])).toEqual([
      ["scaled-to-zero", "old-reports", "Unchanged since Sep 1, 2026"],
      ["service-no-pods", "gone", undefined],
      ["unused-claim", "data-pg-1", "50Gi"],
      ["released-volume", "pv-1", "Released by its claim · 20Gi · gp3"],
    ]);
  });

  test("last change falls back to creation", () => {
    expect(lastChange({ metadata: { creationTimestamp: iso(NOW) } })).toBe(NOW);
    expect(lastChange({ metadata: { managedFields: [{ time: iso(NOW - DAY_MS) }, { time: iso(NOW) }] } })).toBe(NOW);
  });
});

describe("grouping", () => {
  test("sections in order, urgent and big rules first", () => {
    const item = (rule: string, name: string, extra: Partial<RiskItem> = {}): RiskItem => ({ rule, ...scope, object: { kind: "Deployment", name }, ...extra });
    const sections = groupRisks([
      item("root", "a"),
      item("no-memory-limit", "a"),
      item("no-memory-limit", "b"),
      item("privileged", "c"),
      item("certificate-expiry", "late", { tone: "muted", order: 3 }),
      item("certificate-expiry", "soon", { tone: "destructive", order: 1 }),
      item("unknown-rule", "x"),
    ]);
    expect(sections.map((s) => s.id)).toEqual(["expiry", "reliability", "security"]);
    expect(sections[0]!.groups[0]!.items.map((i) => i.object.name)).toEqual(["soon", "late"]);
    expect(sections[0]!.groups[0]!.tone).toBe("destructive");
    expect(sections[2]!.groups.map((g) => g.rule.id)).toEqual(["privileged", "root"]);
  });
});

describe("session checks", () => {
  test("runs once at a time and keeps the last result while checking again", async () => {
    const checks = createSessionChecks<number>();
    let calls = 0;
    const task = () => Promise.resolve(++calls);
    const first = checks.run("a", task);
    expect(checks.run("a", task)).toBe(first);
    await first;
    expect(checks.get("a")).toMatchObject({ running: false, result: 1, error: null });
    const again = checks.run("a", () => Promise.reject(new Error("forbidden")));
    expect(checks.get("a")).toMatchObject({ running: true, result: 1 });
    await again;
    expect(checks.get("a")).toMatchObject({ running: false, result: 1, error: "forbidden" });
  });
});

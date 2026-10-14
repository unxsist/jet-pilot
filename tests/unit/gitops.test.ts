import { describe, expect, test } from "vitest";
import {
  argoResources,
  argoSource,
  argoState,
  browsableUrl,
  buildSections,
  compareDeliveries,
  deliveryKindOf,
  detectGitOps,
  fluxResources,
  fluxSource,
  fluxState,
  groupResources,
  healthCheckMessage,
  matchesFilter,
  matchesQuery,
  parseInventoryId,
  pendingSettled,
  readableMessage,
  repoName,
  shortRevision,
  summarize,
  toDelivery,
  type Delivery,
} from "@/lib/gitops/model";
import type { DiscoveredResource } from "@/lib/discovery";

const NOW = Date.parse("2026-10-14T12:00:00Z");
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();

const kustomization = (status: any = {}, spec: any = {}, metadata: any = {}) => ({
  apiVersion: "kustomize.toolkit.fluxcd.io/v1",
  kind: "Kustomization",
  metadata: { name: "apps", namespace: "flux-system", uid: "k1", generation: 2, creationTimestamp: ago(600), context: "prod", ...metadata },
  spec: { path: "./clusters/prod", sourceRef: { kind: "GitRepository", name: "fleet" }, ...spec },
  status: { observedGeneration: 2, ...status },
});

const ready = (status: string, reason: string, message = "", minutes = 5) => ({
  type: "Ready",
  status,
  reason,
  message,
  lastTransitionTime: ago(minutes),
});

const app = (status: any, spec: any = {}, extra: any = {}) => ({
  apiVersion: "argoproj.io/v1alpha1",
  kind: "Application",
  metadata: { name: "web", namespace: "argocd", uid: "a1", creationTimestamp: ago(600), context: "prod" },
  spec: { source: { repoURL: "https://github.com/acme/apps.git", path: "apps/web", targetRevision: "main" }, ...spec },
  status,
  ...extra,
});

describe("fluxState", () => {
  test("Ready True is healthy, with the revision shortened in the message", () => {
    const state = fluxState(
      kustomization({ conditions: [ready("True", "ReconciliationSucceeded", `Applied revision: main@sha1:${"7f3c2a1".padEnd(40, "0")}`)] }),
      NOW
    );
    expect(state).toMatchObject({ category: "healthy", label: "Ready", tone: "success", message: "Applied main@7f3c2a1" });
  });

  test("failure reasons in words", () => {
    const of = (reason: string) => fluxState(kustomization({ conditions: [ready("False", reason, "boom")] }), NOW);
    expect(of("HealthCheckFailed")).toMatchObject({ category: "failing", label: "Unhealthy", tone: "destructive" });
    expect(of("BuildFailed").label).toBe("Build failed");
    expect(of("ArtifactFailed").label).toBe("Source not ready");
    expect(of("UpgradeFailed").label).toBe("Upgrade failed");
    expect(of("ReconciliationFailed").label).toBe("Failed");
    expect(of("SomethingNew").label).toBe("Failed");
  });

  test("waiting on dependencies needs attention, not a failure", () => {
    const state = fluxState(kustomization({ conditions: [ready("False", "DependencyNotReady", "Dependencies do not meet ready condition")] }), NOW);
    expect(state).toMatchObject({ category: "attention", label: "Waiting on dependencies", tone: "warning" });
  });

  test("Stalled wins over Ready", () => {
    const state = fluxState(
      kustomization({
        conditions: [
          { type: "Stalled", status: "True", reason: "RetriesExceeded", message: "Failed to upgrade after 3 attempt(s)", lastTransitionTime: ago(30) },
          ready("False", "UpgradeFailed", "Helm upgrade failed"),
        ],
      }),
      NOW
    );
    expect(state).toMatchObject({
      category: "failing",
      label: "Stalled",
      reason: "RetriesExceeded",
      message: "Failed to upgrade after 3 attempt(s): Helm upgrade failed",
    });
  });

  test("reconciling: Ready Unknown, Reconciling True or a newer generation", () => {
    expect(fluxState(kustomization({ conditions: [ready("Unknown", "Progressing", "Reconciliation in progress")] }), NOW)).toMatchObject({
      category: "progressing",
      label: "Reconciling",
    });
    expect(
      fluxState(
        kustomization({ conditions: [{ type: "Reconciling", status: "True", reason: "Progressing" }, ready("True", "ReconciliationSucceeded")] }),
        NOW
      ).category
    ).toBe("progressing");
    expect(fluxState(kustomization({ observedGeneration: 1, conditions: [ready("True", "ReconciliationSucceeded")] }), NOW).label).toBe(
      "Reconciling"
    );
  });

  test("suspended wins over everything", () => {
    const state = fluxState(kustomization({ conditions: [ready("False", "BuildFailed", "bad")] }, { suspend: true }), NOW);
    expect(state).toMatchObject({ category: "suspended", label: "Suspended", message: "bad" });
  });

  test("no status: pending at first, then a hint at the controller", () => {
    expect(fluxState(kustomization({}, {}, { creationTimestamp: ago(1) }), NOW)).toMatchObject({ category: "progressing", label: "Pending" });
    expect(fluxState(kustomization({}, {}, { creationTimestamp: ago(60) }), NOW)).toMatchObject({ category: "attention", label: "No status" });
  });
});

describe("argoState", () => {
  const synced = { sync: { status: "Synced", revision: "a".repeat(40) }, health: { status: "Healthy" } };

  test("synced and healthy", () => {
    expect(argoState(app(synced), NOW)).toMatchObject({ category: "healthy", label: "Synced", tone: "success" });
  });

  test("out of sync counts the differing resources", () => {
    const state = argoState(
      app({
        ...synced,
        sync: { status: "OutOfSync" },
        resources: [{ kind: "Deployment", name: "web", status: "OutOfSync" }, { kind: "Service", name: "web", status: "Synced" }],
      }),
      NOW
    );
    expect(state).toMatchObject({ category: "attention", label: "Out of sync", message: "1 resource differs from Git." });
  });

  test("degraded, with the message of the unhealthy resource", () => {
    const state = argoState(
      app({
        ...synced,
        health: { status: "Degraded" },
        resources: [{ kind: "Deployment", name: "web", health: { status: "Degraded", message: 'Deployment "web" exceeded its progress deadline' } }],
      }),
      NOW
    );
    expect(state).toMatchObject({ category: "failing", label: "Degraded", message: 'Deployment "web" exceeded its progress deadline' });
  });

  test("a running operation is syncing", () => {
    expect(argoState(app({ ...synced, operationState: { phase: "Running", startedAt: ago(1) } }), NOW)).toMatchObject({
      category: "progressing",
      label: "Syncing",
    });
    expect(argoState(app(synced, {}, { operation: { sync: {} } }), NOW).label).toBe("Syncing");
  });

  test("error conditions fail it", () => {
    const state = argoState(
      app({
        sync: { status: "Unknown" },
        health: { status: "Healthy" },
        conditions: [{ type: "ComparisonError", message: "rpc error: authentication required", lastTransitionTime: ago(3) }],
      }),
      NOW
    );
    expect(state).toMatchObject({ category: "failing", label: "Can't compare", message: "rpc error: authentication required" });
  });

  test("a failed sync: failing while out of sync, a warning once synced", () => {
    const failed = { phase: "Failed", message: "one or more objects failed to apply", finishedAt: ago(2) };
    expect(argoState(app({ ...synced, sync: { status: "OutOfSync" }, operationState: failed }), NOW)).toMatchObject({
      category: "failing",
      label: "Sync failed",
    });
    expect(argoState(app({ ...synced, operationState: failed }), NOW)).toMatchObject({ category: "attention", label: "Last sync failed" });
  });

  test("progressing, missing, suspended and unknown health", () => {
    expect(argoState(app({ ...synced, health: { status: "Progressing" } }), NOW).category).toBe("progressing");
    expect(argoState(app({ sync: { status: "OutOfSync" }, health: { status: "Missing" } }), NOW).label).toBe("Missing");
    expect(argoState(app({ ...synced, health: { status: "Suspended" } }), NOW).category).toBe("suspended");
    expect(argoState(app({ sync: { status: "Unknown" }, health: { status: "Unknown" }, reconciledAt: ago(1) }), NOW).label).toBe("Unknown");
  });
});

describe("sources", () => {
  test("repository names", () => {
    expect(repoName("https://github.com/acme/fleet.git")).toBe("acme/fleet");
    expect(repoName("ssh://git@github.com/acme/edge-config")).toBe("acme/edge-config");
    expect(repoName("git@github.com:acme/fleet.git")).toBe("acme/fleet");
    expect(repoName("ssh://git@gitlab.example.com:2222/group/sub/repo.git")).toBe("sub/repo");
    expect(repoName("oci://ghcr.io/acme/manifests/tenants")).toBe("manifests/tenants");
    expect(repoName("https://charts.jetstack.io")).toBe("charts.jetstack.io");
    expect(repoName("https://prometheus-community.github.io/helm-charts")).toBe("prometheus-community.github.io/helm-charts");
    expect(repoName(undefined)).toBe("");
  });

  test("short revisions", () => {
    const hex = "7f3c2a1b9c0d".padEnd(40, "e");
    expect(shortRevision(`main@sha1:${hex}`)).toBe("main@7f3c2a1");
    expect(shortRevision(`sha1:${hex}`)).toBe("7f3c2a1");
    expect(shortRevision(`refs/heads/main@sha1:${hex}`)).toBe("main@7f3c2a1");
    expect(shortRevision(`main/${hex}`)).toBe("main@7f3c2a1");
    expect(shortRevision(hex)).toBe("7f3c2a1");
    expect(shortRevision(`v1.4.0@sha256:${"ab".repeat(32)}`)).toBe("v1.4.0@abababa");
    expect(shortRevision("6.5.4")).toBe("6.5.4");
  });

  test("browsable repository URLs", () => {
    expect(browsableUrl("https://github.com/acme/fleet.git")).toBe("https://github.com/acme/fleet");
    expect(browsableUrl("ssh://git@github.com/acme/edge-config")).toBe("https://github.com/acme/edge-config");
    expect(browsableUrl("git@github.com:acme/fleet.git")).toBe("https://github.com/acme/fleet");
    expect(browsableUrl("oci://ghcr.io/acme/manifests")).toBeNull();
  });

  test("a Kustomization's source in short form, with its repository's URL", () => {
    const object = kustomization({ lastAppliedRevision: `main@sha1:${"abcdef1".padEnd(40, "0")}` });
    const source = fluxSource(object, (ref) =>
      ref.kind === "GitRepository" && ref.name === "fleet" && ref.namespace === "flux-system"
        ? { kind: "GitRepository", spec: { url: "https://github.com/acme/fleet.git", ref: { branch: "main" } } }
        : undefined
    );
    expect(source).toMatchObject({
      repo: "acme/fleet",
      path: "clusters/prod",
      ref: "main",
      refKind: "Branch",
      revision: "main@abcdef1",
      short: "acme/fleet · clusters/prod · main@abcdef1",
      refs: [{ kind: "GitRepository", name: "fleet", namespace: "flux-system" }],
    });
  });

  test("a HelmRelease: chart@version, repository and its HelmChart", () => {
    const release = {
      apiVersion: "helm.toolkit.fluxcd.io/v2",
      kind: "HelmRelease",
      metadata: { name: "podinfo", namespace: "apps" },
      spec: { chart: { spec: { chart: "podinfo", version: "6.x", sourceRef: { kind: "HelmRepository", name: "podinfo", namespace: "flux-system" } } } },
      status: { history: [{ chartVersion: "6.5.4" }], helmChart: "flux-system/apps-podinfo" },
    };
    expect(fluxSource(release)).toMatchObject({
      chart: "podinfo",
      version: "6.5.4",
      short: "podinfo@6.5.4",
      refs: [
        { kind: "HelmRepository", name: "podinfo", namespace: "flux-system" },
        { kind: "HelmChart", name: "apps-podinfo", namespace: "flux-system" },
      ],
    });
  });

  test("an Argo CD application from Git and from a Helm chart", () => {
    expect(argoSource(app({ sync: { revision: "c559a1a".padEnd(40, "0") } }))).toMatchObject({
      repo: "acme/apps",
      path: "apps/web",
      ref: "main",
      short: "acme/apps · apps/web · c559a1a",
    });
    expect(
      argoSource(app({}, { source: { repoURL: "https://argoproj.github.io/argo-helm", chart: "argo-rollouts", targetRevision: "2.37.7" } }))
    ).toMatchObject({ chart: "argo-rollouts", short: "argo-rollouts@2.37.7" });
  });
});

describe("resources", () => {
  test("inventory ids", () => {
    expect(parseInventoryId("payments_payments-api_apps_Deployment", "v1")).toEqual({
      namespace: "payments",
      name: "payments-api",
      group: "apps",
      kind: "Deployment",
      version: "v1",
    });
    expect(parseInventoryId("payments_web__Service")).toEqual({ namespace: "payments", name: "web", group: "", kind: "Service" });
    expect(parseInventoryId("_payments__Namespace")).toEqual({ namespace: "", name: "payments", group: "", kind: "Namespace" });
    expect(parseInventoryId("_letsencrypt_cert-manager.io_ClusterIssuer")).toMatchObject({ group: "cert-manager.io", kind: "ClusterIssuer" });
    expect(parseInventoryId("broken")).toBeNull();
  });

  test("Flux resources: failed health checks are marked", () => {
    const object = kustomization({
      conditions: [ready("False", "HealthCheckFailed", "Health check failed after 5m0s: timeout waiting for: [Deployment/payments/worker status: 'InProgress']")],
      inventory: {
        entries: [
          { id: "payments_worker_apps_Deployment", v: "v1" },
          { id: "payments_api_apps_Deployment", v: "v1" },
        ],
      },
    });
    const [worker, api] = fluxResources(object);
    expect(worker).toMatchObject({ name: "worker", tone: "destructive", note: "Not ready" });
    expect(api).toMatchObject({ name: "api", tone: "muted" });
  });

  test("Argo CD resources and grouping: problems first", () => {
    const resources = argoResources(
      app({
        resources: [
          { kind: "Service", name: "web", status: "Synced", health: { status: "Healthy" } },
          { kind: "Deployment", name: "web", status: "Synced", health: { status: "Healthy" } },
          { kind: "ConfigMap", name: "flags", status: "OutOfSync" },
          { kind: "ConfigMap", name: "old", status: "OutOfSync", requiresPruning: true },
          { kind: "Deployment", name: "api", status: "Synced", health: { status: "Degraded", message: "deadline" } },
        ],
      })
    );
    expect(resources.find((r) => r.name === "old")).toMatchObject({ note: "Not in Git", tone: "warning" });
    const groups = groupResources(resources);
    expect(groups.map((g) => g.kind)).toEqual(["Deployment", "ConfigMap", "Service"]);
    expect(groups[0]!.items.map((i) => i.name)).toEqual(["api", "web"]);
    expect(groups[0]!.problems).toBe(1);
  });
});

describe("deliveries", () => {
  const delivery = (name: string, conditions: any[], extra: any = {}) =>
    toDelivery(kustomization({ conditions }, extra.spec, { name, uid: name, ...extra.metadata }), undefined, NOW)!;

  const list: Delivery[] = [
    delivery("zeta", [ready("True", "ReconciliationSucceeded")]),
    delivery("paused", [ready("True", "ReconciliationSucceeded")], { spec: { suspend: true } }),
    delivery("busy", [ready("Unknown", "Progressing")]),
    delivery("waiting", [ready("False", "DependencyNotReady")]),
    delivery("broken", [ready("False", "BuildFailed")]),
    delivery("alpha", [ready("True", "ReconciliationSucceeded")]),
    toDelivery(app({ sync: { status: "OutOfSync" }, health: { status: "Healthy" } }), undefined, NOW)!,
  ];

  test("only Flux / Argo CD groups are deliveries", () => {
    expect(deliveryKindOf({ kind: "Application", apiVersion: "argoproj.io/v1alpha1" })).toBe("Application");
    expect(deliveryKindOf({ kind: "Application", apiVersion: "app.k8s.io/v1beta1" })).toBeNull();
    expect(deliveryKindOf({ kind: "HelmRelease", apiVersion: "helm.toolkit.fluxcd.io/v2" })).toBe("HelmRelease");
  });

  test("problems first, then in progress, healthy, suspended; by name within", () => {
    expect([...list].sort(compareDeliveries).map((d) => d.name)).toEqual(["broken", "waiting", "web", "busy", "alpha", "zeta", "paused"]);
  });

  test("sections", () => {
    expect(buildSections(list).map((s) => [s.id, s.deliveries.map((d) => d.name)])).toEqual([
      ["attention", ["broken", "waiting", "web"]],
      ["progressing", ["busy"]],
      ["healthy", ["alpha", "zeta"]],
      ["suspended", ["paused"]],
    ]);
  });

  test("filters and search", () => {
    expect(list.filter((d) => matchesFilter(d, "attention")).map((d) => d.name)).toEqual(["waiting", "broken", "web"]);
    expect(list.filter((d) => matchesFilter(d, "argo")).map((d) => d.name)).toEqual(["web"]);
    expect(list.filter((d) => matchesQuery(d, "out of sync")).map((d) => d.name)).toEqual(["web"]);
    expect(list.filter((d) => matchesQuery(d, "ALPHA prod")).map((d) => d.name)).toEqual(["alpha"]);
  });

  test("the summary line", () => {
    expect(summarize(list)).toBe("7 deliveries · 1 failing · 1 out of sync · 1 waiting");
    expect(summarize(list.filter((d) => d.state.category === "healthy"))).toBe("2 deliveries · all healthy");
    expect(summarize(list.filter((d) => d.name === "busy" || d.name === "paused"))).toBe("2 deliveries · 1 in progress · 1 suspended");
    expect(summarize([list[0]!])).toBe("1 delivery · all healthy");
  });
});

describe("detection", () => {
  const resource = (name: string, kind: string, group: string): DiscoveredResource => ({
    name,
    kind,
    group,
    version: "v1",
    namespaced: true,
    verbs: [],
  });

  test("Flux and Argo CD from discovery", () => {
    const flux = detectGitOps([resource("kustomizations", "Kustomization", "kustomize.toolkit.fluxcd.io"), resource("pods", "Pod", "")]);
    expect(flux.flux).toBe(true);
    expect(flux.argo).toBe(false);
    expect([...flux.served.keys()]).toEqual(["Kustomization"]);
    const argo = detectGitOps([resource("applications", "Application", "argoproj.io"), resource("rollouts", "Rollout", "argoproj.io")]);
    expect(argo).toMatchObject({ flux: false, argo: true });
    expect(detectGitOps([resource("rollouts", "Rollout", "argoproj.io")]).argo).toBe(false);
  });
});

describe("pending actions", () => {
  test("a reconcile is answered by lastHandledReconcileAt", () => {
    const pending = { action: "reconcile" as const, startedAt: NOW, token: "2026-10-14T12:00:00.000Z" };
    expect(pendingSettled(kustomization({ lastHandledReconcileAt: "earlier" }), pending)).toBe(false);
    expect(pendingSettled(kustomization({ lastHandledReconcileAt: pending.token }), pending)).toBe(true);
  });

  test("a sync is answered by a new, finished operation", () => {
    const pending = { action: "sync" as const, startedAt: NOW, previousOperation: ago(60) };
    expect(pendingSettled(app({ operationState: { startedAt: ago(60), phase: "Succeeded" } }), pending)).toBe(false);
    expect(pendingSettled(app({ operationState: { startedAt: ago(0), phase: "Running" } }), pending)).toBe(false);
    expect(pendingSettled(app({ operationState: { startedAt: ago(0), phase: "Succeeded" } }), pending)).toBe(true);
    expect(pendingSettled(app({ operationState: { startedAt: ago(0), phase: "Failed" } }, {}, { operation: {} }), pending)).toBe(false);
  });

  test("a refresh is answered once the annotation is gone from a newer version", () => {
    const pending = { action: "refresh" as const, startedAt: NOW, patchedVersion: "120" };
    const at = (resourceVersion: string, annotations: Record<string, string> = {}) => ({
      ...app({}),
      metadata: { name: "web", resourceVersion, annotations },
    });
    expect(pendingSettled(at("119"), pending)).toBe(false);
    expect(pendingSettled(at("120", { "argocd.argoproj.io/refresh": "normal" }), pending)).toBe(false);
    expect(pendingSettled(at("121"), pending)).toBe(true);
  });
});

describe("healthCheckMessage", () => {
  test("names the objects that aren't healthy", () => {
    expect(
      healthCheckMessage("Health check failed after 5m0s: timeout waiting for: [Deployment/payments/worker status: 'InProgress']")
    ).toBe("Deployment worker isn't ready (waited 5m).");
    expect(
      healthCheckMessage(
        "Health check failed after 2m30s: timeout waiting for: [Deployment/a/web status: 'Failed', StatefulSet/a/db status: 'InProgress']"
      )
    ).toBe("Deployment web failed, StatefulSet db isn't ready (waited 2m30s).");
    expect(healthCheckMessage("something else")).toBe("something else");
  });
});

describe("readableMessage", () => {
  test("trims and shortens digests", () => {
    expect(readableMessage(`  stored artifact for revision 'main@sha1:${"1234567".padEnd(40, "a")}'  `)).toBe(
      "Stored artifact for revision 'main@1234567'"
    );
    expect(readableMessage("   ")).toBeUndefined();
  });
});
